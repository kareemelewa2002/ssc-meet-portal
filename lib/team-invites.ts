import { createClient } from "@/lib/supabase/client";
import { resolveUserId } from "@/lib/auth-user";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { firstOf } from "@/lib/live-heats";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// Two DIFFERENT invite directions, both landing in schema.sql's captaincy
// domain (public.team_invite_links, team_memberships.status = 'invited'):
//
//   1. A shareable URL for someone with NO account yet — one reusable link
//      per team, redeemed at registration (see app/register/page.tsx),
//      auto-joins with no separate approval step since the captain already
//      approved by sending the link.
//   2. An in-app invite to an EXISTING, unattached athlete — creates a
//      team_memberships row the invitee must actually accept/decline
//      themselves (captain_invite_to_membership / invitee_accept_own_
//      invitation RLS policies), the opposite direction from
//      lib/team-memberships.ts's athlete-initiated 'pending' requests.
// ---------------------------------------------------------------------------

export interface TeamInviteLink {
  id: string;
  token: string;
  createdAt: string;
  useCount: number;
}

/** The team's one active (non-revoked) invite link, if it has one. */
export async function fetchActiveInviteLink(teamId: string): Promise<TeamInviteLink | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("team_invite_links")
      .select("id, token, created_at, use_count")
      .eq("team_id", teamId)
      .is("revoked_at", null)
      .maybeSingle();
    if (error || !data) return null;
    return { id: data.id, token: data.token, createdAt: data.created_at, useCount: data.use_count };
  } catch {
    return null;
  }
}

/** Generates a new link, revoking whatever link the team already had (see
 * public.create_team_invite_link — one active link per team, not a growing
 * pile). Returns the full shareable registration URL. */
export async function createTeamInviteLink(
  teamId: string,
  origin: string,
): Promise<FetchResult<string | null>> {
  const supabase = createClient();
  const result = await runQuery<string>(
    "Creating a team invite link",
    async () => {
      const { data, error } = await supabase.rpc("create_team_invite_link", { p_team_id: teamId });
      return { data, error };
    },
    { empty: "" },
  );
  if (result.error || !result.data) return { ...result, data: null };
  return { ...result, data: `${origin}/register?invite=${result.data}` };
}

/** Revokes the team's active invite link — it stops working immediately,
 * but past uses are not undone (nobody who already joined is removed). */
export async function revokeTeamInviteLink(linkId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("team_invite_links")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", linkId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** The team name a token leads to, for "You're joining X" copy on the
 * registration form — read-only, does not consume the token. Actual
 * redemption happens server-side inside public.handle_new_auth_user() at
 * signup time (see lib/register.ts), not from the client. */
export async function previewTeamInviteToken(token: string): Promise<string | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("preview_team_invite_token", { p_token: token });
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

export interface UnattachedAthleteResult {
  athleteId: string;
  /** team_memberships.user_id references public.users, not athletes — this
   * is what inviteAthleteToTeam() actually needs, not athleteId above. */
  userId: string;
  fullName: string;
  ageGroup: AgeGroup;
  gender: Gender;
}

/** Athletes with no current team, matching a name search — the pool a
 * captain may pick from for an in-app invite. Scoped to unattached athletes
 * only: an athlete already on a team cannot be double-invited, and
 * public.enforce_team_membership_request_rules() would reject the insert
 * anyway (defense in depth, this is just the UI-facing half of that rule).
 *
 * Fetches every unattached athlete and filters by name IN JS, rather than
 * `.ilike("users.full_name", …)` on the embed — confirmed by direct testing
 * against this project's PostgREST endpoint that an ilike filter on an
 * embedded table here silently collapses the WHOLE embed to null on every
 * row (not just non-matches), which made every result render as "Athlete"
 * and then fail the client-side name filter too. This is the same
 * fetch-broadly-filter-client-side pattern lib/athletes.ts's career-results
 * query already uses for the identical reason (see its own comment) — this
 * codebase's hand-maintained Database type carries no FK relationship
 * metadata for PostgREST to resolve an embedded filter against. */
export async function searchUnattachedAthletes(query: string): Promise<UnattachedAthleteResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("athletes")
      .select("id, user_id, age_group, gender, users!athletes_user_id_fkey ( full_name )")
      .is("team_id", null);
    if (error || !data) return [];
    type RawRow = {
      id: string;
      user_id: string;
      age_group: AgeGroup;
      gender: Gender;
      users: { full_name: string } | { full_name: string }[] | null;
    };
    const needle = trimmed.toLowerCase();
    return (data as unknown as RawRow[])
      .map((row) => ({
        athleteId: row.id,
        userId: row.user_id,
        fullName: firstOf(row.users)?.full_name ?? "Athlete",
        ageGroup: row.age_group,
        gender: row.gender,
      }))
      .filter((r) => r.fullName.toLowerCase().includes(needle))
      .slice(0, 10);
  } catch {
    return [];
  }
}

/** Sends a direct in-app invite to an unattached athlete (by their user_id,
 * not athlete_id — team_memberships.user_id references public.users). */
export async function inviteAthleteToTeam(
  teamId: string,
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("team_memberships")
    .insert({ team_id: teamId, user_id: userId, status: "invited" });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Revokes a not-yet-answered invite the captain sent (delete is allowed
 * for either party regardless of status — see
 * captain_or_requester_delete_membership). */
export async function revokeInvitation(membershipId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("team_memberships").delete().eq("id", membershipId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export interface SentInvitation {
  id: string;
  userId: string;
  fullName: string;
  requestedAt: string;
}

/** The captain's outgoing, not-yet-answered direct invites for one team —
 * the "pending invitations" list. Deliberately separate from
 * fetchTeamJoinRequests() (lib/team-memberships.ts), which is the opposite
 * direction (athletes requesting to join). */
export async function fetchSentInvitations(teamId: string): Promise<SentInvitation[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("team_memberships")
      .select("id, user_id, requested_at, users ( full_name )")
      .eq("team_id", teamId)
      .eq("status", "invited")
      .order("requested_at", { ascending: true });
    if (error || !data) return [];
    type RawRow = {
      id: string;
      user_id: string;
      requested_at: string;
      users: { full_name: string } | { full_name: string }[] | null;
    };
    return (data as unknown as RawRow[]).map((row) => ({
      id: row.id,
      userId: row.user_id,
      fullName: firstOf(row.users)?.full_name ?? "Athlete",
      requestedAt: row.requested_at,
    }));
  } catch {
    return [];
  }
}

export interface MyIncomingInvitation {
  id: string;
  teamId: string;
  teamName: string;
  requestedAt: string;
}

/** The signed-in athlete's own incoming invite awaiting a response, if any
 * — the mirror of fetchMyJoinRequest() (lib/team-memberships.ts), which is
 * the athlete's own OUTGOING request instead. */
export async function fetchMyIncomingInvitation(
  userId?: string,
): Promise<MyIncomingInvitation | null> {
  try {
    const supabase = createClient();
    const uid = await resolveUserId(supabase, userId);
    if (!uid) return null;
    const { data, error } = await supabase
      .from("team_memberships")
      .select("id, team_id, requested_at, teams ( name )")
      .eq("user_id", uid)
      .eq("status", "invited")
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as {
      id: string;
      team_id: string;
      requested_at: string;
      teams: { name: string } | { name: string }[] | null;
    };
    return {
      id: row.id,
      teamId: row.team_id,
      teamName: firstOf(row.teams)?.name ?? "Team",
      requestedAt: row.requested_at,
    };
  } catch {
    return null;
  }
}

/** Accept syncs athletes.team_id server-side (the same
 * sync_athlete_team_on_membership_accept trigger the athlete-initiated flow
 * uses). Decline deletes the row — matching the "no persisted rejected
 * state" convention every other response in this domain already follows. */
export async function respondToInvitation(
  membershipId: string,
  decision: "accept" | "decline",
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } =
    decision === "accept"
      ? await supabase.from("team_memberships").update({ status: "accepted" }).eq("id", membershipId)
      : await supabase.from("team_memberships").delete().eq("id", membershipId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
