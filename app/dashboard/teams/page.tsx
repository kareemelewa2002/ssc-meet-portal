"use client";

import { useEffect, useState } from "react";
import { ArrowRightLeft, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AppHeader } from "@/components/layout/app-header";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { didTransferTeams, fetchTeamHistoryForAthlete, type TeamHistoryEntry } from "@/lib/teams";

/**
 * Volume-by-volume team representation for the signed-in swimmer.
 *
 * This page used to seed its state with a hardcoded DEMO_HISTORY of two
 * invented teams ("Blue Marlins", "Riptide") and replace it only when the
 * real fetch came back non-empty. Every case that legitimately has no
 * history — a brand-new account, a swimmer with no athlete row, an athlete
 * who has not yet swum a volume — therefore rendered those two teams as
 * fact, telling people they had a current team and a previous one when they
 * had never joined either. An empty history now stays empty and says so.
 */
export default function DashboardTeamsPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [history, setHistory] = useState<TeamHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Stay in the loading state until the shared auth store has actually
      // resolved. Falling through to "no history" while the user is still
      // being determined would flash an empty state at someone who has one.
      if (userLoading) return;
      if (!user) {
        if (!cancelled) setLoading(false);
        return;
      }

      try {
        const supabase = createClient();
        const { data: athlete } = await supabase
          .from("athletes")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();

        // No athlete row means no representation to show — a parent or a
        // referee reading this page, or a swimmer not yet linked. That is an
        // empty history, not a missing one.
        if (!athlete) return;

        const real = await fetchTeamHistoryForAthlete(athlete.id);
        if (!cancelled) setHistory(real.data);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

  const sorted = [...history].sort((a, b) => a.volumeNumber - b.volumeNumber);
  const transferred = didTransferTeams(history);

  return (
    <div className="min-h-screen">
      {/* No in-page back link: AppHeader's back control goes to /dashboard,
          and two back affordances on one screen is one too many. */}
      <AppHeader title="My Team History" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Users className="size-6" />
            My Team History
          </h1>
          <p className="text-sm text-muted-foreground">
            Team representation is tracked per volume — transferring for a future volume never
            rewrites which team you swam for in a past one.
          </p>
        </header>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading team history…</p>
        ) : sorted.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No team history yet</CardTitle>
              <CardDescription>
                You haven&apos;t represented a team in a meet volume yet. Once you swim a volume
                with a team, it will be recorded here and stays on the record even if you transfer
                later.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Volume-by-volume representation</CardTitle>
              <CardDescription>
                {transferred
                  ? "You've transferred teams between volumes."
                  : "Same team representation across all volumes."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {sorted.map((entry, i) => (
                <div key={entry.volumeNumber} className="flex items-center gap-3 rounded-lg border p-3">
                  <Badge variant="outline">Vol. {entry.volumeNumber}</Badge>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {entry.teamName ?? "Unattached"}
                  </span>
                  {i > 0 && sorted[i - 1].teamId !== entry.teamId && (
                    <Badge className="gap-1">
                      <ArrowRightLeft className="size-3.5" />
                      Transferred
                    </Badge>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
