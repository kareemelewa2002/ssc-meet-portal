import { describe, expect, it } from "vitest";
import {
  applyAttendancePatch,
  setLaneAttendance,
  summarizeAttendance,
  type AttendanceLane,
} from "@/lib/attendance";

function lane(
  overrides: Partial<AttendanceLane> & Pick<AttendanceLane, "heatLaneId" | "laneNumber">,
): AttendanceLane {
  return {
    heatLaneId: overrides.heatLaneId,
    laneNumber: overrides.laneNumber,
    athleteId: overrides.athleteId ?? overrides.heatLaneId,
    athleteName: overrides.athleteName ?? "Swimmer",
    teamName: overrides.teamName ?? null,
    attendanceStatus: overrides.attendanceStatus ?? "pending",
  };
}

describe("setLaneAttendance", () => {
  it("marks a lane present", () => {
    const lanes = [lane({ heatLaneId: "a", laneNumber: 1 })];
    const next = setLaneAttendance(lanes, "a", "present");
    expect(next[0].attendanceStatus).toBe("present");
  });

  it("toggles the same status back to pending", () => {
    const lanes = [lane({ heatLaneId: "a", laneNumber: 1, attendanceStatus: "absent" })];
    const next = setLaneAttendance(lanes, "a", "absent");
    expect(next[0].attendanceStatus).toBe("pending");
  });

  it("switches from present to absent", () => {
    const lanes = [lane({ heatLaneId: "a", laneNumber: 1, attendanceStatus: "present" })];
    const next = setLaneAttendance(lanes, "a", "absent");
    expect(next[0].attendanceStatus).toBe("absent");
  });
});

describe("summarizeAttendance", () => {
  it("counts present / absent / pending and readiness", () => {
    const lanes = [
      lane({ heatLaneId: "1", laneNumber: 1, attendanceStatus: "present" }),
      lane({ heatLaneId: "2", laneNumber: 2, attendanceStatus: "present" }),
      lane({ heatLaneId: "3", laneNumber: 3, attendanceStatus: "absent" }),
      lane({ heatLaneId: "4", laneNumber: 4, attendanceStatus: "pending" }),
    ];
    const summary = summarizeAttendance(lanes);
    expect(summary).toEqual({
      total: 4,
      present: 2,
      absent: 1,
      pending: 1,
      readyForStart: false,
    });
  });

  it("marks readyForStart when no lanes are pending", () => {
    const lanes = [
      lane({ heatLaneId: "1", laneNumber: 1, attendanceStatus: "present" }),
      lane({ heatLaneId: "2", laneNumber: 2, attendanceStatus: "absent" }),
    ];
    expect(summarizeAttendance(lanes).readyForStart).toBe(true);
  });
});

describe("applyAttendancePatch", () => {
  it("merges realtime updates by heat lane id", () => {
    const lanes = [
      lane({ heatLaneId: "a", laneNumber: 1, attendanceStatus: "pending" }),
      lane({ heatLaneId: "b", laneNumber: 2, attendanceStatus: "pending" }),
    ];
    const next = applyAttendancePatch(lanes, "b", "present");
    expect(next[1].attendanceStatus).toBe("present");
    expect(next[0].attendanceStatus).toBe("pending");
  });
});
