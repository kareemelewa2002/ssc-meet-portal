"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Lock, Pencil, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ClockTimeInput } from "@/components/ui/clock-time-input";
import { cn, getErrorMessage, isValidUuid } from "@/lib/utils";
import {
  DQ_REASON_LABELS,
  RESULT_OUTCOME_LABELS,
  scoreHeatResult,
} from "@/lib/results";
import { createClient } from "@/lib/supabase/client";
import { CLOCK_TIME_ERROR, formatTimeMs, timeDropSeconds } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { DqReason, PublishStatus, ResultOutcome } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";

export interface HeatLaneAthlete {
  heatLaneId: string;
  laneNumber: number;
  athleteName: string;
  athleteId?: string;
  teamName?: string;
  seedTimeMs?: number | null;
  entryId?: string;
}

export interface LaneDraft {
  outcome: ResultOutcome | null;
  officialTimeMs: number | null;
  /** Never entered manually — always server-computed by
   * public.recompute_heat_finish_places() from official_time_ms rankings
   * within the heat (DQ/NS excluded). Populated for display only. */
  finishPlace: number | null;
  dqCode: DqReason | null;
}

export interface HeatResultEntryProps {
  heatId: string;
  heatLabel?: string;
  lanes: HeatLaneAthlete[];
  outdoorMode?: boolean;
  /** True when this event is the one Skins qualification is drawn from, so an
   * NS here also costs the swimmer their Skins place. The caption used to
   * claim that unconditionally, which was wrong on every other event. */
  feedsSkins?: boolean;
  onSaved?: () => void;
  className?: string;
}

const DQ_CODES = Object.keys(DQ_REASON_LABELS) as DqReason[];

function emptyDraft(): LaneDraft {
  return { outcome: null, officialTimeMs: null, finishPlace: null, dqCode: null };
}

/**
 * The consolidated Referee role's time-entry card: every referee who opens
 * a heat has full write access to every lane (no lane-claim/Chief-Referee
 * tiering — see AGENTS scope lock) and can save progress as swimmers
 * finish. Writes always land as draft results; only an Admin reviewing the
 * queue can publish (enforce_result_publish in supabase/schema.sql).
 */
export function HeatResultEntry({
  heatId,
  heatLabel = "Heat results",
  lanes,
  outdoorMode = false,
  feedsSkins = false,
  onSaved,
  className,
}: HeatResultEntryProps) {
  const toast = useToast();
  const { user } = useCurrentUser();
  const [drafts, setDrafts] = useState<Record<string, LaneDraft>>(() =>
    Object.fromEntries(lanes.map((l) => [l.heatLaneId, emptyDraft()])),
  );
  const [timeInputs, setTimeInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [alreadyPublished, setAlreadyPublished] = useState(false);
  // A submitted card presents as submitted until the user explicitly chooses
  // to edit it, so re-submitting is always a decision rather than a side
  // effect of tapping a lane.
  const [editing, setEditing] = useState(false);
  type ResultRow = {
    heat_lane_id: string;
    result_outcome: ResultOutcome | null;
    official_time_ms: number | null;
    finish_place: number | null;
    dq_code: DqReason | null;
    status?: PublishStatus;
  };

  // WHO MAY EDIT WHAT
  // ------------------
  // A published result is locked to admins, and that is enforced by
  // enforce_result_publish in supabase/schema.sql — not merely by hiding this
  // button. A referee who gets past the UI is refused by the database.
  //
  // Before publication both the referee and an admin may correct the card:
  // the referee who took the times is usually the one who spots the error,
  // and nothing is public yet.
  const isAdmin = user?.role === "admin";
  const canEditPublished = isAdmin;
  const readOnly = (alreadyPublished && !canEditPublished) || (alreadySubmitted && !editing);

  const applyResultRow = useCallback((row: ResultRow) => {
    if (!row.result_outcome) return;
    setDrafts((prev) => ({
      ...prev,
      [row.heat_lane_id]: {
        outcome: row.result_outcome,
        officialTimeMs: row.official_time_ms,
        finishPlace: row.finish_place,
        dqCode: row.dq_code,
      },
    }));
    if (row.result_outcome === "valid" && row.official_time_ms != null) {
      setTimeInputs((prev) => ({ ...prev, [row.heat_lane_id]: formatTimeMs(row.official_time_ms) }));
    }
  }, []);

  // Keyed on the lane IDS, not the `lanes` array. The array is a fresh
  // identity on every render of the deck, so depending on it tore the
  // realtime channel down and resubscribed constantly — and an event landing
  // in that gap was simply lost, which is how a second device could miss a
  // colleague's saved time entirely.
  const laneKey = lanes.map((l) => l.heatLaneId).join(",");

  // Hydrate any results already saved (e.g. on page reload or by another
  // referee looking at the same heat), then keep receiving live updates.
  useEffect(() => {
    const laneIds = laneKey ? laneKey.split(",") : [];
    // Demo/placeholder lane ids (e.g. "hl-1") are never real database keys —
    // querying with one always 400s ("invalid input syntax for type uuid").
    // This fires on first mount, before a real heat's lanes replace the
    // caller's bundled default, so skip the round-trip entirely.
    if (laneIds.length === 0 || !laneIds.every(isValidUuid)) return;

    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("results")
        .select("heat_lane_id, result_outcome, official_time_ms, finish_place, dq_code, status")
        .in("heat_lane_id", laneIds);
      if (!cancelled && data) {
        const rows = data as ResultRow[];
        for (const row of rows) applyResultRow(row);
        // Already sent, and possibly already published. Without this the deck
        // happily re-submits the same card with no indication it was sent
        // before — or that an admin has already published it and a re-submit
        // would be overwriting a live result.
        setAlreadySubmitted(rows.some((r) => r.result_outcome != null));
        setAlreadyPublished(rows.length > 0 && rows.every((r) => r.status === "published"));
      }
    })();

    const laneIdSet = new Set(laneIds);
    const supabase = createClient();
    const channel = supabase
      .channel(`referee-heat-results-${heatId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "results" },
        (payload) => {
          const row = payload.new as ResultRow | null;
          if (!row?.heat_lane_id || !laneIdSet.has(row.heat_lane_id)) return;
          applyResultRow(row);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "results" },
        (payload) => {
          const row = payload.new as ResultRow | null;
          if (!row?.heat_lane_id || !laneIdSet.has(row.heat_lane_id)) return;
          applyResultRow(row);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [heatId, laneKey, applyResultRow]);

  const readyLanes = useMemo(
    () =>
      lanes.filter((lane) => {
        const d = drafts[lane.heatLaneId];
        if (!d?.outcome) return false;
        if (d.outcome === "valid") return d.officialTimeMs != null;
        if (d.outcome === "dq") return d.dqCode != null;
        return true;
      }),
    [lanes, drafts],
  );
  const allReady = lanes.length > 0 && readyLanes.length === lanes.length;

  const setOutcome = (heatLaneId: string, outcome: ResultOutcome) => {
    setDrafts((prev) => ({
      ...prev,
      [heatLaneId]: {
        outcome,
        officialTimeMs: outcome === "valid" ? prev[heatLaneId]?.officialTimeMs ?? null : null,
        // finishPlace is never set by the client — see LaneDraft comment.
        finishPlace: null,
        dqCode: outcome === "dq" ? prev[heatLaneId]?.dqCode ?? "false_start" : null,
      },
    }));
    setSaved(false);
  };

  const handleSave = async () => {
    // Validate clock strings for valid outcomes before write.
    for (const lane of lanes) {
      const draft = drafts[lane.heatLaneId];
      if (draft?.outcome === "valid" && draft.officialTimeMs == null && (timeInputs[lane.heatLaneId] ?? "").trim()) {
        setError(CLOCK_TIME_ERROR);
        toast.error("Invalid time format", CLOCK_TIME_ERROR);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const supabase = createClient();

      for (const lane of readyLanes) {
        const draft = drafts[lane.heatLaneId];
        if (!draft?.outcome) continue;
        // A demo/placeholder lane (no real heat selected yet) has no
        // matching heat_lanes row — upserting one would violate the
        // results.heat_lane_id foreign key. Skip it; there's nothing real
        // to persist until a genuine heat is selected.
        if (!isValidUuid(lane.heatLaneId)) continue;

        // finishPlace/placementPoints are intentionally omitted — the
        // database's recompute_heat_finish_places trigger derives them from
        // every valid result's official_time_ms within this heat the moment
        // this row lands, so ranking is always authoritative regardless of
        // which referee last wrote a time. status always stays 'draft' —
        // only an Admin reviewing the queue can publish.
        const scored = scoreHeatResult(
          {
            outcome: draft.outcome,
            officialTimeMs: draft.officialTimeMs,
            seedTimeMs: lane.seedTimeMs,
          },
          draft.dqCode,
        );

        const { error: upsertError } = await supabase.from("results").upsert(
          {
            heat_lane_id: lane.heatLaneId,
            result_outcome: scored.resultOutcome,
            official_time_ms: scored.officialTimeMs,
            dq_code: scored.dqCode,
            improvement_points: scored.improvementPoints,
            status: "draft",
          },
          { onConflict: "heat_lane_id" },
        );
        if (upsertError) throw upsertError;
      }

      setSaved(true);
      if (allReady) {
        // A complete card is now with Admin, so it collapses back to the
        // submitted state. Editing it again has to be chosen again — a card
        // left silently open is how the same heat gets re-sent by accident.
        setAlreadySubmitted(true);
        setEditing(false);
      }
      toast.success(
        allReady ? "Heat card submitted" : "Progress saved",
        allReady ? `${lanes.length} lanes sent to the Admin review queue.` : undefined,
      );
      onSaved?.();
    } catch (err) {
      const message = getErrorMessage(err, "Failed to save heat results.");
      setError(message);
      toast.error("Failed to save", message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      data-testid={`heat-card-${heatId}`}
      className={cn(
        outdoorMode && "border-yellow-300/40 bg-black text-yellow-300",
        className,
      )}
    >
      <CardHeader>
        <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
          {heatLabel}
        </CardTitle>
        <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
          Enter times, DQ, or No-Show for each lane, then submit the completed card to Admin for review.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {lanes.map((lane) => {
          const draft = drafts[lane.heatLaneId] ?? emptyDraft();
          return (
            <div
              key={lane.heatLaneId}
              className={cn(
                "space-y-3 rounded-lg border p-3",
                outdoorMode ? "border-yellow-300/30" : "border-border",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="h-8 px-3">L{lane.laneNumber}</Badge>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "truncate font-medium",
                      draft.outcome === "no_show" && "opacity-60 line-through",
                      outdoorMode && "text-yellow-300",
                    )}
                  >
                    {lane.athleteId ? (
                      <AthleteLink
                        athleteId={lane.athleteId}
                        name={lane.athleteName}
                        className={outdoorMode ? "text-yellow-300" : undefined}
                      />
                    ) : (
                      lane.athleteName
                    )}
                  </p>
                  {lane.teamName && (
                    <p
                      className={cn(
                        "truncate text-xs",
                        outdoorMode ? "text-yellow-100/60" : "text-muted-foreground",
                      )}
                    >
                      {lane.teamName}
                    </p>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(["valid", "dq", "no_show"] as ResultOutcome[]).map((outcome) => (
                  <Button
                    key={outcome}
                    type="button"
                    variant={draft.outcome === outcome ? "default" : "outline"}
                    className={cn(
                      "min-h-[54px] text-base font-bold",
                      outcome === "dq" && draft.outcome === "dq" && "bg-destructive text-white",
                      outcome === "no_show" &&
                        draft.outcome === "no_show" &&
                        "bg-amber-600 text-white hover:bg-amber-600",
                    )}
                    disabled={readOnly}
                    onClick={() => setOutcome(lane.heatLaneId, outcome)}
                  >
                    {RESULT_OUTCOME_LABELS[outcome]}
                  </Button>
                ))}
              </div>

              {draft.outcome === "valid" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <ClockTimeInput
                    id={`time-${lane.heatLaneId}`}
                    label="Official time"
                    value={timeInputs[lane.heatLaneId] ?? ""}
                    outdoorMode={outdoorMode}
                    disabled={readOnly}
                    onChange={(raw, ms) => {
                      setTimeInputs((prev) => ({ ...prev, [lane.heatLaneId]: raw }));
                      setDrafts((prev) => ({
                        ...prev,
                        [lane.heatLaneId]: {
                          ...prev[lane.heatLaneId],
                          outcome: "valid",
                          officialTimeMs: ms,
                        },
                      }));
                      setSaved(false);
                    }}
                  />
                  <div className="space-y-1.5">
                    <Label>Finish place</Label>
                    <div
                      className={cn(
                        "flex min-h-[54px] items-center gap-2 rounded-lg border-2 px-3 font-telemetry text-base",
                        outdoorMode ? "border-yellow-300/40 text-yellow-100/70" : "text-muted-foreground",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {draft.finishPlace != null
                          ? `#${draft.finishPlace} — auto-ranked by time`
                          : "Auto-ranked once all times are in"}
                      </span>
                      {/* Instant seed -> official delta. A referee entering a
                          time should see immediately whether the swimmer
                          dropped, because a surprising delta is usually a
                          mis-keyed digit rather than a real swim. */}
                      {(() => {
                        const delta = timeDropSeconds(lane.seedTimeMs ?? null, draft.officialTimeMs);
                        if (delta == null) return null;
                        return (
                          <span
                            className={cn(
                              "shrink-0 rounded-full border-2 border-black px-2 py-0.5 text-xs font-extrabold",
                              delta > 0 ? "bg-neon-lime text-black" : "bg-neon-orange text-black",
                            )}
                          >
                            {delta > 0 ? "-" : "+"}
                            {Math.abs(delta).toFixed(2)}s
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              )}

              {draft.outcome === "dq" && (
                <div className="space-y-1.5">
                  <Label>DQ reason code</Label>
                  <Select
                    value={draft.dqCode ?? "false_start"}
                    onValueChange={(value) => {
                      if (value == null) return;
                      setDrafts((prev) => ({
                        ...prev,
                        [lane.heatLaneId]: {
                          ...prev[lane.heatLaneId],
                          outcome: "dq",
                          dqCode: value as DqReason,
                        },
                      }));
                      setSaved(false);
                    }}
                  >
                    <SelectTrigger className="min-h-[54px] w-full">
                      {/* Select.Value renders the raw value by default — a
                          render function is required to show the label. */}
                      <SelectValue>
                        {(value: DqReason) => DQ_REASON_LABELS[value] ?? value}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {DQ_CODES.map((code) => (
                        <SelectItem key={code} value={code}>
                          {DQ_REASON_LABELS[code]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {draft.outcome === "no_show" && (
                <p
                  className={cn(
                    "text-sm",
                    outdoorMode ? "text-yellow-100/80" : "text-muted-foreground",
                  )}
                >
                  No-Show: 0 points, and no time recorded.
                  {feedsSkins
                    ? " This event feeds Skins qualification, so an NS here also costs their Skins place."
                    : ""}
                </p>
              )}
            </div>
          );
        })}

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {alreadyPublished && !canEditPublished ? (
          // Published, and this user may not change it. The control is present
          // but disabled rather than absent: a missing button reads as "not
          // loaded yet", whereas a greyed one with a reason reads as a rule.
          <div className="space-y-2">
            <p className="rounded-md border-2 border-black bg-neon-lime/15 p-3 text-sm">
              <span className="font-bold">Already published by Admin.</span> These times are live on
              the results page and leaderboards. Ask an Admin to correct a time from the review
              queue.
            </p>
            <Button
              type="button"
              disabled
              aria-disabled="true"
              title="Published results can only be changed by an admin."
              className="min-h-[54px] w-full cursor-not-allowed text-base font-bold opacity-50 sm:w-auto"
            >
              <Lock className="mr-2 size-4" />
              Submitted — Contact Admin to Edit
            </Button>
          </div>
        ) : alreadySubmitted && !editing ? (
          // Sent, not yet published. Editing is allowed but deliberate: the
          // card reads as submitted until the user chooses to reopen it.
          <div className="space-y-2">
            <p className="rounded-md border-2 border-black bg-neon-orange/15 p-3 text-sm">
              <span className="font-bold">
                {alreadyPublished
                  ? "Published, and live on the results page."
                  : "This card is with Admin for review."}
              </span>{" "}
              {alreadyPublished
                ? "Editing it changes a result the public can already see."
                : "Editing it replaces what they are reviewing — only do that to correct a lane."}
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-[54px] w-full text-base font-bold sm:w-auto"
              onClick={() => {
                setEditing(true);
                // Reopening means this is no longer "just submitted": the
                // action below must invite a re-submit, not keep claiming the
                // card has already been sent.
                setSaved(false);
              }}
            >
              <Pencil className="mr-2 size-4" />
              Edit Heat Card
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            className="min-h-[54px] w-full text-base font-bold sm:w-auto"
            disabled={saving || readyLanes.length === 0}
            onClick={() => void handleSave()}
          >
            {saving ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Send className="mr-2 size-4" />
            )}
            {saved && allReady
              ? "Heat card submitted to Admin"
              : alreadySubmitted && allReady
                ? "Re-submit Heat Card to Admin"
                : allReady
                  ? "Submit Heat Card to Admin"
                  : `Save Progress (${readyLanes.length}/${lanes.length} lanes)`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
