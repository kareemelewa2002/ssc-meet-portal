import { createClient } from "@/lib/supabase/client";
import { DEMO_FALLBACK_ENABLED, runQuery, type FetchResult } from "@/lib/fetch-policy";
import type {
  AgeGroup,
  DqReason,
  Gender,
  HeatGroup,
  PublishStatus,
  ResultOutcome,
} from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// Raw shapes for the nested Supabase embed (events -> heats -> heat_lanes ->
// entries -> athletes -> users/teams, plus heat_lanes -> results). Our
// hand-written Database type doesn't model FK "Relationships" metadata, so
// supabase-js can't type-check embedded selects — these interfaces describe
// what the query actually returns instead. PostgREST returns a to-one embed
// as a single object once it knows the FK is unique, but as a one-element
// array otherwise depending on schema-cache state, so every nested field
// below tolerates both shapes (see `firstOf`).
// ---------------------------------------------------------------------------

export interface RawUser {
  full_name: string;
}

export interface RawTeam {
  name: string;
}

export interface RawAthlete {
  id: string;
  gender: Gender;
  age_group: AgeGroup;
  users: RawUser | RawUser[] | null;
  teams: RawTeam | RawTeam[] | null;
}

export interface RawEntry {
  id: string;
  seed_time_ms: number | null;
  is_nt: boolean;
  athletes: RawAthlete | RawAthlete[] | null;
}

export interface RawResult {
  result_outcome: ResultOutcome | null;
  official_time_ms: number | null;
  finish_place: number | null;
  dq_code: DqReason | null;
  status: PublishStatus;
}

export interface RawHeatLane {
  lane_number: number;
  entries: RawEntry | RawEntry[] | null;
  results: RawResult | RawResult[] | null;
}

export interface RawHeat {
  id: string;
  heat_number: number;
  heat_group: HeatGroup;
  gender: Gender | null;
  status: PublishStatus;
  heat_lanes: RawHeatLane[];
}

export interface RawEvent {
  id: string;
  name: string;
  stroke: string;
  distance_m: number;
  is_skins: boolean;
  session_id?: string;
  heats: RawHeat[];
}

export function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

// ---------------------------------------------------------------------------
// Clean view-model types for the UI.
// ---------------------------------------------------------------------------

export interface LiveResultView {
  outcome: ResultOutcome | null;
  officialTimeMs: number | null;
  finishPlace: number | null;
  dqCode: DqReason | null;
  status: PublishStatus;
}

export interface LiveLaneView {
  laneNumber: number;
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  gender: Gender;
  ageGroup: AgeGroup;
  seedTimeMs: number | null;
  isNt: boolean;
  result: LiveResultView | null;
}

export interface LiveHeatView {
  heatId: string;
  heatNumber: number;
  heatGroup: HeatGroup;
  /** null only for legacy heats seeded before male/female were split. */
  gender: Gender | null;
  status: PublishStatus;
  lanes: LiveLaneView[];
}

export interface LiveEventView {
  eventId: string;
  name: string;
  stroke: string;
  distanceM: number;
  isSkins: boolean;
  sessionId: string | null;
  /** Populated when events are loaded across sessions, so the combined view
   * can order and label them. */
  sessionNumber: number | null;
  heats: LiveHeatView[];
}

/** Pure transform — kept separate from data fetching so it's independently testable. */
export function transformLiveEvents(raw: RawEvent[]): LiveEventView[] {
  return raw.map((ev) => ({
    eventId: ev.id,
    name: ev.name,
    stroke: ev.stroke,
    distanceM: ev.distance_m,
    isSkins: ev.is_skins,
    sessionId: ev.session_id ?? null,
    sessionNumber: null,
    heats: [...ev.heats]
      .sort((a, b) => a.heat_number - b.heat_number)
      .map((heat) => ({
        heatId: heat.id,
        heatNumber: heat.heat_number,
        heatGroup: heat.heat_group,
        gender: heat.gender ?? null,
        status: heat.status,
        lanes: [...heat.heat_lanes]
          .map((lane): LiveLaneView | null => {
            const entry = firstOf(lane.entries);
            const athlete = entry ? firstOf(entry.athletes) : null;
            if (!entry || !athlete) return null;
            const user = firstOf(athlete.users);
            const team = firstOf(athlete.teams);
            const result = firstOf(lane.results);
            return {
              laneNumber: lane.lane_number,
              athleteId: athlete.id,
              athleteName: user?.full_name ?? "Unknown swimmer",
              teamName: team?.name ?? null,
              gender: athlete.gender,
              ageGroup: athlete.age_group,
              seedTimeMs: entry.seed_time_ms,
              isNt: entry.is_nt,
              result: result
                ? {
                    outcome: result.result_outcome,
                    officialTimeMs: result.official_time_ms,
                    finishPlace: result.finish_place,
                    dqCode: result.dq_code,
                    status: result.status,
                  }
                : null,
            };
          })
          .filter((lane): lane is LiveLaneView => lane !== null)
          .sort((a, b) => a.laneNumber - b.laneNumber),
      })),
  }));
}

/** Shown when Supabase isn't reachable or a session has no events entered yet. */
export const DEMO_LIVE_EVENTS: LiveEventView[] = [
  {
    eventId: "demo-ev-1",
    name: "50m Freestyle",
    stroke: "Freestyle",
    distanceM: 50,
    isSkins: false,
    sessionId: null,
    sessionNumber: 1,
    heats: [
      {
        heatId: "demo-heat-1",
        heatNumber: 1,
        heatGroup: "U13_14",
        gender: "female",
        status: "published",
        lanes: [
          {
            laneNumber: 2,
            athleteId: "demo-a1",
            athleteName: "Ava Thompson",
            teamName: "Riptide",
            gender: "female",
            ageGroup: "U14",
            seedTimeMs: null,
            isNt: true,
            result: { outcome: "valid", officialTimeMs: 34210, finishPlace: 2, dqCode: null, status: "published" },
          },
          {
            laneNumber: 4,
            athleteId: "demo-a2",
            athleteName: "Nour Hadid",
            teamName: "Tidal Wave",
            gender: "female",
            ageGroup: "U14",
            seedTimeMs: null,
            isNt: true,
            result: { outcome: "valid", officialTimeMs: 33010, finishPlace: 1, dqCode: null, status: "published" },
          },
          {
            laneNumber: 5,
            athleteId: "demo-a3",
            athleteName: "Zara Khan",
            teamName: "Blue Marlins",
            gender: "female",
            ageGroup: "U14",
            seedTimeMs: null,
            isNt: true,
            result: { outcome: "dq", officialTimeMs: null, finishPlace: null, dqCode: "false_start", status: "published" },
          },
        ],
      },
      {
        heatId: "demo-heat-2",
        heatNumber: 2,
        heatGroup: "U17_OPEN",
        gender: "male",
        status: "published",
        lanes: [
          {
            laneNumber: 3,
            athleteId: "demo-a4",
            athleteName: "Noah Alvi",
            teamName: "Riptide",
            gender: "male",
            ageGroup: "U17",
            seedTimeMs: 30500,
            isNt: false,
            result: null,
          },
          {
            laneNumber: 4,
            athleteId: "demo-a5",
            athleteName: "Leo Fontaine",
            teamName: "Tidal Wave",
            gender: "male",
            ageGroup: "Open",
            seedTimeMs: 29200,
            isNt: false,
            result: null,
          },
          {
            laneNumber: 5,
            athleteId: "demo-a6",
            athleteName: "Omar Reyes",
            teamName: "Blue Marlins",
            gender: "male",
            ageGroup: "U17",
            seedTimeMs: 31000,
            isNt: false,
            result: null,
          },
        ],
      },
    ],
  },
  {
    eventId: "demo-ev-2",
    name: "100m Backstroke",
    stroke: "Backstroke",
    distanceM: 100,
    isSkins: false,
    sessionId: null,
    sessionNumber: 1,
    heats: [
      {
        heatId: "demo-heat-3",
        heatNumber: 1,
        heatGroup: "U17_OPEN",
        gender: "female",
        status: "published",
        lanes: [
          {
            laneNumber: 4,
            athleteId: "demo-a7",
            athleteName: "Grace Thompson",
            teamName: "Riptide",
            gender: "female",
            ageGroup: "Open",
            seedTimeMs: 68000,
            isNt: false,
            result: { outcome: "valid", officialTimeMs: 66500, finishPlace: 1, dqCode: null, status: "published" },
          },
        ],
      },
    ],
  },
];

const LIVE_EVENT_SELECT = `
  id, name, stroke, distance_m, is_skins, session_id, event_order,
  heats (
    id, heat_number, heat_group, gender, status,
    heat_lanes (
      lane_number,
      entries (
        id, seed_time_ms, is_nt,
        athletes ( id, gender, age_group, users!athletes_user_id_fkey ( full_name ), teams ( name ) )
      ),
      results ( result_outcome, official_time_ms, finish_place, dq_code, status )
    )
  )
`;

export async function fetchLiveEventsForSession(
  sessionId: string,
): Promise<FetchResult<LiveEventView[]>> {
  // A demo session id means the volume/session itself came from fallback data
  // (only reachable with NEXT_PUBLIC_ALLOW_DEMO_FALLBACK on) — keep the
  // preview internally consistent rather than mixing demo + live.
  if (sessionId.startsWith("demo-")) {
    return { data: DEMO_LIVE_EVENTS, error: null, usedFallback: true };
  }

  const result = await runQuery<RawEvent[]>(
    "Loading heat sheets for this session",
    async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("events")
        .select(LIVE_EVENT_SELECT)
        .eq("session_id", sessionId)
        .order("event_order", { ascending: true });
      return { data: data as unknown as RawEvent[] | null, error };
    },
    // NOTE: `empty: []` is what a real "no events seeded yet" session returns
    // too — the difference is that a failure also sets `error`, so the UI can
    // tell an empty schedule apart from a broken query. That distinction is
    // exactly what was missing when the 'usher' RLS outage went unnoticed.
    { empty: [], demo: [] },
  );

  return {
    ...result,
    data: result.error && DEMO_FALLBACK_ENABLED ? DEMO_LIVE_EVENTS : transformLiveEvents(result.data),
    usedFallback: result.error != null && DEMO_FALLBACK_ENABLED,
  };
}

/** Resolves which session number a specific event belongs to — used when a
 * link deep-links straight to one event (?event=<id>) without a ?session=
 * hint, so the live view can select the right session tab before filtering
 * down to that single event. */
export async function fetchEventSessionNumber(eventId: string): Promise<number | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("events")
      .select("sessions ( session_number )")
      .eq("id", eventId)
      .maybeSingle();
    if (error || !data) return null;
    const session = firstOf(
      (data as unknown as { sessions: { session_number: number } | { session_number: number }[] | null })
        .sessions,
    );
    return session?.session_number ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Event results — overall standings across every heat of an event.
// ---------------------------------------------------------------------------

export interface EventResultView {
  eventId: string;
  eventName: string;
  ageGroup: AgeGroup;
  gender: Gender;
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  heatNumber: number;
  officialTimeMs: number;
  eventPlace: number;
}

/**
 * Reads public.event_results, which ranks published results across ALL heats
 * of an event. This is deliberately not the same as results.finish_place:
 * heats are seeded by speed, so winning heat 1 is not winning the event.
 */
export async function fetchEventResultsForSession(
  sessionId: string,
): Promise<FetchResult<EventResultView[]>> {
  if (sessionId.startsWith("demo-")) return { data: [], error: null, usedFallback: true };

  const result = await runQuery<
    {
      event_id: string;
      event_name: string;
      age_group: AgeGroup;
      gender: Gender;
      athlete_id: string;
      athlete_name: string;
      team_name: string | null;
      heat_number: number;
      official_time_ms: number;
      event_place: number;
    }[]
  >(
    "Loading event results",
    async () => {
      const supabase = createClient();
      return supabase
        .from("event_results")
        .select(
          "event_id, event_name, age_group, gender, athlete_id, athlete_name, team_name, heat_number, official_time_ms, event_place",
        )
        .eq("session_id", sessionId)
        .order("event_name", { ascending: true })
        .order("event_place", { ascending: true });
    },
    { empty: [] },
  );

  return {
    ...result,
    data: result.data.map((r) => ({
      eventId: r.event_id,
      eventName: r.event_name,
      ageGroup: r.age_group,
      gender: r.gender,
      athleteId: r.athlete_id,
      athleteName: r.athlete_name,
      teamName: r.team_name,
      heatNumber: r.heat_number,
      officialTimeMs: r.official_time_ms,
      eventPlace: r.event_place,
    })),
  };
}

/** World Aquatics points + top-performance flags for one swim, keyed by
 * `${athleteId}:${eventId}` (an athlete enters an event at most once). */
export interface PerformanceHighlight {
  waPoints: number;
  isBestOverall: boolean;
  isBestInEvent: boolean;
}

/**
 * Loads the points/badge overlay for a whole volume in one query.
 *
 * Kept separate from the heat fetch on purpose: the switch events have no
 * points at all, so this is genuinely sparse — folding it into the lane rows
 * would mean carrying a null column through every heat sheet that never uses
 * it. A missing key here means "unrated", never "zero".
 */
export async function fetchPerformanceHighlights(
  meetVolumeId: string,
): Promise<FetchResult<Map<string, PerformanceHighlight>>> {
  const result = await runQuery<
    { athlete_id: string; event_id: string; wa_points: number; is_best_overall: boolean; is_best_in_event: boolean }[]
  >(
    "Loading World Aquatics points",
    async () => {
      const supabase = createClient();
      return supabase
        .from("performance_highlights")
        .select("athlete_id, event_id, wa_points, is_best_overall, is_best_in_event")
        .eq("meet_volume_id", meetVolumeId);
    },
    { empty: [] },
  );

  const map = new Map<string, PerformanceHighlight>();
  for (const row of result.data) {
    map.set(`${row.athlete_id}:${row.event_id}`, {
      waPoints: row.wa_points,
      isBestOverall: row.is_best_overall,
      isBestInEvent: row.is_best_in_event,
    });
  }
  return { ...result, data: map };
}

/**
 * Loads every event across a set of sessions in one query, ordered the way
 * they are actually swum: session first, then event order within it.
 *
 * The per-session fetch above stays because the live deck genuinely wants one
 * session at a time. This one backs the combined "all races" view, where a
 * spectator looking for one swimmer should not have to guess which session
 * their race was in.
 */
export async function fetchLiveEventsForSessions(
  sessions: { id: string; session_number: number }[],
): Promise<FetchResult<LiveEventView[]>> {
  const real = sessions.filter((s) => !s.id.startsWith("demo-"));
  if (real.length === 0) {
    return { data: DEMO_FALLBACK_ENABLED ? DEMO_LIVE_EVENTS : [], error: null, usedFallback: true };
  }

  const sessionNumberById = new Map(real.map((s) => [s.id, s.session_number]));
  const result = await runQuery<RawEvent[]>(
    "Loading every race in this meet",
    async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("events")
        .select(LIVE_EVENT_SELECT)
        .in("session_id", real.map((s) => s.id))
        .order("event_order", { ascending: true });
      return { data: data as unknown as RawEvent[] | null, error };
    },
    { empty: [], demo: [] },
  );

  const events = transformLiveEvents(result.data)
    .map((ev) => ({ ...ev, sessionNumber: sessionNumberById.get(ev.sessionId ?? "") ?? null }))
    .sort((a, b) => (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0));

  return { ...result, data: events };
}
