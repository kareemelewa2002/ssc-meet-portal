"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { DQ_REASON_LABELS } from "@/lib/results";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { submitSkinsRound, type SkinsRoundView } from "@/lib/skins-rounds";
import { RoundStateBadge } from "@/components/skins/round-state-badge";
import type { DqReason, ResultOutcome } from "@/lib/supabase/types";

const DQ_CODES = Object.keys(DQ_REASON_LABELS) as DqReason[];

interface EditableLane {
  heatLaneId: string;
  laneNumber: number;
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  outcome: ResultOutcome | null;
  finishPlace: number | null;
  dqCode: DqReason | undefined;
}

function isEliminated(lane: EditableLane) {
  return lane.outcome === "dq" || lane.outcome === "no_show";
}

/**
 * Scores ONE round of a Skins board and sends it to the admin.
 *
 * The referee records the finish order; an admin approves it. This never
 * writes `published` — the database refuses that from anyone but an admin
 * anyway (enforce_result_publish), so the button here says what it does.
 *
 * A published round is locked and says so, which is the whole point of each
 * round being its own heat: "already published" is answerable per round
 * instead of per event.
 */
export function SkinsRoundCard({
  view,
  title,
  outdoorMode,
  onSubmitted,
}: {
  view: SkinsRoundView;
  title: string;
  outdoorMode: boolean;
  onSubmitted: () => void | Promise<void>;
}) {
  const [lanes, setLanes] = useState<EditableLane[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset from the server whenever the round's stored state changes, so a
  // reopened round comes back with what was actually recorded rather than
  // whatever was last typed into this browser.
  useEffect(() => {
    setLanes(
      view.lanes.map((l) => ({
        heatLaneId: l.heatLaneId,
        laneNumber: l.laneNumber,
        athleteId: l.athleteId,
        athleteName: l.athleteName,
        teamName: l.teamName,
        outcome: l.outcome,
        finishPlace: l.finishPlace,
        dqCode: l.dqCode ?? undefined,
      })),
    );
  }, [view]);

  const locked = view.publishState === "published";

  const setOutcome = (athleteId: string, outcome: ResultOutcome) =>
    setLanes((prev) =>
      prev.map((l) => {
        if (l.athleteId !== athleteId) return l;
        if (outcome === "dq") return { ...l, outcome, finishPlace: null, dqCode: l.dqCode ?? "false_start" };
        if (outcome === "no_show") return { ...l, outcome, finishPlace: null, dqCode: undefined };
        return { ...l, outcome, dqCode: undefined };
      }),
    );

  const setDqCode = (athleteId: string, dqCode: DqReason) =>
    setLanes((prev) =>
      prev.map((l) => (l.athleteId === athleteId ? { ...l, outcome: "dq", dqCode, finishPlace: null } : l)),
    );

  const setFinishPlace = (athleteId: string, place: number) =>
    setLanes((prev) =>
      prev.map((l) =>
        l.athleteId === athleteId
          ? { ...l, finishPlace: place, outcome: "valid" as ResultOutcome, dqCode: undefined }
          : l,
      ),
    );

  const usedPlaces = useMemo(
    () =>
      new Set(
        lanes.filter((l) => l.outcome === "valid" && l.finishPlace !== null).map((l) => l.finishPlace as number),
      ),
    [lanes],
  );

  const complete = lanes.every(
    (l) =>
      l.outcome === "no_show" ||
      (l.outcome === "dq" && l.dqCode) ||
      (l.outcome === "valid" && l.finishPlace !== null),
  );

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await submitSkinsRound(
        lanes.map((l) => ({
          heatLaneId: l.heatLaneId,
          outcome: l.outcome as ResultOutcome,
          finishPlace: l.finishPlace,
          dqCode: l.dqCode ?? null,
        })),
        lanes.length,
      );
      if (!res.success) {
        setError(res.error ?? "Could not send this round to the admin.");
        return;
      }
      await onSubmitted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>{title}</CardTitle>
          <RoundStateBadge state={view.publishState} />
        </div>
        <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
          {locked
            ? "Published. An admin must reopen this round before it can change."
            : view.publishState === "draft"
              ? "Sent to the admin. You can still correct it and send again until they approve it."
              : "Record the finish order, DQ (with reason) or NS, then send it to the admin."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {lanes.map((lane) => (
          <LaneRow
            key={lane.athleteId}
            lane={lane}
            usedPlaces={usedPlaces}
            maxPlace={lanes.length}
            outdoorMode={outdoorMode}
            disabled={locked}
            onSetOutcome={(o) => setOutcome(lane.athleteId, o)}
            onSetDqCode={(c) => setDqCode(lane.athleteId, c)}
            onSetPlace={(p) => setFinishPlace(lane.athleteId, p)}
          />
        ))}

        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            {error}
          </div>
        )}

        {!locked && (
          <div className="flex justify-end pt-1">
            <Button
              type="button"
              className="min-h-[48px] gap-2"
              disabled={!complete || submitting}
              onClick={() => void submit()}
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              {view.publishState === "draft" ? "Send corrected round" : "Send round to admin"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LaneRow({
  lane,
  usedPlaces,
  maxPlace,
  outdoorMode,
  disabled,
  onSetOutcome,
  onSetDqCode,
  onSetPlace,
}: {
  lane: EditableLane;
  usedPlaces: Set<number>;
  maxPlace: number;
  outdoorMode: boolean;
  disabled: boolean;
  onSetOutcome: (outcome: ResultOutcome) => void;
  onSetDqCode: (code: DqReason) => void;
  onSetPlace: (place: number) => void;
}) {
  const eliminated = isEliminated(lane);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border p-3",
        outdoorMode ? "border-yellow-300/30" : "border-border",
      )}
    >
      <div className="flex min-w-[48px] items-center justify-center rounded-md bg-muted px-2 py-1 text-sm font-bold">
        L{lane.laneNumber}
      </div>
      <div className="min-w-0 flex-1">
        <AthleteLink
          athleteId={lane.athleteId}
          name={lane.athleteName}
          className={cn("block truncate font-medium", eliminated && "line-through opacity-60")}
        />
        {lane.teamName && (
          <p className={cn("truncate text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}>
            {lane.teamName}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: maxPlace }, (_, i) => i + 1).map((place) => {
          const active = lane.finishPlace === place;
          // A place another swimmer already holds is NOT blocked: two swimmers
          // can touch together, and refusing to record that would force the
          // referee to invent a separation that did not happen.
          const shared = usedPlaces.has(place) && !active;
          return (
            <Button
              key={place}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              disabled={eliminated || disabled}
              title={shared ? "Another swimmer already has this place — selecting it records a tie" : undefined}
              className={cn("size-9 min-h-[36px] min-w-[36px] p-0", shared && "border-dashed opacity-70")}
              onClick={() => onSetPlace(place)}
            >
              {place}
            </Button>
          );
        })}
      </div>
      <div className="w-full sm:w-56">
        <div className="flex w-full flex-col gap-2">
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              variant={lane.outcome === "valid" ? "default" : "outline"}
              className="min-h-[40px]"
              disabled={disabled}
              onClick={() => onSetOutcome("valid")}
            >
              Valid
            </Button>
            <Button
              type="button"
              size="sm"
              variant={lane.outcome === "dq" ? "destructive" : "outline"}
              className="min-h-[40px]"
              disabled={disabled}
              onClick={() => onSetOutcome("dq")}
            >
              DQ
            </Button>
            <Button
              type="button"
              size="sm"
              variant={lane.outcome === "no_show" ? "secondary" : "outline"}
              className={cn(
                "min-h-[40px]",
                lane.outcome === "no_show" && "bg-amber-600 text-white hover:bg-amber-600",
              )}
              disabled={disabled}
              onClick={() => onSetOutcome("no_show")}
            >
              NS
            </Button>
          </div>
          {lane.outcome === "dq" && (
            <Select
              value={lane.dqCode ?? "false_start"}
              onValueChange={(value) => {
                if (value != null) onSetDqCode(value as DqReason);
              }}
            >
              <SelectTrigger
                className={cn("min-h-[44px] w-full", outdoorMode && "border-yellow-300/40 text-yellow-300")}
                disabled={disabled}
              >
                {/* Select.Value renders the raw value by default — a render
                    function is required to show the label. */}
                <SelectValue>{(value: DqReason) => DQ_REASON_LABELS[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DQ_CODES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {DQ_REASON_LABELS[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </div>
  );
}
