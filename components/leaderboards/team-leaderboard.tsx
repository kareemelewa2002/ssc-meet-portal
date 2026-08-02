"use client";

import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchTeamLeaderboard, type TeamLeaderboardEntry } from "@/lib/leaderboard";

const MEDAL_VARIANT = ["default", "secondary", "outline"] as const;

/** Real-time team standings — every approved team's swimmers' series
 * points summed together. Part of the All-Time Records page. */
export function TeamLeaderboard({ className }: { className?: string }) {
  const [entries, setEntries] = useState<TeamLeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await fetchTeamLeaderboard();
      if (!cancelled) {
        setEntries(rows);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="size-4 text-amber-500" />
          Team Leaderboard
        </CardTitle>
        <CardDescription>Team point totals accumulated across every published heat.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading team standings…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No published results yet.</p>
        ) : (
          entries.map((entry, i) => (
            <div
              key={entry.teamId}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Badge variant={MEDAL_VARIANT[i] ?? "outline"} className="size-7 shrink-0 justify-center rounded-full p-0">
                  {i + 1}
                </Badge>
                <div className="min-w-0">
                  <p className="truncate font-medium">{entry.teamName}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.athleteCount} scoring {entry.athleteCount === 1 ? "swimmer" : "swimmers"}
                  </p>
                </div>
              </div>
              <span className="shrink-0 font-mono text-lg font-bold tabular-nums">
                {entry.totalPoints.toFixed(1)}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
