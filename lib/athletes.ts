import { createClient } from "@/lib/supabase/client";
import type {
  AgeGroup,
  AwardType,
  Gender,
  ResultOutcome,
  DqReason,
} from "@/lib/supabase/types";
import { firstOf } from "@/lib/live-heats";
import { calculateAge } from "@/lib/age";

export const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  U14: "U14",
  U17: "U17",
  Open: "Open",
};

export const AWARD_TYPE_LABELS: Record<AwardType, string> = {
  best_swimmer: "Best Swimmer",
  most_improved: "Most Improved",
};

export interface AthleteAwardView {
  id: string;
  awardType: AwardType;
  category: AgeGroup;
  gender: Gender;
  volumeNumber: number;
  volumeName: string;
}

export interface PersonalBestView {
  stroke: string;
  distanceM: number;
  bestTimeMs: number;
  volumeName?: string;
  // Age when this PB was set — never the athlete's current age.
  ageAtSwim: number;
}

export interface CareerResultView {
  id: string;
  volumeName: string;
  volumeNumber: number;
  eventName: string;
  stroke: string;
  distanceM: number;
  officialTimeMs: number | null;
  finishPlace: number | null;
  splitTimeMs: number | null;
  outcome: ResultOutcome | null;
  dqCode: DqReason | null;
  swamAt: string;
  // Age at this specific race (derived from date_of_birth + the volume's
  // meet_date) — never the athlete's current live age.
  ageAtSwim: number;
}

export interface SeriesStandingView {
  category: AgeGroup;
  placementRank: number | null;
  improvementRank: number | null;
  placementPoints: number;
  improvementPoints: number;
  volumesCounted: number;
}

export interface AthleteDirectoryCard {
  id: string;
  fullName: string;
  age: number;
  ageGroup: AgeGroup;
  gender: Gender;
  teamName: string | null;
  profileImageUrl: string | null;
  eventsSwum: number;
  awards: AthleteAwardView[];
}

export interface AthleteProfileView {
  id: string;
  fullName: string;
  age: number;
  ageGroup: AgeGroup;
  gender: Gender;
  teamName: string | null;
  profileImageUrl: string | null;
  awards: AthleteAwardView[];
  seriesStandings: SeriesStandingView[];
  personalBests: PersonalBestView[];
  careerResults: CareerResultView[];
}

export const DEMO_ATHLETES: AthleteProfileView[] = [
  {
    id: "ath-leo",
    fullName: "Leo Fontaine",
    age: 22,
    ageGroup: "Open",
    gender: "male",
    teamName: "Tidal Wave",
    profileImageUrl: null,
    awards: [
      {
        id: "aw-1",
        awardType: "best_swimmer",
        category: "Open",
        gender: "male",
        volumeNumber: 1,
        volumeName: "SSC Vol. 1",
      },
    ],
    seriesStandings: [
      {
        category: "Open",
        placementRank: 1,
        improvementRank: 3,
        placementPoints: 42,
        improvementPoints: 6.5,
        volumesCounted: 1,
      },
    ],
    personalBests: [
      { stroke: "Freestyle", distanceM: 50, bestTimeMs: 23800, volumeName: "SSC Vol. 2" , ageAtSwim: 22 },
      { stroke: "Butterfly", distanceM: 50, bestTimeMs: 26500, volumeName: "SSC Vol. 1" , ageAtSwim: 21 },
    ],
    careerResults: [
      {
        id: "cr-1",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Freestyle",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 24100,
        finishPlace: 1,
        splitTimeMs: null,
        outcome: "valid",
        dqCode: null,
        swamAt: "2026-10-02T09:30:00Z",
        ageAtSwim: 21,
      },
      {
        id: "cr-2",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Butterfly",
        stroke: "Butterfly",
        distanceM: 50,
        officialTimeMs: 26500,
        finishPlace: 2,
        splitTimeMs: null,
        outcome: "valid",
        dqCode: null,
        swamAt: "2026-10-02T14:10:00Z",
        ageAtSwim: 21,
      },
    ],
  },
  {
    id: "ath-zara",
    fullName: "Zara Khan",
    age: 16,
    ageGroup: "U17",
    gender: "female",
    teamName: "Blue Marlins",
    profileImageUrl: null,
    awards: [
      {
        id: "aw-2",
        awardType: "most_improved",
        category: "U17",
        gender: "female",
        volumeNumber: 1,
        volumeName: "SSC Vol. 1",
      },
    ],
    seriesStandings: [
      {
        category: "U17",
        placementRank: 2,
        improvementRank: 1,
        placementPoints: 28,
        improvementPoints: 12.2,
        volumesCounted: 1,
      },
    ],
    personalBests: [
      { stroke: "Freestyle", distanceM: 50, bestTimeMs: 26800, volumeName: "SSC Vol. 1" , ageAtSwim: 16 },
    ],
    careerResults: [
      {
        id: "cr-3",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Freestyle",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 26800,
        finishPlace: 1,
        splitTimeMs: null,
        outcome: "valid",
        dqCode: null,
        swamAt: "2026-10-02T11:00:00Z",
        ageAtSwim: 16,
      },
    ],
  },
  {
    id: "ath-mia",
    fullName: "Mia Reyes",
    age: 15,
    ageGroup: "U17",
    gender: "female",
    teamName: "Blue Marlins",
    profileImageUrl: null,
    awards: [],
    seriesStandings: [
      {
        category: "U17",
        placementRank: 4,
        improvementRank: 5,
        placementPoints: 14,
        improvementPoints: 2.0,
        volumesCounted: 1,
      },
    ],
    personalBests: [
      { stroke: "Freestyle", distanceM: 50, bestTimeMs: 27100, volumeName: "SSC Vol. 1" , ageAtSwim: 15 },
    ],
    careerResults: [
      {
        id: "cr-4",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Freestyle",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: null,
        finishPlace: null,
        splitTimeMs: null,
        outcome: "dq",
        dqCode: "false_start",
        swamAt: "2026-10-02T11:05:00Z",
        ageAtSwim: 15,
      },
      {
        id: "cr-5",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Freestyle Final",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 27100,
        finishPlace: 3,
        splitTimeMs: null,
        outcome: "valid",
        dqCode: null,
        swamAt: "2026-10-02T11:20:00Z",
        ageAtSwim: 15,
      },
    ],
  },
  {
    id: "ath-noah",
    fullName: "Noah Alvi",
    age: 19,
    ageGroup: "Open",
    gender: "male",
    teamName: "Riptide",
    profileImageUrl: null,
    awards: [],
    seriesStandings: [
      {
        category: "Open",
        placementRank: 2,
        improvementRank: 4,
        placementPoints: 34,
        improvementPoints: 4.1,
        volumesCounted: 1,
      },
    ],
    personalBests: [
      { stroke: "Freestyle", distanceM: 50, bestTimeMs: 24500, volumeName: "SSC Vol. 1" , ageAtSwim: 19 },
    ],
    careerResults: [
      {
        id: "cr-6",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Freestyle",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 24500,
        finishPlace: 2,
        splitTimeMs: null,
        outcome: "valid",
        dqCode: null,
        swamAt: "2026-10-02T09:31:00Z",
        ageAtSwim: 19,
      },
    ],
  },
  {
    id: "ath-ava",
    fullName: "Ava Thompson",
    age: 13,
    ageGroup: "U14",
    gender: "female",
    teamName: "Riptide",
    profileImageUrl: null,
    awards: [
      {
        id: "aw-3",
        awardType: "best_swimmer",
        category: "U14",
        gender: "female",
        volumeNumber: 1,
        volumeName: "SSC Vol. 1",
      },
    ],
    seriesStandings: [
      {
        category: "U14",
        placementRank: 1,
        improvementRank: null,
        placementPoints: 36,
        improvementPoints: 0,
        volumesCounted: 1,
      },
    ],
    personalBests: [
      { stroke: "Butterfly", distanceM: 50, bestTimeMs: 31200, volumeName: "SSC Vol. 1" , ageAtSwim: 13 },
    ],
    careerResults: [
      {
        id: "cr-7",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Butterfly",
        stroke: "Butterfly",
        distanceM: 50,
        officialTimeMs: 31200,
        finishPlace: 1,
        splitTimeMs: null,
        outcome: "valid",
        dqCode: null,
        swamAt: "2026-10-02T14:00:00Z",
        ageAtSwim: 13,
      },
      {
        id: "cr-8",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Freestyle",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: null,
        finishPlace: null,
        splitTimeMs: null,
        outcome: "no_show",
        dqCode: null,
        swamAt: "2026-10-02T09:40:00Z",
        ageAtSwim: 13,
      },
    ],
  },
  {
    id: "ath-kian",
    fullName: "Kian Osei",
    age: 24,
    ageGroup: "Open",
    gender: "male",
    teamName: "Tidal Wave",
    profileImageUrl: null,
    awards: [],
    seriesStandings: [
      {
        category: "Open",
        placementRank: 5,
        improvementRank: 2,
        placementPoints: 18,
        improvementPoints: 8.0,
        volumesCounted: 1,
      },
    ],
    personalBests: [
      { stroke: "Freestyle", distanceM: 50, bestTimeMs: 25000, volumeName: "SSC Vol. 1" , ageAtSwim: 24 },
    ],
    careerResults: [
      {
        id: "cr-9",
        volumeName: "SSC Vol. 1",
        volumeNumber: 1,
        eventName: "50 Freestyle",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 25000,
        finishPlace: 4,
        splitTimeMs: null,
        outcome: "valid",
        dqCode: null,
        swamAt: "2026-10-02T09:32:00Z",
        ageAtSwim: 24,
      },
    ],
  },
];

export function toDirectoryCard(profile: AthleteProfileView): AthleteDirectoryCard {
  return {
    id: profile.id,
    fullName: profile.fullName,
    age: profile.age,
    ageGroup: profile.ageGroup,
    gender: profile.gender,
    teamName: profile.teamName,
    profileImageUrl: profile.profileImageUrl,
    eventsSwum: new Set(profile.careerResults.map((r) => `${r.stroke}-${r.distanceM}`)).size,
    awards: profile.awards,
  };
}

export function filterAthletes(
  athletes: AthleteDirectoryCard[],
  opts: { query?: string; gender?: Gender | null; ageGroup?: AgeGroup | null },
): AthleteDirectoryCard[] {
  const q = opts.query?.trim().toLowerCase() ?? "";
  return athletes.filter((a) => {
    if (opts.gender && a.gender !== opts.gender) return false;
    if (opts.ageGroup && a.ageGroup !== opts.ageGroup) return false;
    if (!q) return true;
    return (
      a.fullName.toLowerCase().includes(q) ||
      (a.teamName?.toLowerCase().includes(q) ?? false)
    );
  });
}

export function filterCareerResults(
  results: CareerResultView[],
  query: string,
): CareerResultView[] {
  const q = query.trim().toLowerCase();
  if (!q) return results;
  return results.filter(
    (r) =>
      r.eventName.toLowerCase().includes(q) ||
      r.stroke.toLowerCase().includes(q) ||
      r.volumeName.toLowerCase().includes(q) ||
      (r.outcome ?? "").includes(q),
  );
}

export async function fetchAthleteDirectory(): Promise<AthleteDirectoryCard[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("athletes")
      .select(
        "id, age, age_group, gender, users ( full_name, profile_image_url ), teams ( name ), awards ( id, award_type, category, gender, meet_volumes ( volume_number, name ) ), entries ( id )",
      )
      .order("age", { ascending: true });
    if (error || !data?.length) {
      return DEMO_ATHLETES.map(toDirectoryCard);
    }

    type DirectoryRow = {
      id: string;
      age: number;
      age_group: AgeGroup;
      gender: Gender;
      users: { full_name: string; profile_image_url: string | null } | { full_name: string; profile_image_url: string | null }[] | null;
      teams: { name: string } | { name: string }[] | null;
      awards: Array<{
        id: string;
        award_type: AwardType;
        category: AgeGroup;
        gender: Gender;
        meet_volumes: { volume_number: number; name: string } | { volume_number: number; name: string }[] | null;
      }> | null;
      entries: Array<{ id: string }> | null;
    };

    return (data as unknown as DirectoryRow[]).map((row) => {
      const user = firstOf(row.users);
      const team = firstOf(row.teams);
      const awardsRaw = row.awards ?? [];
      const entries = row.entries ?? [];
      return {
        id: row.id,
        fullName: user?.full_name ?? "Athlete",
        age: row.age,
        ageGroup: row.age_group,
        gender: row.gender,
        teamName: team?.name ?? null,
        profileImageUrl: user?.profile_image_url ?? null,
        eventsSwum: entries.length,
        awards: awardsRaw.map((aw) => {
          const vol = firstOf(aw.meet_volumes);
          return {
            id: aw.id,
            awardType: aw.award_type,
            category: aw.category,
            gender: aw.gender,
            volumeNumber: vol?.volume_number ?? 0,
            volumeName: vol?.name ?? "SSC",
          };
        }),
      };
    });
  } catch {
    return DEMO_ATHLETES.map(toDirectoryCard);
  }
}

export async function fetchAthleteProfile(athleteId: string): Promise<AthleteProfileView | null> {
  const demo = DEMO_ATHLETES.find((a) => a.id === athleteId);
  try {
    const supabase = createClient();
    const { data: athlete, error } = await supabase
      .from("athletes")
      .select("id, age, age_group, gender, date_of_birth, users ( full_name, profile_image_url ), teams ( name )")
      .eq("id", athleteId)
      .maybeSingle();
    if (error || !athlete) return demo ?? null;

    type AthleteEmbed = {
      id: string;
      age: number;
      age_group: AgeGroup;
      gender: Gender;
      date_of_birth: string;
      users: { full_name: string; profile_image_url: string | null } | { full_name: string; profile_image_url: string | null }[] | null;
      teams: { name: string } | { name: string }[] | null;
    };
    const athleteRow = athlete as unknown as AthleteEmbed;
    const user = firstOf(athleteRow.users);
    const team = firstOf(athleteRow.teams);

    const { data: awardsData } = await supabase
      .from("awards")
      .select("id, award_type, category, gender, meet_volumes ( volume_number, name )")
      .eq("athlete_id", athleteId);

    const { data: seriesData } = await supabase
      .from("series_leaderboards")
      .select("*")
      .eq("athlete_id", athleteId);

    // Query from entries (has athlete_id directly) rather than results, so
    // there's no nested-relationship filter to get wrong — the WHERE clause
    // applies at the top level and everything else is just embedding.
    const { data: entryData } = await supabase
      .from("entries")
      .select(
        "id, events ( name, stroke, distance_m, sessions ( meet_volumes ( volume_number, name, meet_date ) ) ), heat_lanes ( results ( id, result_outcome, official_time_ms, finish_place, dq_code, status, created_at ) )",
      )
      .eq("athlete_id", athleteId);

    type CareerVolumeEmbed = { volume_number: number; name: string; meet_date: string | null };
    type CareerEventEmbed = {
      name: string;
      stroke: string;
      distance_m: number;
      sessions:
        | { meet_volumes: CareerVolumeEmbed | CareerVolumeEmbed[] | null }
        | { meet_volumes: CareerVolumeEmbed | CareerVolumeEmbed[] | null }[]
        | null;
    };
    type CareerResultEmbed = {
      id: string;
      result_outcome: ResultOutcome | null;
      official_time_ms: number | null;
      finish_place: number | null;
      dq_code: DqReason | null;
      status: string;
      created_at: string;
    };
    type CareerEntryRow = {
      id: string;
      events: CareerEventEmbed | CareerEventEmbed[] | null;
      heat_lanes: Array<{ results: CareerResultEmbed | CareerResultEmbed[] | null }> | null;
    };

    const careerResults: CareerResultView[] = [];
    const pbMap = new Map<string, PersonalBestView>();

    for (const row of (entryData ?? []) as unknown as CareerEntryRow[]) {
      const event = firstOf(row.events);
      if (!event) continue;
      const session = firstOf(event.sessions);
      const volume = session ? firstOf(session.meet_volumes) : null;

      // Age AT THIS VOLUME's meet_date — never the athlete's current age.
      // Falls back to their present age if the volume has no date yet.
      const ageAtSwim = volume?.meet_date
        ? calculateAge(athleteRow.date_of_birth, volume.meet_date)
        : athleteRow.age;

      for (const lane of row.heat_lanes ?? []) {
        const result = firstOf(lane.results);
        if (!result || result.status !== "published") continue;

        careerResults.push({
          id: result.id,
          volumeName: volume?.name ?? "SSC",
          volumeNumber: volume?.volume_number ?? 0,
          eventName: event.name,
          stroke: event.stroke,
          distanceM: event.distance_m,
          officialTimeMs: result.official_time_ms,
          finishPlace: result.finish_place,
          splitTimeMs: null,
          outcome: result.result_outcome,
          dqCode: result.dq_code,
          swamAt: result.created_at,
          ageAtSwim,
        });

        if (result.result_outcome === "valid" && result.official_time_ms != null) {
          const key = `${event.stroke}-${event.distance_m}`;
          const existing = pbMap.get(key);
          if (!existing || result.official_time_ms < existing.bestTimeMs) {
            pbMap.set(key, {
              stroke: event.stroke,
              distanceM: event.distance_m,
              bestTimeMs: result.official_time_ms,
              volumeName: volume?.name,
              ageAtSwim,
            });
          }
        }
      }
    }

    careerResults.sort((a, b) => (a.swamAt < b.swamAt ? 1 : -1));

    type AwardEmbed = {
      id: string;
      award_type: AwardType;
      category: AgeGroup;
      gender: Gender;
      meet_volumes: { volume_number: number; name: string } | { volume_number: number; name: string }[] | null;
    };

    const awards: AthleteAwardView[] = ((awardsData ?? []) as unknown as AwardEmbed[]).map((aw) => {
      const vol = firstOf(aw.meet_volumes);
      return {
        id: aw.id,
        awardType: aw.award_type,
        category: aw.category,
        gender: aw.gender,
        volumeNumber: vol?.volume_number ?? 0,
        volumeName: vol?.name ?? "SSC",
      };
    });

    const seriesStandings: SeriesStandingView[] = (seriesData ?? []).map((s) => ({
      category: s.category,
      placementRank: null,
      improvementRank: null,
      placementPoints: Number(s.placement_points),
      improvementPoints: Number(s.improvement_points),
      volumesCounted: Number(s.volumes_counted),
    }));

    return {
      id: athleteRow.id,
      fullName: user?.full_name ?? "Athlete",
      age: athleteRow.age,
      ageGroup: athleteRow.age_group,
      gender: athleteRow.gender,
      teamName: team?.name ?? null,
      profileImageUrl: user?.profile_image_url ?? null,
      awards,
      seriesStandings,
      personalBests: [...pbMap.values()],
      careerResults,
    };
  } catch {
    return demo ?? null;
  }
}
