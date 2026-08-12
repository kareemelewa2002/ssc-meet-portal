import { createClient } from "@/lib/supabase/client";
import { resolveUserId } from "@/lib/auth-user";
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
/** Captain full names, keyed by team id — full_name is public everywhere
 * (unlike email/phone, which stay behind visible_contacts()), so a plain
 * embed is fine here; no separate contact-privacy query needed just to show
 * "who captains this team" on the directory grid. */
export async function fetchTeamCaptainNames(): Promise<Map<string, string>> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("teams")
      .select("id, users ( full_name )")
      .not("captain_id", "is", null);
    if (error || !data) return new Map();
    type RawRow = { id: string; users: { full_name: string } | { full_name: string }[] | null };
    return new Map(
      (data as unknown as RawRow[])
        .map((row) => [row.id, firstOf(row.users)?.full_name])
        .filter((entry): entry is [string, string] => !!entry[1]),
    );
  } catch {
    return new Map();
  }
}

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
export async function fetchMyManagedTeam(userId?: string): Promise<FetchResult<TeamRow | null>> {
  try {
    const supabase = createClient();
    const uid = await resolveUserId(supabase, userId);
    // Signed out is a legitimate state, not a failure.
    if (!uid) return ok(null);
    return await runQuery<TeamRow | null>(
      "Loading the team you manage",
      async () => supabase.from("teams").select("*").eq("captain_id", uid).maybeSingle(),
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
export async function fetchMyAthleteSummary(
  userId?: string,
): Promise<FetchResult<MyAthleteSummary | null>> {
  try {
    const supabase = createClient();
    const uid = await resolveUserId(supabase, userId);
    // Signed out, or a coach/parent/admin with no athlete row — both are
    // legitimate "no summary" states, not failures.
    if (!uid) return ok(null);
    const result = await runQuery<{ id: string; age_group: string; team_id: string | null } | null>(
      "Loading your athlete profile",
      async () =>
        supabase.from("athletes").select("id, age_group, team_id").eq("user_id", uid).maybeSingle(),
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
  /** The member's public.users id. Needed to tell the captain's OWN row apart
   * from everyone else's — a captain must not be offered a control that drops
   * themselves from the team they run. */
  userId: string | null;
  fullName: string;
  ageGroup: string;
  gender: string;
  /** null when the viewer is not permitted to see it (see visible_contacts). */
  email: string | null;
  phone: string | null;
}

export interface TeamDetail {
  captain: TeamCaptainContact | null;
  /** teams.captain_id, so a caller can match it against a roster row's
   * userId without a second query. */
  captainUserId: string | null;
  roster: TeamRosterMember[];
}

/** Team profile detail — captain contact + current member roster (athletes
 * whose current team_id is this team; independent of any single volume's
 * representation, which volume_team_affiliations tracks separately). */
export async function fetchTeamDetail(teamId: string): Promise<FetchResult<TeamDetail>> {
  const EMPTY: TeamDetail = { captain: null, captainUserId: null, roster: [] };
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
        userId: user?.id ?? null,
        fullName: user?.full_name ?? "Athlete",
        ageGroup: row.age_group,
        gender: row.gender,
        email: contact?.email ?? null,
        phone: contact?.phone ?? null,
      };
    });

    return ok({ captain, captainUserId: rawTeam?.captain_id ?? null, roster: members });
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

// ---------------------------------------------------------------------------
// Team branding — a captain editing their own team's identity.
// ---------------------------------------------------------------------------

/** Abbreviations are shown in fixed-width places (heat sheets, scoreboards,
 * result tables) where a long string would break the column, and they read as
 * a code rather than a word. */
export const TEAM_ABBREVIATION_MAX = 6;
export const TEAM_ABBREVIATION_MIN = 2;

export interface TeamBrandingInput {
  name: string;
  abbreviation: string;
  logoUrl: string;
}

/**
 * Validates and normalises a branding edit, returning either the values to
 * write or the reasons not to.
 *
 * Pure, so the same rules can be unit-tested and reused: the form shows these
 * messages inline, and the submit path re-checks rather than trusting that
 * the form did.
 */
export function validateTeamBranding(input: TeamBrandingInput): {
  ok: boolean;
  errors: string[];
  values: { name: string; abbreviation: string | null; teamLogoUrl: string | null };
} {
  const errors: string[] = [];
  const name = input.name.trim();
  // Uppercased rather than rejected for being lowercase: the requirement is
  // that stored abbreviations are uppercase, and silently fixing "rip" to
  // "RIP" is friendlier than an error for something we can correct exactly.
  const abbreviation = input.abbreviation.trim().toUpperCase();
  const logo = input.logoUrl.trim();

  if (name.length === 0) {
    errors.push("A team needs a name.");
  } else if (name.length > 60) {
    errors.push("Team name must be 60 characters or fewer.");
  }

  if (abbreviation.length > 0) {
    if (abbreviation.length < TEAM_ABBREVIATION_MIN || abbreviation.length > TEAM_ABBREVIATION_MAX) {
      errors.push(
        `Abbreviation must be ${TEAM_ABBREVIATION_MIN}–${TEAM_ABBREVIATION_MAX} characters.`,
      );
    }
    if (!/^[A-Z0-9]+$/.test(abbreviation)) {
      errors.push("Abbreviation may only contain letters and numbers.");
    }
  }

  if (logo.length > 0 && !/^https:\/\/\S+$/i.test(logo)) {
    // https only: a logo is rendered in the app, and an http URL would be
    // blocked as mixed content on a site served over https — the image would
    // simply never appear, with no error to explain why.
    errors.push("Logo URL must be a full https:// address.");
  }

  return {
    ok: errors.length === 0,
    errors,
    values: {
      name,
      // Empty means "unset", not an empty string — the column is nullable and
      // a blank abbreviation would render as an empty badge.
      abbreviation: abbreviation || null,
      teamLogoUrl: logo || null,
    },
  };
}

/**
 * Writes a captain's branding edit.
 *
 * RLS (captain_update_own_team) is the real gate: the WHERE clause below
 * cannot be trusted on its own, and a non-captain's update matches zero rows
 * rather than erroring. teams.name is UNIQUE, so a clash is reported as such
 * instead of as a generic failure.
 */
export async function updateTeamBranding(
  teamId: string,
  input: TeamBrandingInput,
): Promise<{ success: boolean; error?: string }> {
  const check = validateTeamBranding(input);
  if (!check.ok) return { success: false, error: check.errors.join(" ") };

  const supabase = createClient();
  const { error } = await supabase
    .from("teams")
    .update({
      name: check.values.name,
      abbreviation: check.values.abbreviation,
      team_logo_url: check.values.teamLogoUrl,
    })
    .eq("id", teamId);

  if (error) {
    if (error.code === "23505") {
      return { success: false, error: `Another team is already called "${check.values.name}".` };
    }
    return { success: false, error: error.message };
  }
  return { success: true };
}

/**
 * Drops a swimmer from the caller's team.
 *
 * Calls public.captain_remove_team_member() rather than deleting a
 * team_memberships row directly. The roster is athletes.team_id; a membership
 * delete would leave that column set, so the swimmer would stay on the roster
 * while the UI reported success. See the function's comment in schema.sql.
 */
export async function removeTeamMember(
  athleteId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.rpc("captain_remove_team_member", {
    p_athlete_id: athleteId,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}
