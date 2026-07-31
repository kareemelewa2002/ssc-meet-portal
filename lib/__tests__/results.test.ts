import { describe, expect, it } from "vitest";
import {
  isEligibleForSkinsQualification,
  scoreHeatResult,
} from "@/lib/results";

describe("scoreHeatResult", () => {
  it("awards placement points for a valid finish and optional improvement points", () => {
    const scored = scoreHeatResult({
      outcome: "valid",
      finishPlace: 1,
      seedTimeMs: 30000,
      officialTimeMs: 29000,
      maxPlacementPoints: 6,
    });

    expect(scored.resultOutcome).toBe("valid");
    expect(scored.placementPoints).toBe(6);
    expect(scored.improvementPoints).toBeGreaterThan(0);
    expect(scored.isNoShow).toBe(false);
    expect(scored.dqCode).toBeNull();
  });

  it("gives 0 placement and 0 improvement points for DQ", () => {
    const scored = scoreHeatResult(
      { outcome: "dq", finishPlace: 1, officialTimeMs: 28000 },
      "false_start",
    );

    expect(scored.resultOutcome).toBe("dq");
    expect(scored.placementPoints).toBe(0);
    expect(scored.improvementPoints).toBe(0);
    expect(scored.officialTimeMs).toBeNull();
    expect(scored.finishPlace).toBeNull();
    expect(scored.dqCode).toBe("false_start");
    expect(scored.isNoShow).toBe(false);
  });

  it("requires a dq_code for DQ outcomes", () => {
    expect(() => scoreHeatResult({ outcome: "dq" }, null)).toThrow(/dq_code/i);
  });

  it("gives 0 points for NS and flags isNoShow", () => {
    const scored = scoreHeatResult({
      outcome: "no_show",
      finishPlace: 2,
      officialTimeMs: 30000,
    });

    expect(scored.resultOutcome).toBe("no_show");
    expect(scored.placementPoints).toBe(0);
    expect(scored.improvementPoints).toBe(0);
    expect(scored.isNoShow).toBe(true);
    expect(scored.officialTimeMs).toBeNull();
    expect(scored.dqCode).toBeNull();
  });

  it("excludes NS (and DQ) from Skins qualification eligibility", () => {
    expect(isEligibleForSkinsQualification("valid")).toBe(true);
    expect(isEligibleForSkinsQualification("dq")).toBe(false);
    expect(isEligibleForSkinsQualification("no_show")).toBe(false);
  });
});
