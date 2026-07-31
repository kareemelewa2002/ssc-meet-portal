"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  applyAttendancePatch,
  ATTENDANCE_LABELS,
  summarizeAttendance,
  type AttendanceLane,
} from "@/lib/attendance";
import type { AttendanceStatus } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";

const DEMO_LANES: AttendanceLane[] = [
  { heatLaneId: "hl-1", laneNumber: 1, athleteId: "ath-mia", athleteName: "Mia Reyes", teamName: "Blue Marlins", attendanceStatus: "pending" },
  { heatLaneId: "hl-2", laneNumber: 2, athleteId: "ath-noah", athleteName: "Noah Alvi", teamName: "Riptide", attendanceStatus: "present" },
  { heatLaneId: "hl-3", laneNumber: 3, athleteId: "ath-zara", athleteName: "Zara Khan", teamName: "Blue Marlins", attendanceStatus: "pending" },
  { heatLaneId: "hl-4", laneNumber: 4, athleteId: "ath-leo", athleteName: "Leo Fontaine", teamName: "Tidal Wave", attendanceStatus: "present" },
  { heatLaneId: "hl-5", laneNumber: 5, athleteId: "ath-ava", athleteName: "Ava Thompson", teamName: "Riptide", attendanceStatus: "absent" },
  { heatLaneId: "hl-6", laneNumber: 6, athleteId: "ath-kian", athleteName: "Kian Osei", teamName: "Tidal Wave", attendanceStatus: "pending" },
];

export function AttendanceBoard({
  outdoorMode = false,
  className,
}: {
  outdoorMode?: boolean;
  className?: string;
}) {
  const [lanes, setLanes] = useState<AttendanceLane[]>(DEMO_LANES);
  const summary = summarizeAttendance(lanes);

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

  return (
    <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black text-yellow-300", className)}>
      <CardHeader>
        <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
          Call-room attendance
        </CardTitle>
        <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
          Live from Ushers — know who to expect behind the blocks before you start the heat.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Badge variant={summary.readyForStart ? "default" : "outline"}>
          {summary.present}/{summary.total} present · {summary.pending} pending
          {summary.readyForStart ? " · Ready to start" : ""}
        </Badge>
        <div className="space-y-2">
          {lanes.map((lane) => (
            <div
              key={lane.heatLaneId}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3",
                outdoorMode ? "border-yellow-300/30" : "border-border",
              )}
            >
              <div className="flex min-h-[48px] min-w-[48px] items-center justify-center rounded-md bg-muted text-sm font-bold">
                L{lane.laneNumber}
              </div>
              <div className="min-w-0 flex-1">
                <AthleteLink
                  athleteId={lane.athleteId}
                  name={lane.athleteName}
                  className={cn("truncate", outdoorMode && "text-yellow-300")}
                />
                {lane.teamName && (
                  <p className={cn("text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}>
                    {lane.teamName}
                  </p>
                )}
              </div>
              <Badge
                variant={
                  lane.attendanceStatus === "present"
                    ? "default"
                    : lane.attendanceStatus === "absent"
                      ? "destructive"
                      : "outline"
                }
                className="min-h-[32px] capitalize"
              >
                {ATTENDANCE_LABELS[lane.attendanceStatus]}
              </Badge>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
