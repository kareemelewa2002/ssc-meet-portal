import { createClient } from "@/lib/supabase/client";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

export interface LeaderboardEntryView {
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  gender: Gender;
  ageGroup: AgeGroup;
  placementPoints: number;
  improvementPoints: number;
  totalPoints: number;
}

interface AthleteDetail {
  name: string;
  team: string | null;
  gender: Gender;
  ageGroup: AgeGroup;
}

interface RawAthleteDetailRow {
  id: string;
  gender: Gender;
  age_group: AgeGroup;
  users: { full_name: string } | { full_name: string }[] | null;
  teams: { name: string } | { name: string }[] | null;
}

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

async function fetchAthleteDetails(athleteIds: string[]): Promise<Map<string, AthleteDetail>> {
  const details = new Map<string, AthleteDetail>();
  if (athleteIds.length === 0) return details;

  const supabase = createClient();
  const { data, error } = await supabase
    .from("athletes")
    // Qualify the FK — athletes has two (user_id and parent_id), so a bare
    // "users(...)" embed is ambiguous to PostgREST (PGRST201). Unlike the
    // demo-fallback pattern elsewhere, this function returned an EMPTY map
    // on error, meaning this bug rendered leaderboard rows with blank
    // names/teams rather than a graceful fallback.
    .select("id, gender, age_group, users!athletes_user_id_fkey ( full_name ), teams ( name )")
    .in("id", athleteIds);

  if (error || !data) return details;

  for (const row of data as unknown as RawAthleteDetailRow[]) {
    const user = firstOf(row.users);
    const team = firstOf(row.teams);
    details.set(row.id, {
      name: user?.full_name ?? "Unknown swimmer",
      team: team?.name ?? null,
      gender: row.gender,
      ageGroup: row.age_group,
    });
  }
  return details;
}

interface RawPointsRow {
  athlete_id: string;
  placement_points: number;
  improvement_points: number;
  total_points: number;
}

async function mergeWithAthleteDetails(rows: RawPointsRow[]): Promise<LeaderboardEntryView[]> {
  const details = await fetchAthleteDetails(rows.map((r) => r.athlete_id));
  return rows
    .map((row) => {
      const detail = details.get(row.athlete_id);
      if (!detail) return null;
      return {
        athleteId: row.athlete_id,
        athleteName: detail.name,
        teamName: detail.team,
        gender: detail.gender,
        ageGroup: detail.ageGroup,
        placementPoints: row.placement_points,
        improvementPoints: row.improvement_points,
        totalPoints: row.total_points,
      };
    })
    .filter((entry): entry is LeaderboardEntryView => entry !== null);
}

/** Points for a single volume's isolated leaderboard. Empty on error falls
 * back to demo data; a genuine empty result (no results published yet) is
 * returned as-is so the UI can show an honest empty state. */
export async function fetchVolumeLeaderboard(
  volumeId: string,
  category: AgeGroup,
): Promise<LeaderboardEntryView[]> {
  if (volumeId.startsWith("demo-")) return DEMO_LEADERBOARD;

  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("leaderboards")
      .select("athlete_id, placement_points, improvement_points, total_points")
      .eq("meet_volume_id", volumeId)
      .eq("category", category);

    if (error) return DEMO_LEADERBOARD;
    if (!data || data.length === 0) return [];
    return mergeWithAthleteDetails(data);
  } catch {
    return DEMO_LEADERBOARD;
  }
}

/** Series-wide standing, summed across every volume via public.series_leaderboards. */
export async function fetchSeriesLeaderboard(category: AgeGroup): Promise<LeaderboardEntryView[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("series_leaderboards")
      .select("athlete_id, placement_points, improvement_points, total_points")
      .eq("category", category);

    if (error) return DEMO_LEADERBOARD;
    if (!data || data.length === 0) return [];
    return mergeWithAthleteDetails(data);
  } catch {
    return DEMO_LEADERBOARD;
  }
}

export interface TeamLeaderboardEntry {
  teamId: string;
  teamName: string;
  totalPoints: number;
  athleteCount: number;
}

interface RawSeriesRow {
  athlete_id: string;
  total_points: number;
}

interface RawAthleteTeamRow {
  id: string;
  team_id: string | null;
  teams: { id: string; name: string } | { id: string; name: string }[] | null;
}

/** Team Leaderboard Summary — every approved team's swimmers' series
 * total_points summed together, across every age category. Purely a
 * client-side aggregation over the existing series_leaderboards view; no
 * schema changes needed. Athletes with no team (unattached) are excluded —
 * there's no team to attribute their points to. */
export async function fetchTeamLeaderboard(): Promise<TeamLeaderboardEntry[]> {
  try {
    const supabase = createClient();
    const { data: points, error } = await supabase
      .from("series_leaderboards")
      .select("athlete_id, total_points");
    if (error || !points || points.length === 0) return [];

    const athleteIds = (points as RawSeriesRow[]).map((p) => p.athlete_id);
    const { data: athletes, error: athleteError } = await supabase
      .from("athletes")
      .select("id, team_id, teams ( id, name )")
      .in("id", athleteIds);
    if (athleteError || !athletes) return [];

    const teamByAthlete = new Map<string, { id: string; name: string }>();
    for (const row of athletes as unknown as RawAthleteTeamRow[]) {
      const team = firstOf(row.teams);
      if (team) teamByAthlete.set(row.id, team);
    }

    const totals = new Map<string, TeamLeaderboardEntry>();
    for (const row of points as RawSeriesRow[]) {
      const team = teamByAthlete.get(row.athlete_id);
      if (!team) continue;
      const existing = totals.get(team.id) ?? {
        teamId: team.id,
        teamName: team.name,
        totalPoints: 0,
        athleteCount: 0,
      };
      existing.totalPoints += row.total_points;
      existing.athleteCount += 1;
      totals.set(team.id, existing);
    }

    return [...totals.values()].sort((a, b) => b.totalPoints - a.totalPoints);
  } catch {
    return [];
  }
}

export const DEMO_LEADERBOARD: LeaderboardEntryView[] = [
  {
    athleteId: "demo-a1",
    athleteName: "Leo Fontaine",
    teamName: "Tidal Wave",
    gender: "male",
    ageGroup: "Open",
    placementPoints: 18,
    improvementPoints: 4.2,
    totalPoints: 22.2,
  },
  {
    athleteId: "demo-a2",
    athleteName: "Mia Reyes",
    teamName: "Blue Marlins",
    gender: "female",
    ageGroup: "U17",
    placementPoints: 15,
    improvementPoints: 2.8,
    totalPoints: 17.8,
  },
  {
    athleteId: "demo-a3",
    athleteName: "Noah Alvi",
    teamName: "Riptide",
    gender: "male",
    ageGroup: "U17",
    placementPoints: 12,
    improvementPoints: 1.5,
    totalPoints: 13.5,
  },
];
