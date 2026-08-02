import { createClient } from "@/lib/supabase/client";
import { canSubmitEntries } from "@/lib/register";
import type { EntryStatus, ParentLinkStatus } from "@/lib/supabase/types";

/** SSC Vol. 1 pricing — cash paid on deck, never online. */
export const RACE_PRICE_EGP = 300;

/** An athlete may enter at most this many individual events per meet. */
export const MAX_EVENTS_PER_MEET = 4;

export const MAX_EVENTS_MESSAGE = `You can enter a maximum of ${MAX_EVENTS_PER_MEET} events per meet.`;

/**
 * Total selected must include events already entered in a previous session
 * of the same meet — the cap is per meet, not per submission, so someone who
 * enters two events today cannot come back and add four more tomorrow.
 */
export function validateEventCount(
  newlySelected: number,
  alreadyEntered = 0,
): { ok: boolean; error?: string } {
  if (newlySelected + alreadyEntered > MAX_EVENTS_PER_MEET) {
    return { ok: false, error: MAX_EVENTS_MESSAGE };
  }
  return { ok: true };
}

export function computeRegistrationTotalEgp(raceCount: number): number {
  return raceCount * RACE_PRICE_EGP;
}

export interface EventSelection {
  eventId: string;
  seedTimeMs: number | null;
  isNt: boolean;
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
  return selections.map((selection) => ({
    event_id: selection.eventId,
    athlete_id: athleteId,
    seed_time_ms: selection.isNt ? null : selection.seedTimeMs,
    is_nt: selection.isNt,
    status: "pending_payment" as const,
  }));
}

export interface RegisterableEvent {
  id: string;
  name: string;
  stroke: string;
  distanceM: number;
  sessionNumber: number;
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
      .select("id, name, stroke, distance_m, session_id, is_skins, is_relay")
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
  approvedByAdmin?: boolean;
  meetVolumeId: string;
  teamId: string | null;
  selections: EventSelection[];
}): Promise<SubmitEntriesResult> {
  const {
    athleteId,
    parentLinkStatus,
    approvedByAdmin,
    meetVolumeId,
    teamId,
    selections,
  } = params;

  const gate = canSubmitEntries({ parentLinkStatus, approvedByAdmin });
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
