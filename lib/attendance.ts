import type { AttendanceStatus } from "@/lib/supabase/types";

export const ATTENDANCE_LABELS: Record<AttendanceStatus, string> = {
  pending: "Pending",
  present: "Present",
  absent: "Absent",
};

export interface AttendanceLane {
  heatLaneId: string;
  laneNumber: number;
  athleteId: string;
  athleteName: string;
  teamName?: string | null;
  attendanceStatus: AttendanceStatus;
}

export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  pending: number;
  readyForStart: boolean;
}

/** Pure toggle helper for Present / Absent call-room buttons. */
export function setLaneAttendance(
  lanes: AttendanceLane[],
  heatLaneId: string,
  status: Exclude<AttendanceStatus, "pending">,
): AttendanceLane[] {
  return lanes.map((lane) =>
    lane.heatLaneId === heatLaneId
      ? {
          ...lane,
          // Tap the active status again to clear back to pending.
          attendanceStatus: lane.attendanceStatus === status ? "pending" : status,
        }
      : lane,
  );
}

export function summarizeAttendance(lanes: AttendanceLane[]): AttendanceSummary {
  const present = lanes.filter((l) => l.attendanceStatus === "present").length;
  const absent = lanes.filter((l) => l.attendanceStatus === "absent").length;
  const pending = lanes.filter((l) => l.attendanceStatus === "pending").length;
  return {
    total: lanes.length,
    present,
    absent,
    pending,
    // Referees can start once every lane is decided (no pending left).
    readyForStart: lanes.length > 0 && pending === 0,
  };
}

/** Merge a realtime attendance patch into local lane state. */
export function applyAttendancePatch(
  lanes: AttendanceLane[],
  heatLaneId: string,
  status: AttendanceStatus,
): AttendanceLane[] {
  return lanes.map((lane) =>
    lane.heatLaneId === heatLaneId ? { ...lane, attendanceStatus: status } : lane,
  );
}
