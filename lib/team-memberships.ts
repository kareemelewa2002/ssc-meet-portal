import { createClient } from "@/lib/supabase/client";
import { resolveUserId } from "@/lib/auth-user";
import { firstOf } from "@/lib/live-heats";
import type { MembershipStatus } from "@/lib/supabase/types";

export interface JoinRequestResult {
  success: boolean;
  error?: string;
}

/** Inserts a 'pending' team_memberships row. All the actual business rules
 * (single pending request platform-wide, transfer lock while a meet is in
 * progress) are enforced server-side by
 * public.enforce_team_membership_request_rules() — this is a thin wrapper
 * that just surfaces that trigger's error message. */
export async function requestToJoinTeam(
  teamId: string,
  userId?: string,
): Promise<JoinRequestResult> {
  const supabase = createClient();
  const uid = await resolveUserId(supabase, userId);
  if (!uid) return { success: false, error: "Sign in to request to join a team." };

  const { error } = await supabase
    .from("team_memberships")
    .insert({ team_id: teamId, user_id: uid, status: "pending" });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Cancels the caller's own pending request (RLS: user_id = auth.uid()). */
export async function cancelJoinRequest(membershipId: string): Promise<JoinRequestResult> {
  const supabase = createClient();
  const { error } = await supabase.from("team_memberships").delete().eq("id", membershipId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export interface MyJoinRequest {
  id: string;
  teamId: string;
  teamName: string;
  status: MembershipStatus;
  requestedAt: string;
}

/** The signed-in user's own pending request, if any — used to disable
 * "Request to Join" elsewhere and drive a "Pending at X" status chip. */
export async function fetchMyJoinRequest(userId?: string): Promise<MyJoinRequest | null> {
  try {
    const supabase = createClient();
    const uid = await resolveUserId(supabase, userId);
    if (!uid) return null;
    const { data, error } = await supabase
      .from("team_memberships")
      .select("id, team_id, status, requested_at, teams ( name )")
      .eq("user_id", uid)
      .eq("status", "pending")
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as {
      id: string;
      team_id: string;
      status: MembershipStatus;
      requested_at: string;
      teams: { name: string } | { name: string }[] | null;
    };
    return {
      id: row.id,
      teamId: row.team_id,
      teamName: firstOf(row.teams)?.name ?? "Team",
      status: row.status,
      requestedAt: row.requested_at,
    };
  } catch {
    return null;
  }
}

export interface TeamJoinRequest {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  requestedAt: string;
}

/** A team captain's pending-request queue (RLS: is_team_captain_of(team_id)). */
export async function fetchTeamJoinRequests(teamId: string): Promise<TeamJoinRequest[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("team_memberships")
      .select("id, user_id, requested_at, users ( full_name, email )")
      .eq("team_id", teamId)
      .eq("status", "pending")
      .order("requested_at", { ascending: true });
    if (error || !data) return [];
    type RawRow = {
      id: string;
      user_id: string;
      requested_at: string;
      users: { full_name: string; email: string } | { full_name: string; email: string }[] | null;
    };
    return (data as unknown as RawRow[]).map((row) => {
      const user = firstOf(row.users);
      return {
        id: row.id,
        userId: row.user_id,
        fullName: user?.full_name ?? "Athlete",
        email: user?.email ?? "—",
        requestedAt: row.requested_at,
      };
    });
  } catch {
    return [];
  }
}

/** Accept moves the athlete onto the roster (public.athletes.team_id is
 * synced server-side by sync_athlete_team_on_membership_accept()). Reject
 * deletes the row outright — same "no persisted rejected state" convention
 * as public.rejectTeam() — freeing the requester to apply elsewhere. */
export async function respondToJoinRequest(
  membershipId: string,
  decision: "accept" | "reject",
): Promise<JoinRequestResult> {
  const supabase = createClient();
  const { error } =
    decision === "accept"
      ? await supabase.from("team_memberships").update({ status: "accepted" }).eq("id", membershipId)
      : await supabase.from("team_memberships").delete().eq("id", membershipId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * True while any meet volume is 'scheduled' — the window in which
 * public.enforce_team_membership_request_rules() refuses transfers for an
 * athlete who already has a team.
 *
 * Surfacing this in the UI turns a confusing failure ("Request to Join" →
 * error toast) into an explained state ("Transfers Locked"), which is the
 * difference between the rule feeling like a bug and feeling like a rule.
 */
export async function fetchTransfersLocked(): Promise<boolean> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("meet_in_progress");
    if (error) return false;
    return data === true;
  } catch {
    return false;
  }
}
