import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { LANES_PER_HEAT } from "@/lib/seeding";
import type { MeetSettingsRow, SessionRow } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// The Admin Control Unit's model.
//
// Two tables, deliberately:
//   * public.meet_settings — one row per (volume, SESSION). Money, capacity,
//     heat turnaround, and how many races one swimmer may enter. Per session
//     because a session of 100s does not turn over at a session of 50s' rate,
//     and a Skins session may not be priced like a heats session.
//   * public.sessions      — start and end time. It already owns them and
//     already has the same (meet_volume_id, session_number) key, so keeping a
//     second writable copy in meet_settings would be two sources of truth for
//     one fact.
//
// TWO DIFFERENT ABSENCES, and the difference matters:
//
//   * The QUERY FAILED. Nothing here invents a price. Quoting a swimmer 300
//     EGP because the settings read errored is a wrong number wearing a right
//     number's clothes — see lib/fetch-policy.ts. `error` is propagated and
//     callers render it.
//   * The ROW IS MISSING. That is an unconfigured session, not a failure, and
//     DEFAULT_MEET_SETTINGS below answers it. schema.sql backfills all three
//     rows for every volume, so this is the narrow case of a volume created
//     afterwards by hand.
// ---------------------------------------------------------------------------

export type SessionNumber = 1 | 2 | 3;

export const SESSION_NUMBERS: readonly SessionNumber[] = [1, 2, 3];

export interface MeetSettings {
  meetVolumeId: string;
  sessionNumber: SessionNumber;
  athleteCapacity: number;
  heatTurnaroundSeconds: number;
  individualEventPriceEgp: number;
  relaySwimmerPriceEgp: number;
  athleteEventLimit: number;
}

/**
 * What an unconfigured session is worth.
 *
 * These mirror the column defaults in schema.sql — the database is still the
 * place a default belongs, and these exist so a missing ROW renders a usable
 * form instead of an error. They are NOT a fallback for a failed query; see
 * the note above.
 */
export const DEFAULT_MEET_SETTINGS: Omit<MeetSettings, "meetVolumeId" | "sessionNumber"> = {
  athleteCapacity: 200,
  heatTurnaroundSeconds: 90,
  individualEventPriceEgp: 300,
  relaySwimmerPriceEgp: 300,
  athleteEventLimit: 4,
};

/** The default clock for each session — mirrors public.default_session_window(). */
export const DEFAULT_SESSION_WINDOWS: Record<SessionNumber, { start: string; end: string }> = {
  1: { start: "09:00", end: "13:00" },
  2: { start: "13:30", end: "17:00" },
  3: { start: "17:30", end: "21:00" },
};

export function defaultMeetSettings(
  meetVolumeId: string,
  sessionNumber: SessionNumber,
): MeetSettings {
  return { meetVolumeId, sessionNumber, ...DEFAULT_MEET_SETTINGS };
}

/** The row for one session, or a defaulted one when that session has none. */
export function settingsForSession(
  all: MeetSettings[],
  meetVolumeId: string,
  sessionNumber: SessionNumber,
): MeetSettings {
  return (
    all.find((s) => s.sessionNumber === sessionNumber) ??
    defaultMeetSettings(meetVolumeId, sessionNumber)
  );
}

/** session_number -> individual race price, for pricing a mixed basket. */
export function individualPriceBySession(all: MeetSettings[]): Map<number, number> {
  return new Map(all.map((s) => [s.sessionNumber, s.individualEventPriceEgp]));
}

/**
 * The one price for the whole meet, or null when the sessions disagree.
 *
 * Callers that have no session context (a headline KPI, say) use this and must
 * render "varies by session" rather than picking one — showing session 1's
 * price as if it were the meet's would be a quiet lie on the other two.
 */
export function uniformIndividualPriceEgp(all: MeetSettings[]): number | null {
  if (all.length === 0) return null;
  const first = all[0].individualEventPriceEgp;
  return all.every((s) => s.individualEventPriceEgp === first) ? first : null;
}

/** The strictest event limit across the sessions — the cap a swimmer entering
 * anywhere in the meet is held to. */
export function effectiveEventLimit(all: MeetSettings[]): number {
  if (all.length === 0) return DEFAULT_MEET_SETTINGS.athleteEventLimit;
  return Math.min(...all.map((s) => s.athleteEventLimit));
}

/** When a session runs. Turnaround is not here — it is an admin dial on
 * meet_settings, and pairing the two is computeScheduleCapacity's job. */
export interface SessionSchedule {
  id: string;
  sessionNumber: SessionNumber;
  name: string;
  startTime: string;
  endTime: string;
}

// ---------------------------------------------------------------------------
// Pure readout arithmetic.
//
// Every number the Control Unit shows an admin is derived here so it can be
// unit-tested, and so the formula shown in the UI and the formula computed are
// the same one thing.
// ---------------------------------------------------------------------------

/** "14:30" / "14:30:00" -> seconds since midnight. null if unparseable. */
export function parseTimeOfDaySeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Wall-clock length of a session in seconds.
 *
 * An end time at or before the start is read as crossing midnight rather than
 * as a negative session — a Skins final that runs 22:00 to 00:30 is a real
 * schedule, and reporting it as "-77400 seconds" would put a nonsense heat
 * count in front of the admin instead of a wrong-but-obvious one.
 */
export function sessionDurationSeconds(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): number | null {
  const start = parseTimeOfDaySeconds(startTime);
  const end = parseTimeOfDaySeconds(endTime);
  if (start == null || end == null) return null;
  return end > start ? end - start : end + 86_400 - start;
}

/**
 * How many heats a session can physically run.
 *
 *   maxHeats = floor(sessionSeconds / heatTurnaroundSeconds)
 *
 * heat_turnaround_seconds is the whole wall-clock budget for one heat — the
 * swim plus clearing the water and getting the next field behind the blocks —
 * so the division is against the full session, not against some swim-time
 * fraction of it. floor, because a heat that does not fit does not half-run.
 */
export function maxHeatsPerSession(
  sessionSeconds: number | null,
  heatTurnaroundSeconds: number,
): number {
  if (sessionSeconds == null || sessionSeconds <= 0) return 0;
  if (!Number.isFinite(heatTurnaroundSeconds) || heatTurnaroundSeconds <= 0) return 0;
  return Math.floor(sessionSeconds / heatTurnaroundSeconds);
}

/**
 * How many swims a session can hold.
 *
 *   maxSwims = maxHeats x LANES_PER_HEAT
 *
 * Counted in SWIMS, not swimmers: one athlete entering three races occupies
 * three of these. That is exactly the unit the event-limit ceiling below
 * needs, and it is why this is not called "capacity".
 */
export function maxSwimsPerSession(
  sessionSeconds: number | null,
  heatTurnaroundSeconds: number,
): number {
  return maxHeatsPerSession(sessionSeconds, heatTurnaroundSeconds) * LANES_PER_HEAT;
}

export interface SessionCapacityReadout {
  sessionId: string;
  sessionNumber: number;
  durationSeconds: number | null;
  maxHeats: number;
  maxSwims: number;
}

export interface ScheduleCapacityReadout {
  perSession: SessionCapacityReadout[];
  /** Every swim slot the whole meet can run, summed across sessions. */
  totalSwims: number;
  /**
   * The largest athlete event limit the schedule can absorb if the meet fills
   * to `athleteCapacity`:
   *
   *   ceiling = floor(totalSwims / athleteCapacity)
   *
   * ASSUMPTION, stated plainly because it decides the number: this treats
   * every swimmer as entering the SAME number of races. That is the only
   * assumption a capacity plan can make before entries exist, and it is the
   * conservative one — an actual field where some swimmers enter fewer races
   * leaves room for others to enter more.
   *
   * 0 means the schedule cannot even give every swimmer one race.
   */
  computedEventLimitCeiling: number;
}

/**
 * Pairs each session's clock (public.sessions) with its dials
 * (public.meet_settings) to produce the Control Unit's readouts.
 *
 * `athleteCapacity` for the ceiling is the LARGEST of the per-session
 * capacities: the meet must be able to hold the biggest field any one session
 * admits, and averaging them would quietly promise room that the busiest
 * session does not have.
 */
export function computeScheduleCapacity(
  sessions: SessionSchedule[],
  settings: MeetSettings[],
): ScheduleCapacityReadout {
  const perSession = sessions.map((session): SessionCapacityReadout => {
    const dials =
      settings.find((s) => s.sessionNumber === session.sessionNumber) ?? {
        ...DEFAULT_MEET_SETTINGS,
        meetVolumeId: "",
        sessionNumber: session.sessionNumber,
      };
    const durationSeconds = sessionDurationSeconds(session.startTime, session.endTime);
    return {
      sessionId: session.id,
      sessionNumber: session.sessionNumber,
      durationSeconds,
      maxHeats: maxHeatsPerSession(durationSeconds, dials.heatTurnaroundSeconds),
      maxSwims: maxSwimsPerSession(durationSeconds, dials.heatTurnaroundSeconds),
    };
  });

  const totalSwims = perSession.reduce((sum, s) => sum + s.maxSwims, 0);
  const athleteCapacity = settings.length
    ? Math.max(...settings.map((s) => s.athleteCapacity))
    : DEFAULT_MEET_SETTINGS.athleteCapacity;
  const computedEventLimitCeiling =
    athleteCapacity > 0 ? Math.floor(totalSwims / athleteCapacity) : 0;

  return { perSession, totalSwims, computedEventLimitCeiling };
}

/** How many swims a full field at the admin's chosen limit would demand. */
export function requiredSwims(athleteCapacity: number, athleteEventLimit: number): number {
  return Math.max(0, athleteCapacity) * Math.max(0, athleteEventLimit);
}

/**
 * Whether the admin's chosen event limit exceeds what the schedule can run.
 *
 * The user's decision, and the reason this returns a warning rather than a
 * clamp: the Control Unit computes the ceiling, the admin picks the limit.
 * An admin who knows the field will not all enter four races is right, and a
 * hard cap would just be wrong at them.
 */
export function eventLimitExceedsSchedule(
  capacity: ScheduleCapacityReadout,
  athleteCapacity: number,
  athleteEventLimit: number,
): boolean {
  return requiredSwims(athleteCapacity, athleteEventLimit) > capacity.totalSwims;
}

/** "9:00 AM – 12:00 PM (3h 0m)" style duration text for the readout. */
export function formatDurationSeconds(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// Data access.
// ---------------------------------------------------------------------------

function toMeetSettings(row: MeetSettingsRow): MeetSettings {
  return {
    meetVolumeId: row.meet_volume_id,
    sessionNumber: row.session_number,
    athleteCapacity: row.athlete_capacity,
    heatTurnaroundSeconds: row.heat_turnaround_seconds,
    individualEventPriceEgp: row.individual_event_price_egp,
    relaySwimmerPriceEgp: row.relay_swimmer_price_egp,
    athleteEventLimit: row.athlete_event_limit,
  };
}

/**
 * All three sessions' Control Unit rows for one volume, ordered 1..3.
 *
 * An empty array with no error means the volume has no settings at all —
 * unconfigured, not broken, so callers fill in with DEFAULT_MEET_SETTINGS. A
 * non-null `error` is different and must be surfaced: it means the price on
 * screen would be a guess.
 */
export async function fetchMeetSettings(
  meetVolumeId: string,
): Promise<FetchResult<MeetSettings[]>> {
  if (!meetVolumeId || meetVolumeId.startsWith("demo-")) {
    return { data: [], error: null, usedFallback: true };
  }

  const result = await runQuery<MeetSettingsRow[]>(
    "Loading meet settings",
    async () => {
      const supabase = createClient();
      return supabase
        .from("meet_settings")
        .select("*")
        .eq("meet_volume_id", meetVolumeId)
        .order("session_number", { ascending: true });
    },
    { empty: [] },
  );

  return { ...result, data: result.data.map(toMeetSettings) };
}

/** All three rows, with any missing session filled in from the defaults —
 * what the Control Unit's three tabs bind to. */
export async function fetchMeetSettingsForEditing(
  meetVolumeId: string,
): Promise<FetchResult<MeetSettings[]>> {
  const result = await fetchMeetSettings(meetVolumeId);
  if (result.error) return result;
  return {
    ...result,
    data: SESSION_NUMBERS.map((n) => settingsForSession(result.data, meetVolumeId, n)),
  };
}

export async function fetchSessionSchedules(
  meetVolumeId: string,
): Promise<FetchResult<SessionSchedule[]>> {
  const result = await runQuery<SessionRow[]>(
    "Loading session times",
    async () => {
      const supabase = createClient();
      return supabase
        .from("sessions")
        .select("*")
        .eq("meet_volume_id", meetVolumeId)
        .order("session_number", { ascending: true });
    },
    { empty: [] },
  );

  return {
    ...result,
    data: result.data.map((row) => ({
      id: row.id,
      sessionNumber: row.session_number,
      name: row.name,
      // Postgres `time` comes back as "09:00:00"; the <input type="time">
      // the Control Unit uses wants "09:00".
      startTime: row.start_time.slice(0, 5),
      endTime: row.end_time.slice(0, 5),
    })),
  };
}

export async function saveMeetSettings(
  settings: MeetSettings,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("meet_settings").upsert(
    {
      meet_volume_id: settings.meetVolumeId,
      session_number: settings.sessionNumber,
      athlete_capacity: settings.athleteCapacity,
      heat_turnaround_seconds: settings.heatTurnaroundSeconds,
      individual_event_price_egp: settings.individualEventPriceEgp,
      relay_swimmer_price_egp: settings.relaySwimmerPriceEgp,
      athlete_event_limit: settings.athleteEventLimit,
    },
    // The composite key, so an unconfigured session INSERTs and a configured
    // one UPDATEs. Conflicting on the surrogate id instead would insert a
    // duplicate row for the same session and trip the unique constraint.
    { onConflict: "meet_volume_id,session_number" },
  );
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function saveSessionSchedule(
  session: SessionSchedule,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("sessions")
    .update({ start_time: session.startTime, end_time: session.endTime })
    .eq("id", session.id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
