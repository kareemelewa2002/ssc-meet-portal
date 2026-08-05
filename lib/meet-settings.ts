import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { LANES_PER_HEAT } from "@/lib/seeding";
import type { MeetSettingsRow, SessionRow } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// The Admin Control Unit's model.
//
// public.meet_settings is ONE ROW PER VOLUME. It was briefly one row per
// session; pricing moved to packages counted across the whole meet, and a
// cross-session basket cannot be assembled from per-session unit prices, so
// the per-session shape had nothing left to hold.
//
// What lives elsewhere, and why:
//   * public.sessions          — start and end time. It already owns them, so
//                                a second writable copy here would be two
//                                sources of truth for one fact.
//   * public.events            — turnaround, surcharge and capacity, PER RACE.
//                                A 50m sprint clears the pool far faster than
//                                a 400 IM; one number averaged across them is
//                                wrong in both directions at once.
//   * public.pricing_packages  — the 4x3 matrix (see lib/pricing.ts).
//   * public.pricing_tiers     — when each phase is in force.
//
// TWO DIFFERENT ABSENCES, and the difference matters:
//
//   * The QUERY FAILED. Nothing here invents a number. Quoting a swimmer a
//     price because the settings read errored is a wrong number wearing a
//     right number's clothes — see lib/fetch-policy.ts. `error` is propagated
//     and callers render it.
//   * The ROW IS MISSING. That is an unconfigured volume, not a failure, and
//     DEFAULT_MEET_SETTINGS answers it. schema.sql backfills a row for every
//     volume, so this is the narrow case of a volume created afterwards by
//     hand.
// ---------------------------------------------------------------------------

export type SessionNumber = 1 | 2 | 3;

export const SESSION_NUMBERS: readonly SessionNumber[] = [1, 2, 3];

export type PricingTier = "early_bird" | "standard" | "late";

export const PRICING_TIERS: readonly PricingTier[] = ["early_bird", "standard", "late"];

export const PRICING_TIER_LABELS: Record<PricingTier, string> = {
  early_bird: "Early Bird",
  standard: "Standard",
  late: "Late",
};

export interface MeetSettings {
  meetVolumeId: string;

  // Capacity and schedule
  athleteCapacity: number;
  laneCount: number;
  interSessionBreakMinutes: number;
  athleteEventLimit: number;

  // Registration window
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  lateRegistrationEnabled: boolean;

  // Holds, signalling and the waitlist
  holdWindowHours: number;
  waitlistClaimHours: number;
  sellingOutThresholdPercent: number;
  defaultEventCapacity: number;

  // Pricing
  relaySwimmerPriceEgp: number;
  /** null = decide the tier by date; a value = an admin is holding a tier open. */
  pinnedPricingTier: PricingTier | null;

  // Refunds
  refundPercent: number;
  refundDeadlineDays: number | null;
  refundPolicyNote: string | null;
}

/**
 * What an unconfigured volume is worth.
 *
 * These mirror the column defaults in schema.sql — the database is still the
 * place a default belongs, and these exist so a missing ROW renders a usable
 * form instead of an error. They are NOT a fallback for a failed query.
 */
export const DEFAULT_MEET_SETTINGS: Omit<MeetSettings, "meetVolumeId"> = {
  athleteCapacity: 200,
  laneCount: 8,
  interSessionBreakMinutes: 30,
  athleteEventLimit: 4,
  registrationOpensAt: null,
  registrationClosesAt: null,
  lateRegistrationEnabled: false,
  holdWindowHours: 48,
  waitlistClaimHours: 24,
  sellingOutThresholdPercent: 20,
  defaultEventCapacity: 64,
  relaySwimmerPriceEgp: 300,
  pinnedPricingTier: null,
  refundPercent: 0,
  refundDeadlineDays: null,
  refundPolicyNote: null,
};

/** The default clock for each session — mirrors public.default_session_window(). */
export const DEFAULT_SESSION_WINDOWS: Record<SessionNumber, { start: string; end: string }> = {
  1: { start: "09:00", end: "13:00" },
  2: { start: "13:30", end: "17:00" },
  3: { start: "17:30", end: "21:00" },
};

export function defaultMeetSettings(meetVolumeId: string): MeetSettings {
  return { meetVolumeId, ...DEFAULT_MEET_SETTINGS };
}

/** When a session runs. */
export interface SessionSchedule {
  id: string;
  sessionNumber: SessionNumber;
  name: string;
  startTime: string;
  endTime: string;
}

/** A race as the capacity arithmetic sees it. */
export interface ScheduledEvent {
  id: string;
  sessionId: string;
  name: string;
  distanceM: number;
  stroke: string;
  isRelay: boolean;
  eventOrder: number;
  turnaroundSeconds: number;
  surchargeEgp: number;
  capacityCap: number;
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
 * The turnaround shape of the races actually scheduled in a session.
 *
 * This exists because turnaround stopped being one number. A session holding a
 * 50 Free (45s) and a 400 IM (150s) has no single turnaround, and the mean is
 * the only defensible figure to divide a session by before entries exist —
 * but the admin needs the spread too, because a mean of 90s hides whether that
 * is twenty even races or a sprint session with one distance event bolted on.
 */
export interface TurnaroundProfile {
  eventCount: number;
  meanTurnaroundSeconds: number;
  minTurnaroundSeconds: number;
  maxTurnaroundSeconds: number;
  /** Σ turnaround across every race in the session — one heat of each. */
  singlePassSeconds: number;
}

export function turnaroundProfile(events: ScheduledEvent[]): TurnaroundProfile {
  if (events.length === 0) {
    return {
      eventCount: 0,
      meanTurnaroundSeconds: 0,
      minTurnaroundSeconds: 0,
      maxTurnaroundSeconds: 0,
      singlePassSeconds: 0,
    };
  }
  const values = events.map((e) => e.turnaroundSeconds);
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    eventCount: events.length,
    meanTurnaroundSeconds: Math.round(total / events.length),
    minTurnaroundSeconds: Math.min(...values),
    maxTurnaroundSeconds: Math.max(...values),
    singlePassSeconds: total,
  };
}

/**
 * How many heats a session can physically run.
 *
 *   maxHeats = floor(sessionSeconds / meanTurnaroundSeconds)
 *
 * Turnaround is the whole wall-clock budget for one heat — the swim plus
 * clearing the water and getting the next field behind the blocks — so the
 * division is against the full session, not some swim-time fraction of it.
 * floor, because a heat that does not fit does not half-run.
 */
export function maxHeatsPerSession(
  sessionSeconds: number | null,
  meanTurnaroundSeconds: number,
): number {
  if (sessionSeconds == null || sessionSeconds <= 0) return 0;
  if (!Number.isFinite(meanTurnaroundSeconds) || meanTurnaroundSeconds <= 0) return 0;
  return Math.floor(sessionSeconds / meanTurnaroundSeconds);
}

/**
 * How many swims a session can hold.
 *
 * Counted in SWIMS, not swimmers: one athlete entering three races occupies
 * three of these. That is exactly the unit the event-limit ceiling needs, and
 * it is why this is not called "capacity".
 */
export function maxSwimsPerSession(
  sessionSeconds: number | null,
  meanTurnaroundSeconds: number,
  laneCount: number = LANES_PER_HEAT,
): number {
  return maxHeatsPerSession(sessionSeconds, meanTurnaroundSeconds) * Math.max(1, laneCount);
}

/**
 * Exact wall-clock estimate once heat counts are known.
 *
 *   Σ over races of (heats for that race x that race's own turnaround)
 *
 * This is the figure the requirement asked for: it aggregates the variable
 * turnarounds of the specific races scheduled, rather than multiplying a heat
 * count by one global number. Races with no heats yet contribute nothing.
 */
export function estimatedSessionSeconds(
  events: ScheduledEvent[],
  heatsByEventId: ReadonlyMap<string, number>,
): number {
  return events.reduce(
    (sum, e) => sum + (heatsByEventId.get(e.id) ?? 0) * e.turnaroundSeconds,
    0,
  );
}

export interface SessionCapacityReadout {
  sessionId: string;
  sessionNumber: number;
  durationSeconds: number | null;
  profile: TurnaroundProfile;
  maxHeats: number;
  maxSwims: number;
  /** Σ (heats x per-race turnaround), or null when nothing is seeded yet. */
  estimatedSeconds: number | null;
  /** True when the estimate above overruns the session's own clock. */
  overrunsClock: boolean;
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

export function computeScheduleCapacity(
  sessions: SessionSchedule[],
  settings: MeetSettings,
  events: ScheduledEvent[],
  heatsByEventId: ReadonlyMap<string, number> = new Map(),
): ScheduleCapacityReadout {
  const perSession = sessions.map((session): SessionCapacityReadout => {
    const sessionEvents = events.filter((e) => e.sessionId === session.id);
    const profile = turnaroundProfile(sessionEvents);
    const durationSeconds = sessionDurationSeconds(session.startTime, session.endTime);

    const seeded = sessionEvents.some((e) => (heatsByEventId.get(e.id) ?? 0) > 0);
    const estimatedSeconds = seeded
      ? estimatedSessionSeconds(sessionEvents, heatsByEventId)
      : null;

    return {
      sessionId: session.id,
      sessionNumber: session.sessionNumber,
      durationSeconds,
      profile,
      maxHeats: maxHeatsPerSession(durationSeconds, profile.meanTurnaroundSeconds),
      maxSwims: maxSwimsPerSession(
        durationSeconds,
        profile.meanTurnaroundSeconds,
        settings.laneCount,
      ),
      estimatedSeconds,
      overrunsClock:
        estimatedSeconds != null &&
        durationSeconds != null &&
        estimatedSeconds > durationSeconds,
    };
  });

  const totalSwims = perSession.reduce((sum, s) => sum + s.maxSwims, 0);
  const computedEventLimitCeiling =
    settings.athleteCapacity > 0 ? Math.floor(totalSwims / settings.athleteCapacity) : 0;

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
 * clamp: the Control Unit computes the ceiling, the admin picks the limit. An
 * admin who knows the field will not all enter four races is right, and a hard
 * cap would just be wrong at them.
 */
export function eventLimitExceedsSchedule(
  capacity: ScheduleCapacityReadout,
  athleteCapacity: number,
  athleteEventLimit: number,
): boolean {
  return requiredSwims(athleteCapacity, athleteEventLimit) > capacity.totalSwims;
}

/** "3h 0m" style duration text for the readout. */
export function formatDurationSeconds(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * Whether registration is open right now, and why not when it is not.
 *
 * Returns a reason rather than a bare boolean so the UI can tell a swimmer
 * "registration opens on the 12th" instead of hiding the form with no
 * explanation. `lateRegistrationEnabled` reopens a closed window without
 * moving the published deadline, which athletes may have screenshotted.
 */
export function registrationState(
  settings: MeetSettings,
  now: Date = new Date(),
): { open: boolean; reason: string | null } {
  const opens = settings.registrationOpensAt ? new Date(settings.registrationOpensAt) : null;
  const closes = settings.registrationClosesAt ? new Date(settings.registrationClosesAt) : null;

  if (opens && now < opens) {
    return { open: false, reason: `Registration opens ${opens.toLocaleString()}.` };
  }
  if (closes && now >= closes) {
    if (settings.lateRegistrationEnabled) {
      return { open: true, reason: "Late registration is open." };
    }
    return { open: false, reason: `Registration closed ${closes.toLocaleString()}.` };
  }
  return { open: true, reason: null };
}

// ---------------------------------------------------------------------------
// Data access.
// ---------------------------------------------------------------------------

function toMeetSettings(row: MeetSettingsRow): MeetSettings {
  return {
    meetVolumeId: row.meet_volume_id,
    athleteCapacity: row.athlete_capacity,
    laneCount: row.lane_count,
    interSessionBreakMinutes: row.inter_session_break_minutes,
    athleteEventLimit: row.athlete_event_limit,
    registrationOpensAt: row.registration_opens_at,
    registrationClosesAt: row.registration_closes_at,
    lateRegistrationEnabled: row.late_registration_enabled,
    holdWindowHours: row.hold_window_hours,
    waitlistClaimHours: row.waitlist_claim_hours,
    sellingOutThresholdPercent: row.selling_out_threshold_percent,
    defaultEventCapacity: row.default_event_capacity,
    relaySwimmerPriceEgp: row.relay_swimmer_price_egp,
    pinnedPricingTier: row.pinned_pricing_tier,
    refundPercent: row.refund_percent,
    refundDeadlineDays: row.refund_deadline_days,
    refundPolicyNote: row.refund_policy_note,
  };
}

/**
 * The Control Unit row for one volume.
 *
 * `data: null` with no error means the volume has no settings row —
 * unconfigured, not broken. A non-null `error` is different and must be
 * surfaced: it means any number on screen would be a guess.
 */
export async function fetchMeetSettings(
  meetVolumeId: string,
): Promise<FetchResult<MeetSettings | null>> {
  if (!meetVolumeId || meetVolumeId.startsWith("demo-")) {
    return { data: null, error: null, usedFallback: true };
  }

  const result = await runQuery<MeetSettingsRow[]>(
    "Loading meet settings",
    async () => {
      const supabase = createClient();
      return supabase.from("meet_settings").select("*").eq("meet_volume_id", meetVolumeId);
    },
    { empty: [] },
  );

  return { ...result, data: result.data.length ? toMeetSettings(result.data[0]) : null };
}

/** The row, or a defaulted one — what the Control Unit form binds to. */
export async function fetchMeetSettingsForEditing(
  meetVolumeId: string,
): Promise<FetchResult<MeetSettings>> {
  const result = await fetchMeetSettings(meetVolumeId);
  return { ...result, data: result.data ?? defaultMeetSettings(meetVolumeId) };
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

/**
 * Every race in a volume, with its own turnaround, surcharge and cap.
 *
 * Two queries rather than one embedded `sessions!inner` filter: the embed
 * defeats supabase-js's type inference and the result has to be cast, which
 * would silently swallow a column rename. Fetching the volume's session ids
 * first keeps both queries fully typed.
 */
export async function fetchScheduledEvents(
  meetVolumeId: string,
): Promise<FetchResult<ScheduledEvent[]>> {
  const sessions = await runQuery<{ id: string }[]>(
    "Loading sessions for event schedule",
    async () => {
      const supabase = createClient();
      return supabase.from("sessions").select("id").eq("meet_volume_id", meetVolumeId);
    },
    { empty: [] },
  );

  if (sessions.error) return { ...sessions, data: [] };
  if (sessions.data.length === 0) return { data: [], error: null, usedFallback: false };

  const sessionIds = sessions.data.map((s) => s.id);

  const result = await runQuery<
    {
      id: string;
      session_id: string;
      name: string;
      distance_m: number;
      stroke: string;
      is_relay: boolean;
      event_order: number;
      turnaround_seconds: number | null;
      surcharge_egp: number | null;
      capacity_cap: number | null;
    }[]
  >(
    "Loading event schedule",
    async () => {
      const supabase = createClient();
      return supabase
        .from("events")
        // One string literal, deliberately not concatenated: supabase-js parses
        // the select at the TYPE level, and `a + b` widens to `string`, which
        // makes the whole result GenericStringError.
        .select(
          "id, session_id, name, distance_m, stroke, is_relay, event_order, turnaround_seconds, surcharge_egp, capacity_cap",
        )
        .in("session_id", sessionIds)
        .order("event_order", { ascending: true });
    },
    { empty: [] },
  );

  return {
    ...result,
    data: result.data.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      name: row.name,
      distanceM: row.distance_m,
      stroke: row.stroke,
      isRelay: row.is_relay,
      eventOrder: row.event_order,
      // Nulls only occur on a row that predates the columns and has not been
      // backfilled. Zero would be a silent lie in the capacity maths, so these
      // fall back to the schema's own defaults rather than to nothing.
      turnaroundSeconds: row.turnaround_seconds ?? 90,
      surchargeEgp: row.surcharge_egp ?? 0,
      capacityCap: row.capacity_cap ?? DEFAULT_MEET_SETTINGS.defaultEventCapacity,
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
      athlete_capacity: settings.athleteCapacity,
      lane_count: settings.laneCount,
      inter_session_break_minutes: settings.interSessionBreakMinutes,
      athlete_event_limit: settings.athleteEventLimit,
      registration_opens_at: settings.registrationOpensAt,
      registration_closes_at: settings.registrationClosesAt,
      late_registration_enabled: settings.lateRegistrationEnabled,
      hold_window_hours: settings.holdWindowHours,
      waitlist_claim_hours: settings.waitlistClaimHours,
      selling_out_threshold_percent: settings.sellingOutThresholdPercent,
      default_event_capacity: settings.defaultEventCapacity,
      relay_swimmer_price_egp: settings.relaySwimmerPriceEgp,
      pinned_pricing_tier: settings.pinnedPricingTier,
      refund_percent: settings.refundPercent,
      refund_deadline_days: settings.refundDeadlineDays,
      refund_policy_note: settings.refundPolicyNote,
    },
    // The volume, so an unconfigured volume INSERTs and a configured one
    // UPDATEs. Conflicting on the surrogate id instead would insert a
    // duplicate row and trip the unique constraint.
    { onConflict: "meet_volume_id" },
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

/** Per-event turnaround / surcharge / cap — the Control Unit's event table. */
export async function saveEventSettings(
  event: Pick<ScheduledEvent, "id" | "turnaroundSeconds" | "surchargeEgp" | "capacityCap">,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("events")
    .update({
      turnaround_seconds: event.turnaroundSeconds,
      surcharge_egp: event.surchargeEgp,
      capacity_cap: event.capacityCap,
    })
    .eq("id", event.id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
