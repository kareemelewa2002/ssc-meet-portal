"use client";

import { useMemo, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import {
  DQ_REASON_LABELS,
  RESULT_OUTCOME_LABELS,
  scoreHeatResult,
} from "@/lib/results";
import { createClient } from "@/lib/supabase/client";
import type { DqReason, ResultOutcome } from "@/lib/supabase/types";

export interface HeatLaneAthlete {
  heatLaneId: string;
  laneNumber: number;
  athleteName: string;
  teamName?: string;
  seedTimeMs?: number | null;
  entryId?: string;
}

export interface LaneDraft {
  outcome: ResultOutcome | null;
  officialTimeMs: number | null;
  finishPlace: number | null;
  dqCode: DqReason | null;
}

export interface HeatResultEntryProps {
  heatId: string;
  heatLabel?: string;
  lanes: HeatLaneAthlete[];
  outdoorMode?: boolean;
  onSaved?: () => void;
  className?: string;
}

const DQ_CODES = Object.keys(DQ_REASON_LABELS) as DqReason[];

function emptyDraft(): LaneDraft {
  return { outcome: null, officialTimeMs: null, finishPlace: null, dqCode: null };
}

function parseTimeToMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Supports "mm:ss.hh" or "ss.hh" / plain milliseconds integer.
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
  return Math.round((minutes * 60 + seconds) * 1000);
}

export function HeatResultEntry({
  heatId,
  heatLabel = "Heat results",
  lanes,
  outdoorMode = false,
  onSaved,
  className,
}: HeatResultEntryProps) {
  const [drafts, setDrafts] = useState<Record<string, LaneDraft>>(() =>
    Object.fromEntries(lanes.map((l) => [l.heatLaneId, emptyDraft()])),
  );
  const [timeInputs, setTimeInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const allReady = useMemo(
    () =>
      lanes.every((lane) => {
        const d = drafts[lane.heatLaneId];
        if (!d?.outcome) return false;
        if (d.outcome === "valid") return d.officialTimeMs != null || d.finishPlace != null;
        if (d.outcome === "dq") return d.dqCode != null;
        return true; // no_show
      }),
    [lanes, drafts],
  );

  const setOutcome = (heatLaneId: string, outcome: ResultOutcome) => {
    setDrafts((prev) => ({
      ...prev,
      [heatLaneId]: {
        outcome,
        officialTimeMs: outcome === "valid" ? prev[heatLaneId]?.officialTimeMs ?? null : null,
        finishPlace: outcome === "valid" ? prev[heatLaneId]?.finishPlace ?? null : null,
        dqCode: outcome === "dq" ? prev[heatLaneId]?.dqCode ?? "false_start" : null,
      },
    }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const supabase = createClient();

      for (const lane of lanes) {
        const draft = drafts[lane.heatLaneId];
        if (!draft?.outcome) continue;

        const scored = scoreHeatResult(
          {
            outcome: draft.outcome,
            finishPlace: draft.finishPlace,
            officialTimeMs: draft.officialTimeMs,
            seedTimeMs: lane.seedTimeMs,
            maxPlacementPoints: lanes.length,
          },
          draft.dqCode,
        );

        const { error: upsertError } = await supabase.from("results").upsert(
          {
            heat_lane_id: lane.heatLaneId,
            result_outcome: scored.resultOutcome,
            official_time_ms: scored.officialTimeMs,
            finish_place: scored.finishPlace,
            dq_code: scored.dqCode,
            placement_points: scored.placementPoints,
            improvement_points: scored.improvementPoints,
            status: "draft",
          },
          { onConflict: "heat_lane_id" },
        );
        if (upsertError) throw upsertError;
      }

      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save heat results.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
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
          Heat {heatId} — record Valid Time, DQ (with FINA/SSC code), or NS (No-Show).
          DQ and NS score 0 placement and 0 improvement points; NS is excluded from Skins.
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
                    {lane.athleteName}
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
                      "min-h-[48px]",
                      outcome === "dq" && draft.outcome === "dq" && "bg-destructive text-white",
                      outcome === "no_show" &&
                        draft.outcome === "no_show" &&
                        "bg-amber-600 text-white hover:bg-amber-600",
                    )}
                    onClick={() => setOutcome(lane.heatLaneId, outcome)}
                  >
                    {RESULT_OUTCOME_LABELS[outcome]}
                  </Button>
                ))}
              </div>

              {draft.outcome === "valid" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`time-${lane.heatLaneId}`}>Official time</Label>
                    <Input
                      id={`time-${lane.heatLaneId}`}
                      placeholder="mm:ss.hh or ss.hh"
                      className="min-h-[48px] font-mono"
                      value={timeInputs[lane.heatLaneId] ?? ""}
                      onChange={(e) => {
                        const value = e.target.value;
                        setTimeInputs((prev) => ({ ...prev, [lane.heatLaneId]: value }));
                        setDrafts((prev) => ({
                          ...prev,
                          [lane.heatLaneId]: {
                            ...prev[lane.heatLaneId],
                            outcome: "valid",
                            officialTimeMs: parseTimeToMs(value),
                          },
                        }));
                        setSaved(false);
                      }}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`place-${lane.heatLaneId}`}>Finish place</Label>
                    <Input
                      id={`place-${lane.heatLaneId}`}
                      type="number"
                      min={1}
                      max={lanes.length}
                      className="min-h-[48px]"
                      value={draft.finishPlace ?? ""}
                      onChange={(e) => {
                        const place = e.target.value ? Number(e.target.value) : null;
                        setDrafts((prev) => ({
                          ...prev,
                          [lane.heatLaneId]: {
                            ...prev[lane.heatLaneId],
                            outcome: "valid",
                            finishPlace: place,
                          },
                        }));
                        setSaved(false);
                      }}
                    />
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
                    <SelectTrigger className="min-h-[48px] w-full">
                      <SelectValue />
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
                  No-Show: 0 points. Excluded from Skins qualification.
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

        <Button
          type="button"
          className="min-h-[48px] w-full sm:w-auto"
          disabled={!allReady || saving}
          onClick={() => void handleSave()}
        >
          {saving ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Save className="mr-2 size-4" />
          )}
          {saved ? "Draft saved" : "Save heat results"}
        </Button>
      </CardContent>
    </Card>
  );
}
