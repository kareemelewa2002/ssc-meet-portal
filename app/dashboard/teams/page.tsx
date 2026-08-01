"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRightLeft, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { didTransferTeams, fetchTeamHistoryForAthlete, type TeamHistoryEntry } from "@/lib/teams";

const DEMO_HISTORY: TeamHistoryEntry[] = [
  { volumeNumber: 1, volumeName: "SSC Vol. 1", teamId: "team-blue", teamName: "Blue Marlins" },
  { volumeNumber: 2, volumeName: "SSC Vol. 2", teamId: "team-rip", teamName: "Riptide" },
];

export default function DashboardTeamsPage() {
  const [history, setHistory] = useState<TeamHistoryEntry[]>(DEMO_HISTORY);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        const { data: athlete } = await supabase
          .from("athletes")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!athlete) return;

        const real = await fetchTeamHistoryForAthlete(athlete.id);
        if (!cancelled && real.length > 0) setHistory(real);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const sorted = [...history].sort((a, b) => a.volumeNumber - b.volumeNumber);
  const transferred = didTransferTeams(history);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <Link href="/dashboard" className="flex min-h-[48px] items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        Dashboard
      </Link>

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
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Volume-by-volume representation</CardTitle>
            <CardDescription>
              {transferred ? "You've transferred teams between volumes." : "Same team representation across all volumes."}
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
  );
}
