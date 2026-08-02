"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, UserPlus, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchTeamJoinRequests, respondToJoinRequest, type TeamJoinRequest } from "@/lib/team-memberships";
import { useToast } from "@/hooks/use-toast";

/** A team captain's pending join-request queue — accept moves the athlete
 * onto the roster (synced server-side), reject just deletes the request so
 * the athlete is free to apply elsewhere. Only ever fetches anything for the
 * signed-in captain of `teamId` (RLS: is_team_captain_of), so it's safe to
 * mount unconditionally on any team card/modal a captain might view. */
export function TeamJoinRequests({ teamId, className }: { teamId: string; className?: string }) {
  const toast = useToast();
  const [requests, setRequests] = useState<TeamJoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setRequests(await fetchTeamJoinRequests(teamId));
    setLoading(false);
  }, [teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  const respond = async (request: TeamJoinRequest, decision: "accept" | "reject") => {
    setBusyId(request.id);
    try {
      const res = await respondToJoinRequest(request.id, decision);
      if (!res.success) {
        toast.error(
          decision === "accept" ? "Failed to accept request" : "Failed to reject request",
          res.error,
        );
        return;
      }
      setRequests((prev) => prev.filter((r) => r.id !== request.id));
      toast.success(
        decision === "accept" ? "Swimmer added to roster" : "Request rejected",
        decision === "accept" ? `${request.fullName} now appears on your team roster.` : undefined,
      );
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <p className={className}>
        <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
        <span className="text-xs text-muted-foreground">Checking join requests…</span>
      </p>
    );
  }

  if (requests.length === 0) return null;

  return (
    <div className={className}>
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase text-muted-foreground">
        <UserPlus className="size-3.5" />
        Join Requests ({requests.length})
      </p>
      <ul className="space-y-2">
        {requests.map((request) => (
          <li
            key={request.id}
            className="flex flex-col gap-2 rounded-lg border p-2 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{request.fullName}</p>
              <p className="truncate text-xs text-muted-foreground">{request.email}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button
                type="button"
                size="sm"
                className="min-h-[36px] gap-1"
                disabled={busyId === request.id}
                onClick={() => void respond(request, "accept")}
              >
                {busyId === request.id ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="size-3.5" />
                )}
                Accept
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-[36px] gap-1"
                disabled={busyId === request.id}
                onClick={() => void respond(request, "reject")}
              >
                <XCircle className="size-3.5" />
                Reject
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
