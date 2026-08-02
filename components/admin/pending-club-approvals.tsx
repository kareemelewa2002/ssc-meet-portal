"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, CheckCircle2, Loader2, RefreshCcw, XCircle } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { approveTeam, fetchPendingTeams, rejectTeam } from "@/lib/teams";
import { getErrorMessage } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import type { TeamRow } from "@/lib/supabase/types";

export function PendingClubApprovals({ className }: { className?: string }) {
  const toast = useToast();
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTeams(await fetchPendingTeams());
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load pending clubs."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const approve = async (teamId: string) => {
    const team = teams.find((t) => t.id === teamId);
    setBusyId(teamId);
    setError(null);
    try {
      const res = await approveTeam(teamId);
      if (!res.success) {
        const message = res.error ?? "Failed to approve club.";
        setError(message);
        toast.error("Failed to approve club", message);
        return;
      }
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      toast.success("Club approved", team ? `${team.name} now appears in the public directory.` : undefined);
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (teamId: string) => {
    setBusyId(teamId);
    setError(null);
    try {
      const res = await rejectTeam(teamId);
      if (!res.success) {
        const message = res.error ?? "Failed to reject club.";
        setError(message);
        toast.error("Failed to reject club", message);
        return;
      }
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      toast.success("Club rejected");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Pending club approvals</CardTitle>
          <CardDescription>
            New clubs start unapproved and stay out of the public directory until reviewed here.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-[48px]"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCcw className="size-4" />}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending club approvals.</p>
        ) : (
          <div className="space-y-3">
            {teams.map((team) => (
              <div
                key={team.id}
                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar className="size-10 shrink-0">
                    {team.club_logo_url ? <AvatarImage src={team.club_logo_url} alt={team.name} /> : null}
                    <AvatarFallback>
                      <Building2 className="size-4" />
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{team.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {team.abbreviation ?? "No abbreviation"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    className="min-h-[48px] flex-1 gap-2 sm:flex-none"
                    disabled={busyId === team.id}
                    onClick={() => void approve(team.id)}
                  >
                    {busyId === team.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-4" />
                    )}
                    Approve Club
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[48px] flex-1 gap-2 sm:flex-none"
                    disabled={busyId === team.id}
                    onClick={() => void reject(team.id)}
                  >
                    <XCircle className="size-4" />
                    Reject Club
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
