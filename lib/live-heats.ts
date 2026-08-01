import { createClient } from "@/lib/supabase/client";
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
  status: PublishStatus;
  heat_lanes: RawHeatLane[];
}

export interface RawEvent {
  id: string;
  name: string;
  stroke: string;
  distance_m: number;
  is_skins: boolean;
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
  status: PublishStatus;
  lanes: LiveLaneView[];
}

export interface LiveEventView {
  eventId: string;
  name: string;
  stroke: string;
  distanceM: number;
  isSkins: boolean;
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
    heats: [...ev.heats]
      .sort((a, b) => a.heat_number - b.heat_number)
      .map((heat) => ({
        heatId: heat.id,
        heatNumber: heat.heat_number,
        heatGroup: heat.heat_group,
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
    heats: [
      {
        heatId: "demo-heat-1",
        heatNumber: 1,
        heatGroup: "U13_14",
        status: "published",
        lanes: [
          {
            laneNumber: 2,
            athleteId: "demo-a1",
            athleteName: "Ava Thompson",
            teamName: "Riptide",
            gender: "female",
            ageGroup: "U13_14",
            seedTimeMs: null,
            isNt: true,
            result: { outcome: "valid", officialTimeMs: 34210, finishPlace: 2, dqCode: null, status: "published" },
          },
          {
            laneNumber: 4,
            athleteId: "demo-a2",
            athleteName: "Kian Osei",
            teamName: "Tidal Wave",
            gender: "male",
            ageGroup: "U13_14",
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
            ageGroup: "U13_14",
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
            athleteName: "Mia Reyes",
            teamName: "Blue Marlins",
            gender: "female",
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
    heats: [
      {
        heatId: "demo-heat-3",
        heatNumber: 1,
        heatGroup: "U17_OPEN",
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
  id, name, stroke, distance_m, is_skins,
  heats (
    id, heat_number, heat_group, status,
    heat_lanes (
      lane_number,
      entries (
        id, seed_time_ms, is_nt,
        athletes ( id, gender, age_group, users ( full_name ), teams ( name ) )
      ),
      results ( result_outcome, official_time_ms, finish_place, dq_code, status )
    )
  )
`;

export async function fetchLiveEventsForSession(sessionId: string): Promise<LiveEventView[]> {
  // A demo session id means the volume/session itself came from fallback data
  // (Supabase unreachable) — keep the whole preview consistent.
  if (sessionId.startsWith("demo-")) return DEMO_LIVE_EVENTS;

  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("events")
      .select(LIVE_EVENT_SELECT)
      .eq("session_id", sessionId)
      .order("event_order", { ascending: true });

    // A query error falls back to demo data so the UI still previews
    // correctly; a genuinely empty result (no events entered yet) is real
    // and should be shown as such, not masked with fake heats.
    if (error) return DEMO_LIVE_EVENTS;
    if (!data) return [];
    return transformLiveEvents(data as unknown as RawEvent[]);
  } catch {
    return DEMO_LIVE_EVENTS;
  }
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
