import { describe, expect, it } from "vitest";
import {
  compareResultStanding,
  isEligibleForSkinsQualification,
  resultStandingTier,
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

describe("DQ and NS sort to the very bottom of a standing", () => {
  const row = (
    outcome: "valid" | "dq" | "no_show" | null,
    place: number | null = null,
    officialTimeMs: number | null = null,
  ) => ({ outcome, place, officialTimeMs });

  it("tiers valid above DQ above NS above nothing recorded", () => {
    expect(resultStandingTier("valid")).toBeLessThan(resultStandingTier("dq"));
    // A DQ swam and an NS did not, which is the order a sheet reads in.
    expect(resultStandingTier("dq")).toBeLessThan(resultStandingTier("no_show"));
    expect(resultStandingTier("no_show")).toBeLessThan(resultStandingTier(null));
  });

  it("puts every valid swim above every DQ and NS, whatever their places", () => {
    const rows = [
      row("no_show"),
      row("valid", 3, 31_000),
      row("dq"),
      row("valid", 1, 29_000),
      row("valid", 2, 30_000),
    ];
    expect(rows.sort(compareResultStanding).map((r) => r.outcome)).toEqual([
      "valid",
      "valid",
      "valid",
      "dq",
      "no_show",
    ]);
  });

  it("ranks the valid tier by place", () => {
    const rows = [row("valid", 3, 31_000), row("valid", 1, 29_000), row("valid", 2, 30_000)];
    expect(rows.sort(compareResultStanding).map((r) => r.place)).toEqual([1, 2, 3]);
  });

  it("falls back to time when a place has not been computed yet", () => {
    // Mid-entry, before recompute_heat_finish_places has run: rank by the
    // time, never by lane number, which is where a swimmer was put rather
    // than how they finished.
    const rows = [row("valid", null, 31_000), row("valid", null, 29_000)];
    expect(rows.sort(compareResultStanding).map((r) => r.officialTimeMs)).toEqual([29_000, 31_000]);
  });

  it("keeps a placed swim above an unplaced one within the valid tier", () => {
    const rows = [row("valid", null, 28_000), row("valid", 4, 32_000)];
    expect(rows.sort(compareResultStanding).map((r) => r.place)).toEqual([4, null]);
  });

  it("is stable for two rows that are genuinely equal", () => {
    expect(compareResultStanding(row("dq"), row("dq"))).toBe(0);
    expect(compareResultStanding(row("valid", 1, 29_000), row("valid", 1, 29_000))).toBe(0);
  });
});
