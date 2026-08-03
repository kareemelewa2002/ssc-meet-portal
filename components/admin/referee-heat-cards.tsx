"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, Pencil, RefreshCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { getErrorMessage } from "@/lib/utils";
import { formatTimeMs, heatTitle, parseTimeToMs, CLOCK_TIME_ERROR } from "@/lib/format";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import { RESULT_OUTCOME_LABELS, DQ_REASON_LABELS } from "@/lib/results";
import { useToast } from "@/hooks/use-toast";
import { AthleteLink } from "@/components/athletes/athlete-link";
import {
  fetchPendingReviewHeats,
  publishHeatResults,
  updateLaneTime,
  type PendingReviewHeat,
} from "@/lib/admin-referee-review";

export function RefereeHeatCards({ className }: { className?: string }) {
  const toast = useToast();
  const [heats, setHeats] = useState<PendingReviewHeat[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyHeatId, setBusyHeatId] = useState<string | null>(null);
  const [editingLaneId, setEditingLaneId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingLane, setSavingLane] = useState(false);
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [genderFilter, setGenderFilter] = useState<string | null>(null);

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

  const saveLaneTime = async (heatLaneId: string) => {
    const ms = parseTimeToMs(editValue);
    if (ms == null) {
      toast.error("Invalid time format", CLOCK_TIME_ERROR);
      return;
    }
    setSavingLane(true);
    try {
      const res = await updateLaneTime(heatLaneId, ms);
      if (!res.success) {
        toast.error("Couldn't save the correction", res.error ?? "Unknown error");
        return;
      }
      setEditingLaneId(null);
      setEditValue("");
      // Re-read rather than patching locally: the heat's finish places are
      // recomputed by the database, so the local copy is stale the moment a
      // time changes.
      await load();
      toast.success("Time corrected", "Finish places have been recalculated.");
    } finally {
      setSavingLane(false);
    }
  };

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

  // The queue lists every submitted card at once, so with a full session in
  // flight it needs narrowing the same way the public heat sheets do.
  const sessionNumbers = [...new Set(heats.map((h) => h.sessionNumber).filter((n): n is number => n != null))].sort();
  const eventNames = [...new Set(heats.map((h) => h.eventName))].sort();
  const visibleHeats = heats
    .filter((h) => !sessionFilter || String(h.sessionNumber) === sessionFilter)
    .filter((h) => !eventFilter || h.eventName === eventFilter)
    .filter((h) => !genderFilter || h.gender === genderFilter)
    .sort(
      (a, b) =>
        (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0) ||
        a.eventName.localeCompare(b.eventName) ||
        a.heatNumber - b.heatNumber,
    );

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

        {heats.length > 1 && (
          <div className="flex flex-wrap gap-4">
            {sessionNumbers.length > 1 && (
              <FilterPillGroup
                label="Session"
                value={sessionFilter}
                onChange={setSessionFilter}
                outdoorMode={false}
                options={sessionNumbers.map((n) => ({ value: String(n), label: `S${n}` }))}
              />
            )}
            {eventNames.length > 1 && (
              <FilterPillGroup
                label="Event"
                value={eventFilter}
                onChange={setEventFilter}
                outdoorMode={false}
                options={eventNames.map((n) => ({ value: n, label: n }))}
              />
            )}
            <FilterPillGroup
              label="Gender"
              value={genderFilter}
              onChange={setGenderFilter}
              outdoorMode={false}
              options={[
                { value: "male", label: "Men" },
                { value: "female", label: "Women" },
              ]}
            />
          </div>
        )}

        {heats.length === 0 ? (
          <p className="text-sm text-muted-foreground">No heat cards waiting for review.</p>
        ) : visibleHeats.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No heat cards match this filter. {heats.length} waiting in total.
          </p>
        ) : (
          visibleHeats.map((heat) => (
            <div key={heat.heatId} className="space-y-3 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">
                    {heat.eventName} — {heatTitle(heat)}
                    {heat.sessionNumber != null ? ` · Session ${heat.sessionNumber}` : ""}
                  </p>
                  <Badge
                    variant={
                      heat.publishState === "published"
                        ? "default"
                        : heat.complete
                          ? "default"
                          : "outline"
                    }
                    className="mt-1 gap-1"
                  >
                    {heat.publishState === "published" ? (
                      <>
                        <CheckCircle2 className="size-3" />
                        Published
                      </>
                    ) : heat.publishState === "partial" ? (
                      "Partly published — re-publish to finish"
                    ) : heat.complete ? (
                      "Draft Heat Card — Ready"
                    ) : (
                      "Draft Heat Card — In Progress"
                    )}
                  </Badge>
                </div>
                {heat.publishState === "published" ? (
                  // Already published. The button is gone rather than disabled
                  // with a tooltip, because a disabled Publish button next to a
                  // published card is the exact ambiguity that led to the same
                  // heat being published repeatedly.
                  <p className="max-w-[16rem] text-xs text-muted-foreground">
                    These results are live on the results page and leaderboards. Edit a time below
                    to correct and re-publish.
                  </p>
                ) : (
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
                    {heat.publishState === "partial" ? "Publish remaining lanes" : "Publish Heat Card"}
                  </Button>
                )}
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
                    {editingLaneId === lane.heatLaneId ? (
                      <div className="flex w-full items-center gap-2 sm:w-auto">
                        <Input
                          value={editValue}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditValue(e.target.value)}
                          placeholder="mm:ss.cc"
                          className="h-9 w-28"
                          aria-label={`Corrected time for ${lane.athleteName}`}
                        />
                        <Button
                          type="button"
                          size="sm"
                          className="h-9"
                          disabled={savingLane}
                          onClick={() => void saveLaneTime(lane.heatLaneId)}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-9"
                          onClick={() => setEditingLaneId(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    ) : lane.resultOutcome ? (
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
                    {editingLaneId !== lane.heatLaneId && lane.resultOutcome === "valid" && (
                      // An admin reviewing a card is the person who spots a
                      // mistyped time; without this their only options were
                      // publish it wrong or send the referee back to the deck.
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-9 shrink-0 gap-1 px-2 text-xs"
                        onClick={() => {
                          setEditingLaneId(lane.heatLaneId);
                          setEditValue(formatTimeMs(lane.officialTimeMs));
                        }}
                      >
                        <Pencil className="size-3" />
                        Edit
                      </Button>
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
