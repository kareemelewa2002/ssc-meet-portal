"use client";

import { useEffect, useMemo, useState } from "react";
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
import { ClockTimeInput } from "@/components/ui/clock-time-input";
import { cn } from "@/lib/utils";
import {
  DQ_REASON_LABELS,
  RESULT_OUTCOME_LABELS,
  scoreHeatResult,
} from "@/lib/results";
import { createClient } from "@/lib/supabase/client";
import { CLOCK_TIME_ERROR } from "@/lib/format";
import { ATTENDANCE_LABELS } from "@/lib/attendance";
import { canEditLane, type LaneNumber, type RefereeDeckMode } from "@/lib/referee-lanes";
import type { AttendanceStatus, DqReason, ResultOutcome } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";

export interface HeatLaneAthlete {
  heatLaneId: string;
  laneNumber: number;
  athleteName: string;
  athleteId?: string;
  teamName?: string;
  seedTimeMs?: number | null;
  entryId?: string;
  attendanceStatus?: AttendanceStatus;
}

function attendanceBadgeVariant(status: AttendanceStatus): "default" | "destructive" | "outline" {
  if (status === "present") return "default";
  if (status === "absent") return "destructive";
  return "outline";
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
  /** Deck role: lane / chief / observer. */
  mode?: RefereeDeckMode;
  focusedLane?: LaneNumber | null;
  /** When true, overrides mode and disables all writes. */
  readOnly?: boolean;
  /** Chief can publish drafts as published. */
  allowPublish?: boolean;
}

const DQ_CODES = Object.keys(DQ_REASON_LABELS) as DqReason[];

function emptyDraft(): LaneDraft {
  return { outcome: null, officialTimeMs: null, finishPlace: null, dqCode: null };
}

export function HeatResultEntry({
  heatId,
  heatLabel = "Heat results",
  lanes,
  outdoorMode = false,
  onSaved,
  className,
  mode = "chief",
  focusedLane = null,
  readOnly = false,
  allowPublish = false,
}: HeatResultEntryProps) {
  const [drafts, setDrafts] = useState<Record<string, LaneDraft>>(() =>
    Object.fromEntries(lanes.map((l) => [l.heatLaneId, emptyDraft()])),
  );
  const [timeInputs, setTimeInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [attendance, setAttendance] = useState<Record<string, AttendanceStatus>>(() =>
    Object.fromEntries(lanes.map((l) => [l.heatLaneId, l.attendanceStatus ?? "pending"])),
  );

  const isObserver = readOnly || mode === "observer";

  useEffect(() => {
    const laneIds = new Set(lanes.map((l) => l.heatLaneId));
    const supabase = createClient();
    const channel = supabase
      .channel(`referee-heat-attendance-${heatId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "heat_lanes" },
        (payload) => {
          const row = payload.new as { id?: string; attendance_status?: AttendanceStatus };
          if (!row.id || !row.attendance_status || !laneIds.has(row.id)) return;
          setAttendance((prev) => ({ ...prev, [row.id!]: row.attendance_status! }));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [heatId, lanes]);

  const visibleLanes = useMemo(() => {
    if (mode === "lane" && focusedLane != null) {
      return lanes.filter((l) => l.laneNumber === focusedLane);
    }
    return lanes;
  }, [lanes, mode, focusedLane]);

  const writableLanes = useMemo(
    () =>
      visibleLanes.filter((lane) =>
        !isObserver && canEditLane(mode, focusedLane, lane.laneNumber),
      ),
    [visibleLanes, isObserver, mode, focusedLane],
  );

  const allReady = useMemo(
    () =>
      writableLanes.every((lane) => {
        const d = drafts[lane.heatLaneId];
        if (!d?.outcome) return false;
        if (d.outcome === "valid") {
          return d.officialTimeMs != null || d.finishPlace != null;
        }
        if (d.outcome === "dq") return d.dqCode != null;
        return true;
      }),
    [writableLanes, drafts],
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

  const handleSave = async (publish: boolean) => {
    if (isObserver) {
      setError("Observer mode is read-only.");
      return;
    }

    // Validate clock strings for valid outcomes before write.
    for (const lane of writableLanes) {
      const draft = drafts[lane.heatLaneId];
      if (draft?.outcome === "valid" && draft.officialTimeMs == null && (timeInputs[lane.heatLaneId] ?? "").trim()) {
        setError(CLOCK_TIME_ERROR);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const supabase = createClient();

      for (const lane of writableLanes) {
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
            status: publish && allowPublish ? "published" : "draft",
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
          Heat {heatId} —{" "}
          {isObserver
            ? "Read-only observer view of attendance and live result drafts."
            : mode === "lane"
              ? `Lane ${focusedLane} focus — edit only your assigned lane.`
              : "Chief Referee — full write access across all lanes; publish when ready."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {visibleLanes.map((lane) => {
          const draft = drafts[lane.heatLaneId] ?? emptyDraft();
          const editable =
            !isObserver && canEditLane(mode, focusedLane, lane.laneNumber);
          return (
            <div
              key={lane.heatLaneId}
              className={cn(
                "space-y-3 rounded-lg border p-3",
                outdoorMode ? "border-yellow-300/30" : "border-border",
                !editable && "opacity-80",
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
                <Badge
                  variant={attendanceBadgeVariant(attendance[lane.heatLaneId] ?? "pending")}
                  className="h-7 shrink-0 px-2 text-xs"
                >
                  {ATTENDANCE_LABELS[attendance[lane.heatLaneId] ?? "pending"]}
                </Badge>
                {!editable && (
                  <Badge variant="outline" className="h-7">
                    {isObserver ? "Read-only" : "Locked"}
                  </Badge>
                )}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(["valid", "dq", "no_show"] as ResultOutcome[]).map((outcome) => (
                  <Button
                    key={outcome}
                    type="button"
                    variant={draft.outcome === outcome ? "default" : "outline"}
                    disabled={!editable}
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
                  <ClockTimeInput
                    id={`time-${lane.heatLaneId}`}
                    label="Official time"
                    value={timeInputs[lane.heatLaneId] ?? ""}
                    disabled={!editable}
                    outdoorMode={outdoorMode}
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
                    <Label htmlFor={`place-${lane.heatLaneId}`}>Finish place</Label>
                    <Input
                      id={`place-${lane.heatLaneId}`}
                      type="number"
                      min={1}
                      max={lanes.length}
                      disabled={!editable}
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
                    disabled={!editable}
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

        {!isObserver && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="min-h-[48px] w-full sm:w-auto"
              disabled={!allReady || saving || writableLanes.length === 0}
              onClick={() => void handleSave(false)}
            >
              {saving ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Save className="mr-2 size-4" />
              )}
              {saved ? "Draft saved" : "Save heat results"}
            </Button>
            {allowPublish && mode === "chief" && (
              <Button
                type="button"
                variant="secondary"
                className="min-h-[48px] w-full sm:w-auto"
                disabled={!allReady || saving || writableLanes.length === 0}
                onClick={() => void handleSave(true)}
              >
                Publish final heat results
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
