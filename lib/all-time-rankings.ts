import { createClient } from "@/lib/supabase/client";
import type { AgeGroup, Gender } from "@/lib/supabase/types";
import { withCompetitionRanks } from "@/lib/ranking";

export interface RacePerformance {
  resultId: string;
  athleteId: string;
  athleteName: string;
  teamName?: string | null;
  gender: Gender;
  ageGroup: AgeGroup;
  // Age AT THIS RACE (from public.age_at_date() / the all_time_* views) —
  // never the athlete's current live age. See lib/age.ts's describeAgeAtSwim.
  ageAtSwim: number;
  stroke: string;
  distanceM: number;
  officialTimeMs: number;
  volumeNumber?: number;
  volumeName?: string;
  swamAt?: string;
}

export interface RankedPerformance extends RacePerformance {
  rank: number;
}

export interface RankedPerformer {
  athleteId: string;
  athleteName: string;
  teamName?: string | null;
  gender: Gender;
  ageGroup: AgeGroup;
  // Age at the specific race that produced bestTimeMs.
  ageAtSwim: number;
  stroke: string;
  distanceM: number;
  bestTimeMs: number;
  racesCounted: number;
  rank: number;
}

export interface EventKeyFilter {
  stroke?: string | null;
  distanceM?: number | null;
  ageGroup?: AgeGroup | null;
  gender?: Gender | null;
}

function matchesFilter(row: {
  stroke: string;
  distanceM: number;
  ageGroup: AgeGroup;
  gender: Gender;
}, filter: EventKeyFilter): boolean {
  if (filter.stroke && row.stroke !== filter.stroke) return false;
  if (filter.distanceM != null && row.distanceM !== filter.distanceM) return false;
  if (filter.ageGroup && row.ageGroup !== filter.ageGroup) return false;
  if (filter.gender && row.gender !== filter.gender) return false;
  return true;
}

/**
 * Best Performances — rank every valid race time (athlete may appear multiple
 * times), within stroke/distance/age/gender. Equal times share a place and
 * skip the next (see lib/ranking.ts).
 */
export function rankBestPerformances(
  races: RacePerformance[],
  filter: EventKeyFilter = {},
  limit = 10,
): RankedPerformance[] {
  const filtered = races
    .filter((r) => matchesFilter({
      stroke: r.stroke,
      distanceM: r.distanceM,
      ageGroup: r.ageGroup,
      gender: r.gender,
    }, filter))
    .sort((a, b) => {
      if (a.officialTimeMs !== b.officialTimeMs) {
        return a.officialTimeMs - b.officialTimeMs;
      }
      return (a.swamAt ?? "").localeCompare(b.swamAt ?? "");
    });

  // swamAt orders the display only — it must not split a genuine tie, so the
  // rank key is the time alone.
  const ranked: RankedPerformance[] = withCompetitionRanks(filtered, (r) => r.officialTimeMs);

  // A tie that straddles the cutoff keeps every tied swimmer: they hold the
  // same place, so dropping one because of array position would be arbitrary.
  return ranked.filter((r) => r.rank <= limit);
}

/**
 * Best Performers — collapse to each athlete's single fastest time, then rank.
 */
export function rankBestPerformers(
  races: RacePerformance[],
  filter: EventKeyFilter = {},
  limit = 10,
): RankedPerformer[] {
  const filtered = races.filter((r) =>
    matchesFilter({
      stroke: r.stroke,
      distanceM: r.distanceM,
      ageGroup: r.ageGroup,
      gender: r.gender,
    }, filter),
  );

  const byAthlete = new Map<string, RankedPerformer>();
  for (const race of filtered) {
    const key = [
      race.athleteId,
      race.stroke,
      race.distanceM,
      race.ageGroup,
      race.gender,
    ].join("|");
    const existing = byAthlete.get(key);
    if (!existing) {
      byAthlete.set(key, {
        athleteId: race.athleteId,
        athleteName: race.athleteName,
        teamName: race.teamName,
        gender: race.gender,
        ageGroup: race.ageGroup,
        ageAtSwim: race.ageAtSwim,
        stroke: race.stroke,
        distanceM: race.distanceM,
        bestTimeMs: race.officialTimeMs,
        racesCounted: 1,
        rank: 0,
      });
    } else {
      existing.racesCounted += 1;
      if (race.officialTimeMs < existing.bestTimeMs) {
        existing.bestTimeMs = race.officialTimeMs;
        // Keep age_at_swim correlated with whichever race is currently best.
        existing.ageAtSwim = race.ageAtSwim;
      }
    }
  }

  const sorted = [...byAthlete.values()].sort((a, b) => a.bestTimeMs - b.bestTimeMs);
  const ranked = withCompetitionRanks(sorted, (r) => r.bestTimeMs);

  return ranked.filter((r) => r.rank <= limit);
}

export const DEMO_ALL_TIME_RACES: RacePerformance[] = [
  {
    resultId: "r1",
    athleteId: "ath-leo",
    athleteName: "Leo Fontaine",
    teamName: "Tidal Wave",
    gender: "male",
    ageGroup: "Open",
    ageAtSwim: 21,
    stroke: "Freestyle",
    distanceM: 50,
    officialTimeMs: 24100,
    volumeNumber: 1,
    volumeName: "SSC Vol. 1",
    swamAt: "2026-10-02T09:30:00Z",
  },
  {
    resultId: "r2",
    athleteId: "ath-noah",
    athleteName: "Noah Alvi",
    teamName: "Riptide",
    gender: "male",
    ageGroup: "Open",
    ageAtSwim: 19,
    stroke: "Freestyle",
    distanceM: 50,
    officialTimeMs: 24500,
    volumeNumber: 1,
    volumeName: "SSC Vol. 1",
    swamAt: "2026-10-02T09:31:00Z",
  },
  {
    resultId: "r3",
    athleteId: "ath-leo",
    athleteName: "Leo Fontaine",
    teamName: "Tidal Wave",
    gender: "male",
    ageGroup: "Open",
    // Same swimmer, later volume — one year older, matching the historical
    // (never "live current age") display rule.
    ageAtSwim: 22,
    stroke: "Freestyle",
    distanceM: 50,
    officialTimeMs: 23800,
    volumeNumber: 2,
    volumeName: "SSC Vol. 2",
    swamAt: "2027-03-01T10:00:00Z",
  },
  {
    resultId: "r4",
    athleteId: "ath-kian",
    athleteName: "Kian Osei",
    teamName: "Tidal Wave",
    gender: "male",
    ageGroup: "Open",
    ageAtSwim: 24,
    stroke: "Freestyle",
    distanceM: 50,
    officialTimeMs: 25000,
    volumeNumber: 1,
    volumeName: "SSC Vol. 1",
    swamAt: "2026-10-02T09:32:00Z",
  },
  {
    resultId: "r5",
    athleteId: "ath-zara",
    athleteName: "Zara Khan",
    teamName: "Blue Marlins",
    gender: "female",
    ageGroup: "U17",
    ageAtSwim: 16,
    stroke: "Freestyle",
    distanceM: 50,
    officialTimeMs: 26800,
    volumeNumber: 1,
    volumeName: "SSC Vol. 1",
    swamAt: "2026-10-02T11:00:00Z",
  },
  {
    resultId: "r6",
    athleteId: "ath-mia",
    athleteName: "Mia Reyes",
    teamName: "Blue Marlins",
    gender: "female",
    ageGroup: "U17",
    ageAtSwim: 15,
    stroke: "Freestyle",
    distanceM: 50,
    officialTimeMs: 27100,
    volumeNumber: 1,
    volumeName: "SSC Vol. 1",
    swamAt: "2026-10-02T11:01:00Z",
  },
  {
    resultId: "r7",
    athleteId: "ath-ava",
    athleteName: "Ava Thompson",
    teamName: "Riptide",
    gender: "female",
    ageGroup: "U14",
    ageAtSwim: 13,
    stroke: "Butterfly",
    distanceM: 50,
    officialTimeMs: 31200,
    volumeNumber: 1,
    volumeName: "SSC Vol. 1",
    swamAt: "2026-10-02T14:00:00Z",
  },
];

export async function fetchAllTimePerformances(): Promise<RacePerformance[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("all_time_best_performances")
      .select("*")
      .order("official_time_ms", { ascending: true })
      .limit(500);
    if (error || !data?.length) return DEMO_ALL_TIME_RACES;
    return data.map((row) => ({
      resultId: row.result_id,
      athleteId: row.athlete_id,
      athleteName: row.athlete_name,
      teamName: row.team_name,
      gender: row.gender,
      ageGroup: row.age_group,
      ageAtSwim: row.age_at_swim,
      stroke: row.stroke,
      distanceM: row.distance_m,
      officialTimeMs: row.official_time_ms,
      volumeNumber: row.volume_number,
      volumeName: row.volume_name,
      swamAt: row.swam_at,
    }));
  } catch {
    return DEMO_ALL_TIME_RACES;
  }
}
