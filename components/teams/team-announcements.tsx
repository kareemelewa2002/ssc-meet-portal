"use client";

import { useEffect, useState } from "react";
import { Loader2, Megaphone, Pin, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SkeletonRow } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  fetchTeamAnnouncements,
  postTeamAnnouncement,
  deleteTeamAnnouncement,
  type TeamAnnouncement,
} from "@/lib/announcements";

/**
 * A team's announcement feed, with a compose form when the viewer captains
 * this team.
 *
 * This is rendered inside the same "View Roster & Captain Contact" dialog
 * every visitor can open for any team — including a non-member browsing the
 * team list. That is deliberate rather than worked around: RLS on
 * team_announcements already returns an empty list for anyone who is not a
 * member, the captain, or an admin, so this component needs no membership
 * check of its own before fetching. "No announcements yet" and "not your
 * team" render identically here on purpose — see the comment in
 * lib/announcements.ts.
 */
export function TeamAnnouncements({
  teamId,
  isCaptain,
  authorId,
}: {
  teamId: string;
  isCaptain: boolean;
  authorId: string | null;
}) {
  const toast = useToast();
  const [items, setItems] = useState<TeamAnnouncement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pinned, setPinned] = useState(false);
  const [posting, setPosting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    const result = await fetchTeamAnnouncements(teamId);
    setItems(result.data);
    setError(result.error);
  };

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    (async () => {
      const result = await fetchTeamAnnouncements(teamId);
      if (cancelled) return;
      setItems(result.data);
      setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const post = async () => {
    if (!authorId || !title.trim() || !body.trim()) return;
    setPosting(true);
    try {
      const res = await postTeamAnnouncement({
        teamId,
        authorId,
        title: title.trim(),
        body: body.trim(),
        pinned,
      });
      if (!res.success) throw new Error(res.error ?? "Could not post the announcement.");
      setTitle("");
      setBody("");
      setPinned(false);
      setComposing(false);
      await load();
      toast.success("Posted", "Your team has been notified.");
    } catch (err) {
      const message = getErrorMessage(err, "Could not post the announcement.");
      toast.error("Could not post", message);
    } finally {
      setPosting(false);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      const res = await deleteTeamAnnouncement(id);
      if (!res.success) throw new Error(res.error ?? "Could not delete this announcement.");
      setItems((prev) => prev?.filter((a) => a.id !== id) ?? prev);
    } catch (err) {
      toast.error("Could not delete", getErrorMessage(err, "Could not delete this announcement."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase text-muted-foreground">
          <Megaphone className="mr-1 inline size-3" />
          Announcements
        </p>
        {isCaptain && !composing && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 text-xs"
            onClick={() => setComposing(true)}
          >
            <Plus className="size-3" />
            New
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="destructive" className="mb-2">
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {isCaptain && composing && (
        <div className="mb-3 space-y-2 rounded-lg border-2 border-border-strong p-3">
          <div className="space-y-1">
            <Label htmlFor="announcement-title" className="text-xs">
              Title
            </Label>
            <Input
              id="announcement-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Practice moved to 6am"
              className="min-h-[40px]"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="announcement-body" className="text-xs">
              Message
            </Label>
            <textarea
              id="announcement-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              className="w-full rounded-md border bg-background p-2 text-sm"
              placeholder="Pool maintenance Tuesday — see you Wednesday instead."
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="size-4"
            />
            Pin this — sorts above everything else
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setComposing(false)}
              disabled={posting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={posting || !title.trim() || !body.trim()}
              onClick={() => void post()}
            >
              {posting && <Loader2 className="size-3.5 animate-spin" />}
              Post to team
            </Button>
          </div>
        </div>
      )}

      {items === null ? (
        <div className="space-y-1.5">
          {Array.from({ length: 2 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">No announcements yet.</p>
      ) : (
        <ul className="max-h-56 space-y-1.5 overflow-y-auto">
          {items.map((a) => (
            <li key={a.id} className="rounded-lg border p-2 text-sm">
              <div className="flex items-start justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 font-medium">
                  {a.pinned && <Pin className="size-3 shrink-0 text-muted-foreground" />}
                  <span className="truncate">{a.title}</span>
                </p>
                {isCaptain && (
                  <button
                    type="button"
                    aria-label={`Delete ${a.title}`}
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    disabled={busyId === a.id}
                    onClick={() => void remove(a.id)}
                  >
                    {busyId === a.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </button>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{a.body}</p>
              {a.authorName && (
                <Badge variant="outline" className="mt-1.5 text-[10px]">
                  {a.authorName}
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
