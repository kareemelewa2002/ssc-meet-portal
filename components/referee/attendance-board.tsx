"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, UserRoundX, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, getErrorMessage, isValidUuid } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  applyAttendancePatch,
  setLaneAttendance,
  summarizeAttendance,
  type AttendanceLane,
} from "@/lib/attendance";
import type { AttendanceStatus } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";

export function AttendanceBoard({
  lanes: initialLanes,
  outdoorMode = false,
  className,
}: {
  lanes: AttendanceLane[];
  outdoorMode?: boolean;
  className?: string;
}) {
  const [lanes, setLanes] = useState<AttendanceLane[]>(initialLanes);
  const [savingLaneId, setSavingLaneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = summarizeAttendance(lanes);

  // The parent owns which heat is selected and re-fetches lanes on switch —
  // resync local state whenever it hands us a new lane list.
  useEffect(() => {
    setLanes(initialLanes);
  }, [initialLanes]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("referee-attendance")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "heat_lanes" },
        (payload) => {
          const row = payload.new as { id?: string; attendance_status?: AttendanceStatus };
          if (!row.id || !row.attendance_status) return;
          setLanes((prev) => applyAttendancePatch(prev, row.id!, row.attendance_status!));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const markAttendance = async (heatLaneId: string, status: Exclude<AttendanceStatus, "pending">) => {
    setError(null);

    // A second tap on the active status clears it back to pending — the
    // same toggle-off behavior the retired usher call-room offered.
    const current = lanes.find((l) => l.heatLaneId === heatLaneId)?.attendanceStatus;
    const nextStatus: AttendanceStatus = current === status ? "pending" : status;

    setLanes((prev) => setLaneAttendance(prev, heatLaneId, status));

    // A demo/placeholder lane (no real heat selected yet) is never a real
    // database row — keep the optimistic local toggle for UI review, but
    // never send it to Supabase (CRITICAL: this used to always fire the
    // write regardless, 400ing with "invalid input syntax for type uuid").
    if (!isValidUuid(heatLaneId)) return;

    setSavingLaneId(heatLaneId);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("heat_lanes")
        .update({ attendance_status: nextStatus })
        .eq("id", heatLaneId);
      if (updateError) throw updateError;
    } catch (err) {
      setError(getErrorMessage(err, "Could not save attendance."));
    } finally {
      setSavingLaneId(null);
    }
  };

  return (
    <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black text-yellow-300", className)}>
      <CardHeader>
        <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
          Call-room attendance
        </CardTitle>
        <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
          Check in swimmers behind the blocks before you start the heat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Badge variant={summary.readyForStart ? "default" : "outline"}>
          <Users className="mr-1 size-3.5" />
          {summary.present}/{summary.total} present · {summary.pending} pending
          {summary.readyForStart ? " · Ready to start" : ""}
        </Badge>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="space-y-2">
          {lanes.map((lane) => (
            <div
              key={lane.heatLaneId}
              className={cn(
                "space-y-2 rounded-lg border p-3",
                outdoorMode ? "border-yellow-300/30" : "border-border",
              )}
            >
              <div className="flex items-center gap-3">
                <div className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-md bg-muted text-sm font-bold">
                  L{lane.laneNumber}
                </div>
                <div className="min-w-0 flex-1">
                  <AthleteLink
                    athleteId={lane.athleteId}
                    name={lane.athleteName}
                    className={cn("truncate font-semibold", outdoorMode && "text-yellow-300")}
                  />
                  {lane.teamName && (
                    <p className={cn("truncate text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}>
                      {lane.teamName}
                    </p>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  className={cn(
                    "min-h-[48px] text-base font-semibold",
                    lane.attendanceStatus === "present" && "bg-emerald-600 hover:bg-emerald-600",
                  )}
                  variant={lane.attendanceStatus === "present" ? "default" : "outline"}
                  disabled={savingLaneId === lane.heatLaneId}
                  onClick={() => void markAttendance(lane.heatLaneId, "present")}
                >
                  {savingLaneId === lane.heatLaneId ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Check className="mr-2 size-4" />
                  )}
                  Present
                </Button>
                <Button
                  type="button"
                  variant={lane.attendanceStatus === "absent" ? "destructive" : "outline"}
                  className="min-h-[48px] text-base font-semibold"
                  disabled={savingLaneId === lane.heatLaneId}
                  onClick={() => void markAttendance(lane.heatLaneId, "absent")}
                >
                  {savingLaneId === lane.heatLaneId ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <UserRoundX className="mr-2 size-4" />
                  )}
                  Absent
                </Button>
              </div>
            </div>
          ))}
          {lanes.length === 0 && (
            <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
              No lanes seeded for this heat yet.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
