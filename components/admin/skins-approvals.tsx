"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { RoundStateBadge } from "@/components/skins/round-state-badge";
import { useToast } from "@/hooks/use-toast";
import { DQ_REASON_LABELS } from "@/lib/results";
import {
  fetchSkinsRounds,
  publishSkinsRound,
  reopenSkinsRound,
  skinsRoundTitle,
  type SkinsRoundView,
} from "@/lib/skins-rounds";
import { AGE_GROUP_LABELS } from "@/lib/athletes";

/**
 * Admin approval for the Skins knockout, one round at a time.
 *
 * Each round of each board is published on its own and can only be published
 * once — a published round says so and offers a reopen instead, so an admin
 * cannot quietly approve the same round twice or overwrite one that is
 * already public. Correcting a mistake is possible but deliberate.
 */
export function SkinsApprovals({ eventId, eventName }: { eventId: string; eventName?: string }) {
  const toast = useToast();
  const [rounds, setRounds] = useState<SkinsRoundView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyHeatId, setBusyHeatId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetchSkinsRounds(eventId);
    setRounds(res.data);
    setError(res.error);
    setLoading(false);
  }, [eventId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const boards = useMemo(() => {
    const map = new Map<string, SkinsRoundView[]>();
    for (const round of rounds) {
      const key = `${round.category}-${round.gender}`;
      map.set(key, [...(map.get(key) ?? []), round]);
    }
    return [...map.entries()];
  }, [rounds]);

  const approve = async (round: SkinsRoundView) => {
    setBusyHeatId(round.heatId);
    try {
      const res = await publishSkinsRound(round.heatId);
      if (!res.success) {
        toast.error("Couldn't publish this round", res.error ?? "Unknown error");
        return;
      }
      await reload();
      toast.success("Round published", `${skinsRoundTitle(round)} is now public.`);
    } finally {
      setBusyHeatId(null);
    }
  };

  const reopen = async (round: SkinsRoundView) => {
    setBusyHeatId(round.heatId);
    try {
      const res = await reopenSkinsRound(round.heatId);
      if (!res.success) {
        toast.error("Couldn't reopen this round", res.error ?? "Unknown error");
        return;
      }
      await reload();
      toast.success("Round reopened", "It is back with the referee until it is approved again.");
    } finally {
      setBusyHeatId(null);
    }
  };

  if (loading) return <p className="text-sm text-muted-foreground">Loading Skins rounds…</p>;

  return (
    <div className="space-y-4">
      <DataErrorBanner error={error} subject="the Skins rounds" onRetry={() => void reload()} />

      {boards.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{eventName ?? "Skins"}</CardTitle>
            <CardDescription>No Skins rounds have been run yet.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Rounds appear here as the referee scores them on the deck. Each round is approved on its
            own, and publishing one never touches another.
          </CardContent>
        </Card>
      ) : (
        boards.map(([key, boardRounds]) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle>
                {AGE_GROUP_LABELS[boardRounds[0].category]}{" "}
                {boardRounds[0].gender === "male" ? "Men" : "Women"}
              </CardTitle>
              <CardDescription>
                {boardRounds.filter((r) => r.publishState === "published").length} of{" "}
                {boardRounds.length} rounds published.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {boardRounds.map((round) => (
                <div
                  key={round.heatId}
                  data-testid="skins-approval-round"
                  className="space-y-2 rounded-xl border-2 border-black p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-bold">{skinsRoundTitle(round)}</p>
                    <RoundStateBadge state={round.publishState} />
                  </div>

                  <ol className="space-y-1 text-sm">
                    {[...round.lanes]
                      .sort((a, b) => {
                        // Finished swimmers in finishing order; DQ/NS after,
                        // by lane, since they have no place to sort on.
                        const ap = a.finishPlace ?? Number.MAX_SAFE_INTEGER;
                        const bp = b.finishPlace ?? Number.MAX_SAFE_INTEGER;
                        return ap - bp || a.laneNumber - b.laneNumber;
                      })
                      .map((lane) => (
                        <li key={lane.heatLaneId} className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                            L{lane.laneNumber}
                          </Badge>
                          <span className="w-6 font-mono text-sm font-bold tabular-nums">
                            {lane.finishPlace ?? "—"}
                          </span>
                          <AthleteLink athleteId={lane.athleteId} name={lane.athleteName} />
                          {lane.outcome === "dq" && (
                            <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                              DQ · {lane.dqCode ? DQ_REASON_LABELS[lane.dqCode] : "reason not given"}
                            </Badge>
                          )}
                          {lane.outcome === "no_show" && (
                            <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                              NS
                            </Badge>
                          )}
                        </li>
                      ))}
                  </ol>

                  <div className="flex flex-wrap justify-end gap-2">
                    {round.publishState === "published" ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-[48px] gap-2"
                        disabled={busyHeatId === round.heatId}
                        onClick={() => void reopen(round)}
                      >
                        {busyHeatId === round.heatId ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <RotateCcw className="size-4" />
                        )}
                        Reopen to correct
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        className="min-h-[48px] gap-2"
                        disabled={busyHeatId === round.heatId || !round.complete}
                        title={
                          round.complete
                            ? undefined
                            : "The referee has not finished scoring this round yet."
                        }
                        onClick={() => void approve(round)}
                      >
                        {busyHeatId === round.heatId ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="size-4" />
                        )}
                        Publish {round.publishState === "partial" ? "the rest of " : ""}this round
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
