"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getErrorMessage } from "@/lib/utils";
import { formatTimeMs } from "@/lib/format";
import { RESULT_OUTCOME_LABELS, DQ_REASON_LABELS } from "@/lib/results";
import { useToast } from "@/hooks/use-toast";
import { AthleteLink } from "@/components/athletes/athlete-link";
import {
  fetchPendingReviewHeats,
  publishHeatResults,
  type PendingReviewHeat,
} from "@/lib/admin-referee-review";

export function RefereeHeatCards({ className }: { className?: string }) {
  const toast = useToast();
  const [heats, setHeats] = useState<PendingReviewHeat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyHeatId, setBusyHeatId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHeats(await fetchPendingReviewHeats());
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load referee heat cards."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const publish = async (heatId: string) => {
    const heat = heats.find((h) => h.heatId === heatId);
    setBusyHeatId(heatId);
    setError(null);
    try {
      const res = await publishHeatResults(heatId);
      if (!res.success) throw new Error(res.error ?? "Failed to publish heat card.");
      setHeats((prev) => prev.filter((h) => h.heatId !== heatId));
      toast.success(
        "Heat card published",
        heat ? `${heat.eventName} — Heat ${heat.heatNumber} is now live on spectator heat sheets.` : undefined,
      );
    } catch (err) {
      const message = getErrorMessage(err, "Failed to publish heat card.");
      setError(message);
      toast.error("Failed to publish", message);
    } finally {
      setBusyHeatId(null);
    }
  };

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Referee heat cards</CardTitle>
          <CardDescription>
            Heat cards submitted by referees, waiting for review and publish. Published cards become
            visible on spectator heat sheets and leaderboards immediately.
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
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {heats.length === 0 ? (
          <p className="text-sm text-muted-foreground">No heat cards waiting for review.</p>
        ) : (
          heats.map((heat) => (
            <div key={heat.heatId} className="space-y-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">
                    {heat.eventName} — Heat {heat.heatNumber}
                  </p>
                  <Badge variant={heat.complete ? "default" : "outline"} className="mt-1">
                    {heat.complete ? "Draft Heat Card — Ready" : "Draft Heat Card — In Progress"}
                  </Badge>
                </div>
                <Button
                  type="button"
                  className="min-h-[48px] gap-2"
                  disabled={!heat.complete || busyHeatId === heat.heatId}
                  onClick={() => void publish(heat.heatId)}
                >
                  {busyHeatId === heat.heatId ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Publish Heat Card
                </Button>
              </div>

              <div className="space-y-1.5">
                {heat.lanes.map((lane) => (
                  <div
                    key={lane.heatLaneId}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                  >
                    <Badge variant="outline" className="shrink-0">
                      L{lane.laneNumber}
                    </Badge>
                    <AthleteLink
                      athleteId={lane.athleteId}
                      name={lane.athleteName}
                      className="min-w-0 flex-1 truncate"
                    />
                    {lane.teamName && (
                      <span className="shrink-0 text-xs text-muted-foreground">{lane.teamName}</span>
                    )}
                    {lane.resultOutcome ? (
                      <Badge
                        variant={
                          lane.resultOutcome === "valid"
                            ? "default"
                            : lane.resultOutcome === "dq"
                              ? "destructive"
                              : "secondary"
                        }
                        className="shrink-0"
                      >
                        {lane.resultOutcome === "valid"
                          ? formatTimeMs(lane.officialTimeMs)
                          : lane.resultOutcome === "dq"
                            ? lane.dqCode
                              ? DQ_REASON_LABELS[lane.dqCode]
                              : RESULT_OUTCOME_LABELS.dq
                            : RESULT_OUTCOME_LABELS.no_show}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="shrink-0">
                        Not entered yet
                      </Badge>
                    )}
                    {lane.finishPlace != null && (
                      <Badge variant="secondary" className="shrink-0 gap-1">
                        <CheckCircle2 className="size-3" />#{lane.finishPlace}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
