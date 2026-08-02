import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import { describeError, failure, ok, runQuery, type FetchResult } from "@/lib/fetch-policy";
import type { TeamRow } from "@/lib/supabase/types";

export interface TeamCreateInput {
  name: string;
  abbreviation?: string | null;
  teamLogoUrl?: string | null;
  captainId: string;
}

export interface TeamCreateInsertPayload {
  name: string;
  abbreviation: string | null;
  team_logo_url: string | null;
  captain_id: string;
  approved_by_admin: false;
}

/** Teams exist permanently, independent of any meet volume, and always
 * start pending admin approval — never self-approved. */
export function buildTeamCreateInsert(input: TeamCreateInput): TeamCreateInsertPayload {
  return {
    name: input.name.trim(),
    abbreviation: input.abbreviation?.trim() || null,
    team_logo_url: input.teamLogoUrl?.trim() || null,
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

/** The public team directory grid — always approved-only, regardless of
 * viewer role. Pending teams surface separately via fetchPendingTeams(),
 * in the admin approval queue, never mixed into the public listing. */
export async function fetchTeams(): Promise<FetchResult<TeamRow[]>> {
  return runQuery<TeamRow[]>(
    "Loading the team directory",
    async () => {
      const supabase = createClient();
      return supabase
        .from("teams")
        .select("*")
        .eq("approved_by_admin", true)
        .order("name", { ascending: true });
    },
    { empty: [] },
  );
}

/** Admin-only queue — RLS (admins_full_access_teams) already restricts this
 * to admins; non-admin callers simply get an empty list back. */
export async function fetchPendingTeams(): Promise<FetchResult<TeamRow[]>> {
  return runQuery<TeamRow[]>(
    "Loading pending team approvals",
    async () => {
      const supabase = createClient();
      return supabase
        .from("teams")
        .select("*")
        .eq("approved_by_admin", false)
        .order("created_at", { ascending: true });
    },
    { empty: [] },
  );
}

/** The team a signed-in Coach manages, via teams.captain_id = auth.uid() —
 * independent of the role column (see supabase/schema.sql's user_role
 * comment: a coach stays 'coach' even while also serving as a team's
 * captain). Null if this coach doesn't captain any team yet. */
export async function fetchMyManagedTeam(): Promise<FetchResult<TeamRow | null>> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // Signed out is a legitimate state, not a failure.
    if (!user) return ok(null);
    return await runQuery<TeamRow | null>(
      "Loading the team you manage",
      async () => supabase.from("teams").select("*").eq("captain_id", user.id).maybeSingle(),
      { empty: null },
    );
  } catch (err) {
    return failure(`Loading the team you manage: ${String(err)}`, null);
  }
}

export interface MyAthleteSummary {
  athleteId: string;
  ageGroup: string;
  teamId: string | null;
}

/** The signed-in user's own athlete row (age group + current team), if
 * they're an athlete — drives team-creation eligibility (Open-only) and the
 * "Request to Join Team" button's state on the Teams page. Null for
 * non-athlete roles or signed-out visitors. */
export async function fetchMyAthleteSummary(): Promise<FetchResult<MyAthleteSummary | null>> {
  try {
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // Signed out, or a coach/parent/admin with no athlete row — both are
    // legitimate "no summary" states, not failures.
    if (!user) return ok(null);
    const result = await runQuery<{ id: string; age_group: string; team_id: string | null } | null>(
      "Loading your athlete profile",
      async () =>
        supabase.from("athletes").select("id, age_group, team_id").eq("user_id", user.id).maybeSingle(),
      { empty: null },
    );
    if (result.error || !result.data) return { ...result, data: null };
    return {
      ...result,
      data: {
        athleteId: result.data.id,
        ageGroup: result.data.age_group,
        teamId: result.data.team_id,
      },
    };
  } catch (err) {
    return failure(`Loading your athlete profile: ${String(err)}`, null);
  }
}

export async function approveTeam(teamId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("teams").update({ approved_by_admin: true }).eq("id", teamId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** "Reject" deletes the pending team outright — teams only exist once
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
  /** null when the viewer is not permitted to see it (see visible_contacts). */
  email: string | null;
  phone: string | null;
}

export interface TeamRosterMember {
  athleteId: string;
  fullName: string;
  ageGroup: string;
  gender: string;
  /** null when the viewer is not permitted to see it (see visible_contacts). */
  email: string | null;
  phone: string | null;
}

export interface TeamDetail {
  captain: TeamCaptainContact | null;
  roster: TeamRosterMember[];
}

/** Team profile detail — captain contact + current member roster (athletes
 * whose current team_id is this team; independent of any single volume's
 * representation, which volume_team_affiliations tracks separately). */
export async function fetchTeamDetail(teamId: string): Promise<FetchResult<TeamDetail>> {
  const EMPTY: TeamDetail = { captain: null, roster: [] };
  try {
    const supabase = createClient();
    const [
      { data: team, error: teamError },
      { data: roster, error: rosterError },
    ] = await Promise.all([
      // NOTE: email/phone are deliberately NOT selected here. Contact
      // details are privacy-gated and only ever come back through
      // public.visible_contacts() below — embedding them in this query would
      // ship every roster member's phone number to every viewer's browser
      // regardless of who they are.
      supabase.from("teams").select("captain_id, users ( id, full_name )").eq("id", teamId).maybeSingle(),
      supabase
        .from("athletes")
        // Qualify the FK — athletes has two (user_id and parent_id), so a
        // bare "users(...)" embed is ambiguous to PostgREST (PGRST201).
        .select("id, age_group, gender, users!athletes_user_id_fkey ( id, full_name )")
        .eq("team_id", teamId),
    ]);

    // Either half failing means the modal would render a misleadingly empty
    // roster / missing captain, so surface it rather than silently degrade.
    if (teamError || rosterError) {
      return failure(
        describeError("Loading team roster", teamError ?? rosterError),
        EMPTY,
      );
    }

    type RawUserRef = { id: string; full_name: string };
    type RawTeam = {
      captain_id: string | null;
      users: RawUserRef | RawUserRef[] | null;
    };
    type RawMember = {
      id: string;
      age_group: string;
      gender: string;
      users: RawUserRef | RawUserRef[] | null;
    };

    const rawTeam = team as unknown as RawTeam | null;
    const captainUser = rawTeam ? firstOf(rawTeam.users) : null;
    const rawMembers = (roster ?? []) as unknown as RawMember[];

    // One round trip for every contact the viewer is actually allowed to see.
    const userIds = [
      ...(captainUser ? [captainUser.id] : []),
      ...rawMembers.map((r) => firstOf(r.users)?.id).filter((id): id is string => !!id),
    ];
    const contacts = new Map<string, { email: string | null; phone: string | null }>();
    if (userIds.length > 0) {
      const { data: visible } = await supabase.rpc("visible_contacts", { p_user_ids: userIds });
      for (const row of visible ?? []) {
        contacts.set(row.user_id, { email: row.email, phone: row.phone });
      }
    }

    const captain =
      rawTeam?.captain_id && captainUser
        ? {
            fullName: captainUser.full_name,
            email: contacts.get(captainUser.id)?.email ?? null,
            phone: contacts.get(captainUser.id)?.phone ?? null,
          }
        : null;

    const members = rawMembers.map((row) => {
      const user = firstOf(row.users);
      const contact = user ? contacts.get(user.id) : undefined;
      return {
        athleteId: row.id,
        fullName: user?.full_name ?? "Athlete",
        ageGroup: row.age_group,
        gender: row.gender,
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
      };
    });

    return ok({ captain, roster: members });
  } catch (err) {
    return failure(describeError("Loading team roster", err), EMPTY);
  }
}

interface RawAffiliationRow {
  team_id: string | null;
  meet_volumes: { volume_number: number; name: string } | { volume_number: number; name: string }[] | null;
  teams: { name: string } | { name: string }[] | null;
}

export async function fetchTeamHistoryForAthlete(
  athleteId: string,
): Promise<FetchResult<TeamHistoryEntry[]>> {
  const result = await runQuery<RawAffiliationRow[]>(
    "Loading team history",
    async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("volume_team_affiliations")
        .select("team_id, meet_volumes ( volume_number, name ), teams ( name )")
        .eq("athlete_id", athleteId);
      return { data: data as unknown as RawAffiliationRow[] | null, error };
    },
    { empty: [] },
  );

  return {
    ...result,
    data: result.data.map((row) => {
      const volume = firstOf(row.meet_volumes);
      const team = firstOf(row.teams);
      return {
        volumeNumber: volume?.volume_number ?? 0,
        volumeName: volume?.name ?? "SSC",
        teamId: row.team_id,
        teamName: team?.name ?? null,
      };
    }),
  };
}
