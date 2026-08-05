import { describe, expect, it } from "vitest";
import {
  computeWaPoints,
  formatWaPoints,
  waBaseTimeKey,
  waPointsFor,
  type WaBaseTimes,
} from "@/lib/wa-points";

const baseTimes: WaBaseTimes = new Map([
  [waBaseTimeKey("Freestyle", 50, "male"), 19_900],
  [waBaseTimeKey("Freestyle", 50, "female"), 22_830],
  [waBaseTimeKey("Individual Medley", 100, "female"), 56_510],
]);

describe("computeWaPoints — 1000 x (base / swum)^3, floored", () => {
  it("scores 1000 for a swim exactly on the base time", () => {
    expect(computeWaPoints(19_900, 19_900)).toBe(1000);
  });

  it("scores below 1000 for a slower swim and above for a faster one", () => {
    // 25.00s against a 19.90s base: 1000 * (19.9/25)^3 = 504.
    expect(computeWaPoints(19_900, 25_000)).toBe(504);
    // Half the base time is eight times the points.
    expect(computeWaPoints(20_000, 10_000)).toBe(8000);
  });

  it("floors rather than rounds, matching public.world_aquatics_points", () => {
    // 1000 * (19900/19910)^3 = 998.49...
    expect(computeWaPoints(19_900, 19_910)).toBe(998);
  });

  it("is null — never 0 — when there is nothing to score", () => {
    // An event with no base time on file is unrateable by design (relays,
    // Skins, the switch events). A 0 would read as a real score of nought.
    expect(computeWaPoints(null, 25_000)).toBeNull();
    expect(computeWaPoints(undefined, 25_000)).toBeNull();
    expect(computeWaPoints(19_900, null)).toBeNull();
    expect(computeWaPoints(19_900, 0)).toBeNull();
    expect(computeWaPoints(0, 25_000)).toBeNull();
    expect(computeWaPoints(19_900, -1)).toBeNull();
  });
});

describe("waPointsFor — looks the base time up by stroke, distance and gender", () => {
  it("scores a rateable swim", () => {
    expect(
      waPointsFor(baseTimes, {
        stroke: "Freestyle",
        distanceM: 50,
        gender: "male",
        officialTimeMs: 25_000,
      }),
    ).toBe(504);
  });

  it("keeps the genders on separate base times", () => {
    const male = waPointsFor(baseTimes, {
      stroke: "Freestyle",
      distanceM: 50,
      gender: "male",
      officialTimeMs: 25_000,
    });
    const female = waPointsFor(baseTimes, {
      stroke: "Freestyle",
      distanceM: 50,
      gender: "female",
      officialTimeMs: 25_000,
    });
    expect(male).not.toBe(female);
  });

  it("returns null for an event with no base time on file", () => {
    // The 50m stroke-switch events have no points system at all.
    expect(
      waPointsFor(baseTimes, {
        stroke: "Freestyle/Backstroke Switch",
        distanceM: 50,
        gender: "male",
        officialTimeMs: 25_000,
      }),
    ).toBeNull();
    // Right stroke, wrong distance — still unrated, not approximated.
    expect(
      waPointsFor(baseTimes, {
        stroke: "Freestyle",
        distanceM: 200,
        gender: "male",
        officialTimeMs: 120_000,
      }),
    ).toBeNull();
  });

  it("returns null for a DQ or NS, which produced no time", () => {
    expect(
      waPointsFor(baseTimes, {
        stroke: "Freestyle",
        distanceM: 50,
        gender: "male",
        officialTimeMs: null,
      }),
    ).toBeNull();
  });
});

describe("formatWaPoints", () => {
  it("shows an em dash for unrated, and the number otherwise", () => {
    expect(formatWaPoints(null)).toBe("—");
    expect(formatWaPoints(undefined)).toBe("—");
    expect(formatWaPoints(504)).toBe("504");
    // A genuine zero-point swim still prints 0 — it is only "unrated" that
    // must never be shown as a score.
    expect(formatWaPoints(0)).toBe("0");
  });
});
