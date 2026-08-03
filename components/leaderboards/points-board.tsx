"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { PerformanceBadges } from "@/components/results/performance-badges";
import {
  fetchPointsPerformances,
  rankPointsPerformances,
  type PointsPerformance,
} from "@/lib/all-time-rankings";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { formatTimeMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

/**
 * Best Performance — every published swim ranked by World Aquatics points.
 *
 * Scoped by `meetVolumeId`: pass one for a single meet's board, omit it for
 * the all-time board. The ranking is computed over whatever came back, so a
 * meet board ranks that meet's swims against each other rather than showing
 * their position in an all-time list.
 *
 * The badges stay all-time on purpose. "Best in event" means best ever swum,
 * so seeing it on a meet board tells you something the meet ranking cannot:
 * that this swim is also the series record.
 */
export function PointsBoard({
  gender,
  ageGroup,
  meetVolumeId,
  scopeLabel,
  limit = 25,
  outdoorMode = false,
}: {
  gender: Gender;
  ageGroup: AgeGroup;
  /** Omit for the all-time board. */
  meetVolumeId?: string | null;
  /** e.g. "SSC Vol. 1" or "every volume" — used in the description. */
  scopeLabel: string;
  limit?: number;
  outdoorMode?: boolean;
}) {
  const [rows, setRows] = useState<PointsPerformance[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const res = await fetchPointsPerformances(meetVolumeId ?? undefined);
      if (cancelled) return;
      setRows(res.data);
      setError(res.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [meetVolumeId]);

  const ranked = useMemo(
    () => rankPointsPerformances(rows, { gender, ageGroup }, limit),
    [rows, gender, ageGroup, limit],
  );

  return (
    <>
      <DataErrorBanner error={error} subject="the World Aquatics points ranking" />
      <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
        <CardHeader>
          <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
            Best Performance (World Aquatics points) — {AGE_GROUP_LABELS[ageGroup]} · {gender}
          </CardTitle>
          <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
            Ranked by World Aquatics points (short course) across {scopeLabel}, so swims in
            different events compare directly — the higher the points, the better the swim. There
            is no event filter on purpose: comparing across events is the whole point of the
            board. The 50m switch events have no points system and never appear.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading && ranked.length === 0 && (
            <p className="text-sm text-muted-foreground">Loading points ranking…</p>
          )}
          {!loading && ranked.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No scored performances yet for this filter. Points appear once an admin publishes a
              heat card.
            </p>
          )}
          {ranked.map((row) => (
            <div
              key={row.resultId}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                outdoorMode && "border-yellow-300/30",
              )}
            >
              <div className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-bold">
                {row.rank}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <AthleteLink athleteId={row.athleteId} name={row.athleteName} />
                  <PerformanceBadges
                    isBestOverall={row.isBestOverall}
                    isBestInEvent={row.isBestInEvent}
                    outdoorMode={outdoorMode}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {row.eventName} · {formatTimeMs(row.officialTimeMs)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {row.teamName ?? "Unaffiliated"} · {row.volumeName}
                </p>
              </div>
              <p className="font-mono text-lg font-semibold tabular-nums">
                {row.waPoints}
                <span className="ml-1 text-xs font-normal text-muted-foreground">pts</span>
              </p>
            </div>
          ))}
        </CardContent>
      </Card>
    </>
  );
}
