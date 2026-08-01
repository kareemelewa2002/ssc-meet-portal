import { createClient } from "@/lib/supabase/client";
import { canSubmitEntries } from "@/lib/register";
import type { EntryStatus, ParentLinkStatus } from "@/lib/supabase/types";

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
 * from official results (see lib/skins-qualification.ts), never self-entered. */
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
      .select("id, name, stroke, distance_m, session_id, is_skins")
      .in("session_id", sessions.map((s) => s.id))
      .eq("is_skins", false)
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
  meetVolumeId: string;
  teamId: string | null;
  selections: EventSelection[];
}): Promise<SubmitEntriesResult> {
  const { athleteId, parentLinkStatus, meetVolumeId, teamId, selections } = params;

  const parentCheck = canSubmitEntries({ parentLinkStatus });
  if (!parentCheck.ok) {
    return { success: false, error: parentCheck.error };
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
    return { success: false, error: error.message };
  }

  return { success: true, entryIds: (data ?? []).map((row) => row.id) };
}
