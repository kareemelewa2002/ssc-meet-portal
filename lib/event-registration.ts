import { createClient } from "@/lib/supabase/client";
import { canSubmitEntries } from "@/lib/register";
import type { EntryStatus, ParentLinkStatus } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// PRICING AND THE EVENT CAP COME FROM public.meet_settings.
//
// This file used to export `RACE_PRICE_EGP = 300` and `MAX_EVENTS_PER_MEET =
// 4`, and eight call sites multiplied by the first or compared against the
// second. Both are now per-volume admin settings edited in
// /admin/control-unit, and both survive as DATABASE column defaults — not as
// constants here.
//
// There is deliberately no fallback price in this module. A client that
// cannot read meet_settings must say so; quoting a swimmer 300 EGP because
// the settings query failed is a wrong number wearing a right number's
// clothes, which is precisely the failure lib/fetch-policy.ts exists to stop.
// ---------------------------------------------------------------------------

export function maxEventsMessage(limit: number): string {
  return `You can enter a maximum of ${limit} ${limit === 1 ? "event" : "events"} per meet.`;
}

/**
 * Total selected must include events already entered in a previous session
 * of the same meet — the cap is per meet, not per submission, so someone who
 * enters two events today cannot come back and add four more tomorrow.
 *
 * `limit` is meet_settings.athlete_event_limit. It is required, with no
 * default, so a caller that has not loaded the settings cannot accidentally
 * enforce a stale 4.
 */
export function validateEventCount(
  newlySelected: number,
  alreadyEntered: number,
  limit: number,
): { ok: boolean; error?: string } {
  if (newlySelected + alreadyEntered > limit) {
    return { ok: false, error: maxEventsMessage(limit) };
  }
  return { ok: true };
}

/** `priceEgp` is meet_settings.individual_event_price_egp — never a constant. */
export function computeRegistrationTotalEgp(raceCount: number, priceEgp: number): number {
  return raceCount * priceEgp;
}

export interface EventSelection {
  eventId: string;
  seedTimeMs: number | null;
  isNt: boolean;
  /** True for the 50m stroke-switch events, which have no comparable time
   * anywhere else and are always entered NT. */
  seedsAsNt?: boolean;
}

export interface EntryInsertPayload {
  event_id: string;
  athlete_id: string;
  seed_time_ms: number | null;
  is_nt: boolean;
  status: EntryStatus;
}

/**
 * Pure builder for meet-event entry rows — deliberately separate from
 * lib/register.ts's account-creation payload (see
 * lib/__tests__/register.test.ts for the assertion that the two share no
 * keys). This never touches auth/profile fields; it only ever runs against
 * an athlete_id for an ALREADY-existing account.
 */
export function buildEntryInserts(
  athleteId: string,
  selections: EventSelection[],
): EntryInsertPayload[] {
  return selections.map((selection) => {
    // A switch event is NT by definition. public.force_nt_for_switch_events()
    // enforces this at the database too — this mirror exists so the payload
    // the UI shows and the row that lands are the same thing, not so the rule
    // is enforced here.
    const isNt = selection.seedsAsNt === true || selection.isNt;
    return {
      event_id: selection.eventId,
      athlete_id: athleteId,
      seed_time_ms: isNt ? null : selection.seedTimeMs,
      is_nt: isNt,
      status: "pending_payment" as const,
    };
  });
}

export interface RegisterableEvent {
  id: string;
  name: string;
  stroke: string;
  distanceM: number;
  sessionNumber: number;
  /** Entered NT always — no seed time is asked for or accepted. */
  seedsAsNt: boolean;
}

/** What the swimmer's seed time for one event will be, and why.
 *
 * From volume 2 the seed time is not a claim the swimmer makes, so the form
 * shows what the database is going to use rather than an input box:
 *   - "declared"   volume 1 only, the swimmer types their own time
 *   - "historical" their best official time for that stroke/distance
 *   - "nt"         either an event with no declarable time (switch, 100 IM)
 *                  or, from volume 2, an event they have never swum
 */
export type SeedSource = "declared" | "historical" | "nt";

export interface ResolvedSeed {
  source: SeedSource;
  seedTimeMs: number | null;
}

/** Mirrors public.apply_historical_seed_time() / force_nt_for_switch_events().
 * Display only — the database decides what is actually stored. */
export function resolveSeedSource(
  event: Pick<RegisterableEvent, "seedsAsNt">,
  volumeNumber: number,
  previousBestMs: number | null | undefined,
): ResolvedSeed {
  if (event.seedsAsNt) return { source: "nt", seedTimeMs: null };
  if (volumeNumber <= 1) return { source: "declared", seedTimeMs: null };
  if (previousBestMs == null) return { source: "nt", seedTimeMs: null };
  return { source: "historical", seedTimeMs: previousBestMs };
}

/** Best previous official time per event for one athlete, keyed by event id.
 * Empty for volume 1, where there is no history to look up. */
export async function fetchPreviousBestTimes(
  athleteId: string,
  eventIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!athleteId || eventIds.length === 0) return out;
  try {
    const supabase = createClient();
    const results = await Promise.all(
      eventIds.map(async (eventId) => {
        const { data } = await supabase.rpc("best_previous_official_time", {
          p_athlete_id: athleteId,
          p_event_id: eventId,
        });
        return [eventId, data as number | null] as const;
      }),
    );
    for (const [eventId, ms] of results) {
      if (typeof ms === "number") out.set(eventId, ms);
    }
  } catch {
    // A failed lookup must not block registration — the database applies the
    // same rule on insert regardless of what the form managed to display.
  }
  return out;
}

/** Skins events are excluded — public.enforce_no_direct_skins_entry blocks
 * non-admin inserts into them entirely; slots are assigned automatically
 * from official results (see lib/skins-qualification.ts), never self-entered.
 * Relay events are excluded too — there is no relay-team-of-4 entry model;
 * they're scheduled/displayed like any other event but never self-entered
 * by an individual athlete (see events.is_relay in supabase/schema.sql). */
export async function fetchRegisterableEvents(meetVolumeId: string): Promise<RegisterableEvent[]> {
  try {
    const supabase = createClient();
    const { data: sessions } = await supabase
      .from("sessions")
      .select("id, session_number")
      .eq("meet_volume_id", meetVolumeId);
    if (!sessions?.length) return [];

    const sessionNumberById = new Map(sessions.map((s) => [s.id, s.session_number]));
    const { data: events, error } = await supabase
      .from("events")
      .select("id, name, stroke, distance_m, session_id, is_skins, is_relay, seeds_as_nt")
      .in("session_id", sessions.map((s) => s.id))
      .eq("is_skins", false)
      .eq("is_relay", false)
      .order("event_order", { ascending: true });
    if (error || !events) return [];

    return events.map((e) => ({
      id: e.id,
      name: e.name,
      stroke: e.stroke,
      distanceM: e.distance_m,
      sessionNumber: sessionNumberById.get(e.session_id) ?? 0,
      seedsAsNt: e.seeds_as_nt ?? false,
    }));
  } catch {
    return [];
  }
}

/** Which of this volume's registerable events the athlete has already
 * entered — the register page uses this to lock those out instead of
 * letting a resubmission hit entries' unique(event_id, athlete_id)
 * constraint as a raw 409. */
export async function fetchAthleteEnteredEventIds(
  athleteId: string,
  eventIds: string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("entries")
      .select("event_id")
      .eq("athlete_id", athleteId)
      .in("event_id", eventIds);
    if (error || !data) return new Set();
    return new Set(data.map((row) => row.event_id));
  } catch {
    return new Set();
  }
}

export interface SubmitEntriesResult {
  success: boolean;
  error?: string;
  entryIds?: string[];
}

/**
 * Submits meet-event registration for a volume: validates parent linkage,
 * upserts the athlete's team representation for that volume (Feature 2's
 * volume_team_affiliations), then writes the pending_payment entries.
 */
export async function submitEventRegistration(params: {
  athleteId: string;
  parentLinkStatus: ParentLinkStatus;
  safetyAcceptedAt?: string | null;
  meetVolumeId: string;
  teamId: string | null;
  selections: EventSelection[];
}): Promise<SubmitEntriesResult> {
  const {
    athleteId,
    parentLinkStatus,
    safetyAcceptedAt,
    meetVolumeId,
    teamId,
    selections,
  } = params;

  const gate = canSubmitEntries({ parentLinkStatus, safetyAcceptedAt });
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  if (selections.length === 0) {
    return { success: false, error: "Select at least one event to enter." };
  }

  const supabase = createClient();

  const { error: affiliationError } = await supabase
    .from("volume_team_affiliations")
    .upsert(
      { athlete_id: athleteId, meet_volume_id: meetVolumeId, team_id: teamId },
      { onConflict: "athlete_id,meet_volume_id" },
    );
  if (affiliationError) {
    return { success: false, error: affiliationError.message };
  }

  const payload = buildEntryInserts(athleteId, selections);
  const { data, error } = await supabase.from("entries").insert(payload).select("id");
  if (error) {
    // 23505 = unique_violation on entries(event_id, athlete_id) — normally
    // pre-empted by fetchAthleteEnteredEventIds locking the UI, but a
    // concurrent tab/session can still race past that check.
    if (error.code === "23505") {
      return {
        success: false,
        error: "You've already entered one or more of these events. Refresh the page to see your current entries.",
      };
    }
    return { success: false, error: error.message };
  }

  return { success: true, entryIds: (data ?? []).map((row) => row.id) };
}
