import { createClient } from "@/lib/supabase/client";
import { waPointsFor, type WaBaseTimes } from "@/lib/wa-points";
import type { LiveEventView } from "@/lib/live-heats";
import type { AgeGroup, DqReason, Gender, ResultOutcome } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// Data for the Heat & Lane Visualizer (/events/[volId]/telemetry). Every
// other value on a lane card (name, team, seed time) already comes straight
// off LiveLaneView (lib/live-heats.ts) — this file exists only for the one
// thing that view doesn't carry: each swimmer's personal best in THIS
// event's exact stroke + distance, across every volume they've swum it in.
// ---------------------------------------------------------------------------

type RawPbEntry = {
  athlete_id: string;
  events: { stroke: string; distance_m: number } | { stroke: string; distance_m: number }[] | null;
  heat_lanes: {
    results: { official_time_ms: number | null; result_outcome: string; status: string } |
      { official_time_ms: number | null; result_outcome: string; status: string }[] | null;
  }[] | null;
};

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Each athlete's best (lowest) official time in one exact stroke +
 * distance, across every volume — a personal best, not a season best. Only
 * published, validly-completed swims count; a DQ or an unpublished draft
 * time is not a real personal best yet. Athletes with no qualifying swim are
 * simply absent from the returned map (never a zero or a null entry) — a
 * lane card can then read "no PB on file" from a missing key rather than
 * distinguishing null-meaning-untimed from null-meaning-no-map-entry. */
export async function fetchPersonalBestsForEventShape(
  athleteIds: string[],
  stroke: string,
  distanceM: number,
): Promise<Map<string, number>> {
  const bests = new Map<string, number>();
  if (athleteIds.length === 0) return bests;

  const supabase = createClient();
  // Filtered client-side, not via `.eq("events.stroke", …)` on the embed —
  // the same choice lib/athletes.ts's own career-results query already
  // makes (see its comment there): this hand-maintained Database type
  // declares no FK relationship metadata, and a dot-notation filter into an
  // embedded table is unreliable without one. Fetching broadly per athlete
  // and filtering in JS is the proven pattern here.
  const { data } = await supabase
    .from("entries")
    .select(
      "athlete_id, events ( stroke, distance_m ), heat_lanes ( results ( official_time_ms, result_outcome, status ) )",
    )
    .in("athlete_id", athleteIds);

  // Cast for the same reason every other multi-table embed in this codebase
  // is: the hand-maintained Database type carries no FK relationship
  // metadata for PostgREST to infer this embed's shape from.
  for (const row of (data as unknown as RawPbEntry[] | null) ?? []) {
    const event = firstOf(row.events);
    if (!event || event.stroke !== stroke || event.distance_m !== distanceM) continue;
    for (const lane of row.heat_lanes ?? []) {
      const result = firstOf(lane.results);
      if (!result || result.status !== "published" || result.result_outcome !== "valid") continue;
      if (result.official_time_ms == null) continue;
      const current = bests.get(row.athlete_id);
      if (current == null || result.official_time_ms < current) {
        bests.set(row.athlete_id, result.official_time_ms);
      }
    }
  }

  return bests;
}

// ---------------------------------------------------------------------------
// Phase 2: pure transforms behind the pill filter nav and the expandable
// leaderboard cards. Deliberately pure (no Supabase, no React) so the ranking
// and filtering rules are unit-testable on their own — every fetch these feed
// from already exists (fetchLiveEventsForSession, fetchWaBaseTimes).
// ---------------------------------------------------------------------------

export type GenderFilter = Gender | "all";
export type StrokeFilter = string | "all";
/** Distances arrive from the pill nav as strings (a DOM value), never as
 * numbers — kept as one so filter state and option values cannot drift. */
export type DistanceFilter = string | "all";

export interface TelemetryFilters {
  gender: GenderFilter;
  stroke: StrokeFilter;
  distance: DistanceFilter;
}

export const ALL_FILTERS: TelemetryFilters = { gender: "all", stroke: "all", distance: "all" };

/** The stroke / distance / gender values actually present in this session's
 * events — the pill nav offers only what a swimmer could really be filtered
 * to, so no pill can ever produce an empty board. Gender comes off the HEAT
 * (heats are split male/female by the seeding pipeline), not off the event. */
export function deriveFilterOptions(events: LiveEventView[]): {
  strokes: string[];
  distances: number[];
  genders: Gender[];
} {
  const strokes = new Set<string>();
  const distances = new Set<number>();
  const genders = new Set<Gender>();
  for (const event of events) {
    strokes.add(event.stroke);
    distances.add(event.distanceM);
    for (const heat of event.heats) {
      if (heat.gender) genders.add(heat.gender);
    }
  }
  return {
    strokes: [...strokes].sort(),
    distances: [...distances].sort((a, b) => a - b),
    genders: (["female", "male"] as Gender[]).filter((g) => genders.has(g)),
  };
}

/** Events surviving the pill filters, each carrying only the heats that
 * survive the gender pill. An event whose every heat is filtered out drops
 * from the list entirely rather than rendering as an empty shell. */
export function applyTelemetryFilters(
  events: LiveEventView[],
  filters: TelemetryFilters,
): LiveEventView[] {
  return events
    .filter((event) => filters.stroke === "all" || event.stroke === filters.stroke)
    .filter((event) => filters.distance === "all" || String(event.distanceM) === filters.distance)
    .map((event) => ({
      ...event,
      heats:
        filters.gender === "all"
          ? event.heats
          : // A legacy heat with a null gender predates the male/female split
            // and cannot honestly be claimed for either — it is filtered out
            // rather than shown under both.
            event.heats.filter((heat) => heat.gender === filters.gender),
    }))
    .filter((event) => event.heats.length > 0);
}

export interface TelemetryStanding {
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  gender: Gender;
  ageGroup: AgeGroup;
  heatNumber: number;
  laneNumber: number;
  seedTimeMs: number | null;
  isNt: boolean;
  officialTimeMs: number | null;
  outcome: ResultOutcome | null;
  dqCode: DqReason | null;
  awaitingApproval: boolean;
  /** null for an unrateable event (relays, Skins, the switch events) or for
   * any swim that produced no time — never 0. See lib/wa-points.ts. */
  waPoints: number | null;
  /** official − seed, in ms. Negative means faster than seeded. null when
   * either half is missing (an NT entry has nothing to be measured against). */
  deltaMs: number | null;
  /** Competition rank across every heat of the event, ties sharing a place.
   * null for a swimmer with no valid published time yet — they sort last and
   * render as "—", never as a provisional last place. */
  rank: number | null;
}

/** One event's swimmers ranked across ALL its heats, fastest first — the
 * combined result order, which is not the same as any single heat's finish
 * order. Swimmers with no published valid time keep their entry metadata and
 * sort to the bottom in heat/lane order, so the board is a complete picture of
 * who is IN the event rather than only of who has already swum.
 *
 * DQs and no-shows are deliberately unranked but still listed: a DQ is a
 * result, and hiding it would misrepresent the field. */
export function buildEventStandings(
  event: LiveEventView,
  baseTimes: WaBaseTimes,
): TelemetryStanding[] {
  const rows: TelemetryStanding[] = [];
  for (const heat of event.heats) {
    for (const lane of heat.lanes) {
      const valid = lane.result?.outcome === "valid" ? lane.result.officialTimeMs : null;
      rows.push({
        athleteId: lane.athleteId,
        athleteName: lane.athleteName,
        teamName: lane.teamName,
        gender: lane.gender,
        ageGroup: lane.ageGroup,
        heatNumber: heat.heatNumber,
        laneNumber: lane.laneNumber,
        seedTimeMs: lane.seedTimeMs,
        isNt: lane.isNt,
        officialTimeMs: lane.result?.officialTimeMs ?? null,
        outcome: lane.result?.outcome ?? null,
        dqCode: lane.result?.dqCode ?? null,
        awaitingApproval: lane.awaitingApproval,
        waPoints: waPointsFor(baseTimes, {
          stroke: event.stroke,
          distanceM: event.distanceM,
          gender: lane.gender,
          officialTimeMs: valid,
        }),
        deltaMs: valid != null && lane.seedTimeMs != null ? valid - lane.seedTimeMs : null,
        rank: null,
      });
    }
  }

  const timed = rows
    .filter((r) => r.outcome === "valid" && r.officialTimeMs != null)
    .sort((a, b) => a.officialTimeMs! - b.officialTimeMs!);
  let lastTime: number | null = null;
  let lastRank = 0;
  timed.forEach((row, index) => {
    // Standard competition ranking: equal times share a place and the next
    // distinct time skips the places they consumed (1, 2, 2, 4).
    if (lastTime != null && row.officialTimeMs === lastTime) {
      row.rank = lastRank;
    } else {
      row.rank = index + 1;
      lastRank = row.rank;
      lastTime = row.officialTimeMs;
    }
  });

  return rows.sort((a, b) => {
    if (a.rank != null && b.rank != null) return a.rank - b.rank;
    if (a.rank != null) return -1;
    if (b.rank != null) return 1;
    return a.heatNumber - b.heatNumber || a.laneNumber - b.laneNumber;
  });
}

export interface PbTrajectoryPoint {
  volumeName: string;
  swamAt: string;
  officialTimeMs: number;
  /** Change from the previous swim of this exact stroke + distance. Negative
   * is an improvement. null on the first swim, which has nothing to improve
   * on. */
  deltaMs: number | null;
  /** True when this swim was, at the time, the fastest they had ever gone. */
  isPersonalBest: boolean;
}

/** A swimmer's chronological progression in one exact stroke + distance, for
 * the deep-dive modal. Takes career results already loaded by
 * fetchAthleteProfile rather than issuing its own query. */
export function buildPbTrajectory(
  careerResults: {
    stroke: string;
    distanceM: number;
    officialTimeMs: number | null;
    outcome: ResultOutcome | null;
    volumeName: string;
    swamAt: string;
  }[],
  stroke: string,
  distanceM: number,
): PbTrajectoryPoint[] {
  const swims = careerResults
    .filter(
      (r) =>
        r.stroke === stroke &&
        r.distanceM === distanceM &&
        r.outcome === "valid" &&
        r.officialTimeMs != null,
    )
    .sort((a, b) => a.swamAt.localeCompare(b.swamAt));

  let best: number | null = null;
  let previous: number | null = null;
  return swims.map((swim) => {
    const time = swim.officialTimeMs!;
    const point: PbTrajectoryPoint = {
      volumeName: swim.volumeName,
      swamAt: swim.swamAt,
      officialTimeMs: time,
      deltaMs: previous == null ? null : time - previous,
      isPersonalBest: best == null || time < best,
    };
    if (best == null || time < best) best = time;
    previous = time;
    return point;
  });
}
