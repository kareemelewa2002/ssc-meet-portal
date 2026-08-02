import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import type { TeamRow } from "@/lib/supabase/types";

export interface TeamCreateInput {
  name: string;
  abbreviation?: string | null;
  clubLogoUrl?: string | null;
  captainId: string;
}

export interface TeamCreateInsertPayload {
  name: string;
  abbreviation: string | null;
  club_logo_url: string | null;
  captain_id: string;
  approved_by_admin: false;
}

/** Teams exist permanently, independent of any meet volume, and always
 * start pending admin approval — never self-approved. */
export function buildTeamCreateInsert(input: TeamCreateInput): TeamCreateInsertPayload {
  return {
    name: input.name.trim(),
    abbreviation: input.abbreviation?.trim() || null,
    club_logo_url: input.clubLogoUrl?.trim() || null,
    captain_id: input.captainId,
    approved_by_admin: false,
  };
}

export interface TeamHistoryEntry {
  volumeNumber: number;
  volumeName: string;
  teamId: string | null;
  teamName: string | null;
}

/** "Blue Marlins (Vol. 1) → Riptide (Vol. 2)" — or a single team's name if
 * the athlete never transferred. Ordered oldest volume first. */
export function summarizeTeamHistory(history: TeamHistoryEntry[]): string {
  const sorted = [...history].sort((a, b) => a.volumeNumber - b.volumeNumber);
  return sorted
    .map((h) => `${h.teamName ?? "Unattached"} (Vol. ${h.volumeNumber})`)
    .join(" → ");
}

/** True once an athlete has represented more than one distinct team (or
 * unattached vs. a team) across recorded volumes. */
export function didTransferTeams(history: TeamHistoryEntry[]): boolean {
  const distinctTeams = new Set(history.map((h) => h.teamId ?? "unattached"));
  return distinctTeams.size > 1;
}

/** The public club directory grid — always approved-only, regardless of
 * viewer role. Pending clubs surface separately via fetchPendingTeams(),
 * in the admin approval queue, never mixed into the public listing. */
export async function fetchTeams(): Promise<TeamRow[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("teams")
      .select("*")
      .eq("approved_by_admin", true)
      .order("name", { ascending: true });
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

/** Admin-only queue — RLS (admins_full_access_teams) already restricts this
 * to admins; non-admin callers simply get an empty list back. */
export async function fetchPendingTeams(): Promise<TeamRow[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("teams")
      .select("*")
      .eq("approved_by_admin", false)
      .order("created_at", { ascending: true });
    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

/** The club a signed-in Coach manages, via teams.captain_id = auth.uid() —
 * independent of the role column (see supabase/schema.sql's user_role
 * comment: a coach stays 'coach' even while also serving as a team's
 * captain). Null if this coach doesn't captain any club yet. */
export async function fetchMyManagedTeam(): Promise<TeamRow | null> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data, error } = await supabase
      .from("teams")
      .select("*")
      .eq("captain_id", user.id)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch {
    return null;
  }
}

export async function approveTeam(teamId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("teams").update({ approved_by_admin: true }).eq("id", teamId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** "Reject" deletes the pending club outright — teams only exist once
 * approved; there's no separate "rejected" state to persist. */
export async function rejectTeam(teamId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("teams").delete().eq("id", teamId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function createTeam(input: TeamCreateInput): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("teams").insert(buildTeamCreateInsert(input));
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export interface TeamCaptainContact {
  fullName: string;
  email: string;
  phone: string | null;
}

export interface TeamRosterMember {
  athleteId: string;
  fullName: string;
  ageGroup: string;
  gender: string;
}

export interface TeamDetail {
  captain: TeamCaptainContact | null;
  roster: TeamRosterMember[];
}

/** Club profile detail — captain contact + current member roster (athletes
 * whose current team_id is this club; independent of any single volume's
 * representation, which volume_team_affiliations tracks separately). */
export async function fetchTeamDetail(teamId: string): Promise<TeamDetail> {
  try {
    const supabase = createClient();
    const [{ data: team }, { data: roster }] = await Promise.all([
      supabase.from("teams").select("captain_id, users ( full_name, email, phone )").eq("id", teamId).maybeSingle(),
      supabase
        .from("athletes")
        // Qualify the FK — athletes has two (user_id and parent_id), so a
        // bare "users(...)" embed is ambiguous to PostgREST (PGRST201).
        .select("id, age_group, gender, users!athletes_user_id_fkey ( full_name )")
        .eq("team_id", teamId),
    ]);

    type RawTeam = {
      captain_id: string | null;
      users: { full_name: string; email: string; phone: string | null } | { full_name: string; email: string; phone: string | null }[] | null;
    };
    type RawMember = {
      id: string;
      age_group: string;
      gender: string;
      users: { full_name: string } | { full_name: string }[] | null;
    };

    const rawTeam = team as unknown as RawTeam | null;
    const captainUser = rawTeam ? firstOf(rawTeam.users) : null;
    const captain =
      rawTeam?.captain_id && captainUser
        ? { fullName: captainUser.full_name, email: captainUser.email, phone: captainUser.phone }
        : null;

    const members = ((roster ?? []) as unknown as RawMember[]).map((row) => {
      const user = firstOf(row.users);
      return {
        athleteId: row.id,
        fullName: user?.full_name ?? "Athlete",
        ageGroup: row.age_group,
        gender: row.gender,
      };
    });

    return { captain, roster: members };
  } catch {
    return { captain: null, roster: [] };
  }
}

interface RawAffiliationRow {
  team_id: string | null;
  meet_volumes: { volume_number: number; name: string } | { volume_number: number; name: string }[] | null;
  teams: { name: string } | { name: string }[] | null;
}

export async function fetchTeamHistoryForAthlete(athleteId: string): Promise<TeamHistoryEntry[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("volume_team_affiliations")
      .select("team_id, meet_volumes ( volume_number, name ), teams ( name )")
      .eq("athlete_id", athleteId);
    if (error || !data) return [];

    return (data as unknown as RawAffiliationRow[]).map((row) => {
      const volume = firstOf(row.meet_volumes);
      const team = firstOf(row.teams);
      return {
        volumeNumber: volume?.volume_number ?? 0,
        volumeName: volume?.name ?? "SSC",
        teamId: row.team_id,
        teamName: team?.name ?? null,
      };
    });
  } catch {
    return [];
  }
}
