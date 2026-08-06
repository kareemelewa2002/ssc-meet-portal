import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { firstOf } from "@/lib/live-heats";

// ---------------------------------------------------------------------------
// Team announcements — captain-authored, team-wide messages.
//
// Read access is athletes.team_id, NOT team_memberships.status = 'accepted'.
// team_memberships is a one-time join-REQUEST record; accepting one SYNCS
// athletes.team_id and the membership row becomes history, not a live one.
// Most of a real roster was assigned directly and has no team_memberships
// row at all. RLS on public.team_announcements already enforces this
// correctly (see schema.sql) — this file does not re-derive the rule, it
// just reads what RLS already scoped.
// ---------------------------------------------------------------------------

export interface TeamAnnouncement {
  id: string;
  teamId: string;
  authorId: string | null;
  authorName: string | null;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

type RawAnnouncementRow = {
  id: string;
  team_id: string;
  author_id: string | null;
  title: string;
  body: string;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  users: { full_name: string } | { full_name: string }[] | null;
};

function toAnnouncement(row: RawAnnouncementRow): TeamAnnouncement {
  return {
    id: row.id,
    teamId: row.team_id,
    authorId: row.author_id,
    authorName: firstOf(row.users)?.full_name ?? null,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A team's announcement feed, pinned first then newest first — matches the
 * table's own index order. RLS returns nothing for a team the caller does
 * not belong to (and does not admin), so an empty result here can mean
 * either "no announcements yet" or "not your team" — both render the same
 * empty state, which is the point: this must not leak which one it is. */
export async function fetchTeamAnnouncements(
  teamId: string,
): Promise<FetchResult<TeamAnnouncement[]>> {
  const result = await runQuery<RawAnnouncementRow[]>(
    "Loading team announcements",
    async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("team_announcements")
        .select(
          "id, team_id, author_id, title, body, pinned, created_at, updated_at, users:author_id ( full_name )",
        )
        .eq("team_id", teamId)
        .order("pinned", { ascending: false })
        .order("created_at", { ascending: false });
      // Cast: no declared FK relationship metadata in this hand-maintained
      // Database type for team_announcements -> users, same limitation as
      // fetchTeamSquads() in lib/relays.ts.
      return { data: data as unknown as RawAnnouncementRow[] | null, error };
    },
    { empty: [] },
  );

  return { ...result, data: result.data.map(toAnnouncement) };
}

/** Posts a new announcement. Captain-or-admin only at the RLS layer — this
 * call is a silent no-op (0 rows, no error) for anyone else, same as every
 * other captain-only write in this app. Fans out to every current team
 * member's own notification feed automatically (a database trigger, not
 * something this function does itself). */
export async function postTeamAnnouncement(input: {
  teamId: string;
  authorId: string;
  title: string;
  body: string;
  pinned?: boolean;
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("team_announcements").insert({
    team_id: input.teamId,
    author_id: input.authorId,
    title: input.title,
    body: input.body,
    pinned: input.pinned ?? false,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Toggling pinned or editing text does NOT re-notify the team — only the
 * original post does (public.notify_team_announcement() fires on INSERT
 * only). A captain fixing a typo must not spam the whole roster again. */
export async function updateTeamAnnouncement(
  id: string,
  changes: { title?: string; body?: string; pinned?: boolean },
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("team_announcements").update(changes).eq("id", id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function deleteTeamAnnouncement(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("team_announcements").delete().eq("id", id);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
