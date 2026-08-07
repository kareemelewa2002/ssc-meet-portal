import { describe, expect, it } from "vitest";
import {
  applyTelemetryFilters,
  buildEventStandings,
  buildPbTrajectory,
  deriveFilterOptions,
} from "@/lib/telemetry";
import { waBaseTimeKey, type WaBaseTimes } from "@/lib/wa-points";
import type { LiveEventView, LiveHeatView, LiveLaneView } from "@/lib/live-heats";
import type { Gender, ResultOutcome } from "@/lib/supabase/types";

function lane(overrides: Partial<LiveLaneView> & { laneNumber: number }): LiveLaneView {
  return {
    athleteId: `a${overrides.laneNumber}`,
    athleteName: `Swimmer ${overrides.laneNumber}`,
    teamName: "Riptide",
    gender: "female",
    ageGroup: "Open",
    seedTimeMs: 30_000,
    isNt: false,
    awaitingApproval: false,
    result: null,
    ...overrides,
  };
}

function timed(laneNumber: number, ms: number, outcome: ResultOutcome = "valid"): LiveLaneView {
  return lane({
    laneNumber,
    result: {
      outcome,
      officialTimeMs: outcome === "valid" ? ms : null,
      finishPlace: null,
      dqCode: null,
      status: "published",
    },
  });
}

function heat(
  heatNumber: number,
  lanes: LiveLaneView[],
  gender: Gender | null = "female",
): LiveHeatView {
  return {
    heatId: `h${heatNumber}`,
    heatNumber,
    heatGroup: "U17_OPEN",
    gender,
    status: "published",
    skinsRound: null,
    skinsSwimOff: false,
    skinsCategory: null,
    lanes,
  };
}

function event(overrides: Partial<LiveEventView> = {}): LiveEventView {
  return {
    eventId: "ev1",
    name: "50m Freestyle",
    stroke: "Freestyle",
    distanceM: 50,
    isSkins: false,
    sessionId: "s1",
    sessionNumber: 1,
    heats: [heat(1, [timed(4, 29_000)])],
    ...overrides,
  };
}

describe("deriveFilterOptions", () => {
  it("collects only the strokes, distances, and genders actually present", () => {
    const options = deriveFilterOptions([
      event({ eventId: "a", stroke: "Freestyle", distanceM: 50, heats: [heat(1, [], "female")] }),
      event({ eventId: "b", stroke: "Butterfly", distanceM: 100, heats: [heat(1, [], "male")] }),
    ]);
    expect(options.strokes).toEqual(["Butterfly", "Freestyle"]);
    expect(options.distances).toEqual([50, 100]);
    expect(options.genders).toEqual(["female", "male"]);
  });

  it("ignores heats with no gender rather than inventing one", () => {
    const options = deriveFilterOptions([event({ heats: [heat(1, [], null)] })]);
    expect(options.genders).toEqual([]);
  });
});

describe("applyTelemetryFilters", () => {
  const events = [
    event({ eventId: "a", stroke: "Freestyle", distanceM: 50, heats: [heat(1, [], "female")] }),
    event({ eventId: "b", stroke: "Freestyle", distanceM: 100, heats: [heat(1, [], "male")] }),
    event({ eventId: "c", stroke: "Butterfly", distanceM: 50, heats: [heat(1, [], "female")] }),
  ];

  it("passes everything through when nothing is filtered", () => {
    expect(
      applyTelemetryFilters(events, { gender: "all", stroke: "all", distance: "all" }),
    ).toHaveLength(3);
  });

  it("filters by stroke and by distance independently", () => {
    const byStroke = applyTelemetryFilters(events, {
      gender: "all",
      stroke: "Freestyle",
      distance: "all",
    });
    expect(byStroke.map((e) => e.eventId)).toEqual(["a", "b"]);

    const byDistance = applyTelemetryFilters(events, {
      gender: "all",
      stroke: "all",
      distance: "50",
    });
    expect(byDistance.map((e) => e.eventId)).toEqual(["a", "c"]);
  });

  it("drops events whose every heat is filtered out by gender", () => {
    const result = applyTelemetryFilters(events, {
      gender: "male",
      stroke: "all",
      distance: "all",
    });
    expect(result.map((e) => e.eventId)).toEqual(["b"]);
  });

  it("narrows an event's heats without mutating the source event", () => {
    const source = [event({ heats: [heat(1, [], "female"), heat(2, [], "male")] })];
    const result = applyTelemetryFilters(source, {
      gender: "male",
      stroke: "all",
      distance: "all",
    });
    expect(result[0].heats.map((h) => h.heatNumber)).toEqual([2]);
    expect(source[0].heats).toHaveLength(2);
  });
});

describe("buildEventStandings", () => {
  const baseTimes: WaBaseTimes = new Map([
    [waBaseTimeKey("Freestyle", 50, "female"), 24_000],
  ]);

  it("ranks across every heat, not within each heat", () => {
    const standings = buildEventStandings(
      event({
        heats: [heat(1, [timed(4, 31_000)]), heat(2, [timed(4, 29_500), timed(5, 30_000)])],
      }),
      baseTimes,
    );
    expect(standings.map((s) => s.officialTimeMs)).toEqual([29_500, 30_000, 31_000]);
    expect(standings.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it("gives tied times the same place and skips the place they consumed", () => {
    const standings = buildEventStandings(
      event({ heats: [heat(1, [timed(3, 29_000), timed(4, 30_000), timed(5, 30_000), timed(6, 31_000)])] }),
      baseTimes,
    );
    expect(standings.map((s) => s.rank)).toEqual([1, 2, 2, 4]);
  });

  it("lists DQs and unswum entries but leaves them unranked and last", () => {
    const standings = buildEventStandings(
      event({
        heats: [heat(1, [timed(3, 30_000), timed(4, 0, "dq"), lane({ laneNumber: 5 })])],
      }),
      baseTimes,
    );
    expect(standings).toHaveLength(3);
    expect(standings[0].rank).toBe(1);
    expect(standings[1].rank).toBeNull();
    expect(standings[2].rank).toBeNull();
  });

  it("computes the delta against the seed, negative when faster", () => {
    const standings = buildEventStandings(
      event({ heats: [heat(1, [timed(4, 29_000)])] }),
      baseTimes,
    );
    expect(standings[0].deltaMs).toBe(-1_000);
  });

  it("leaves the delta null when the entry was seeded NT", () => {
    const nt = timed(4, 29_000);
    const standings = buildEventStandings(
      event({ heats: [heat(1, [{ ...nt, seedTimeMs: null, isNt: true }])] }),
      baseTimes,
    );
    expect(standings[0].deltaMs).toBeNull();
  });

  it("rates a valid swim and refuses to rate one with no base time on file", () => {
    const rated = buildEventStandings(event({ heats: [heat(1, [timed(4, 24_000)])] }), baseTimes);
    expect(rated[0].waPoints).toBe(1000);

    const unrateable = buildEventStandings(
      event({ stroke: "Butterfly", heats: [heat(1, [timed(4, 24_000)])] }),
      baseTimes,
    );
    expect(unrateable[0].waPoints).toBeNull();
  });

  it("never awards points for a DQ, even with a base time on file", () => {
    const standings = buildEventStandings(
      event({ heats: [heat(1, [timed(4, 24_000, "dq")])] }),
      baseTimes,
    );
    expect(standings[0].waPoints).toBeNull();
  });
});

describe("buildPbTrajectory", () => {
  const results = [
    { stroke: "Freestyle", distanceM: 50, officialTimeMs: 30_000, outcome: "valid" as const, volumeName: "Vol. 1", swamAt: "2024-01-01" },
    { stroke: "Freestyle", distanceM: 50, officialTimeMs: 29_000, outcome: "valid" as const, volumeName: "Vol. 2", swamAt: "2024-06-01" },
    { stroke: "Freestyle", distanceM: 50, officialTimeMs: 29_500, outcome: "valid" as const, volumeName: "Vol. 3", swamAt: "2025-01-01" },
    { stroke: "Butterfly", distanceM: 50, officialTimeMs: 28_000, outcome: "valid" as const, volumeName: "Vol. 2", swamAt: "2024-06-01" },
    { stroke: "Freestyle", distanceM: 50, officialTimeMs: null, outcome: "dq" as const, volumeName: "Vol. 4", swamAt: "2025-06-01" },
  ];

  it("returns only the matching stroke and distance, in chronological order", () => {
    const points = buildPbTrajectory(results, "Freestyle", 50);
    expect(points.map((p) => p.volumeName)).toEqual(["Vol. 1", "Vol. 2", "Vol. 3"]);
  });

  it("marks a swim as a personal best only when it beat everything before it", () => {
    const points = buildPbTrajectory(results, "Freestyle", 50);
    expect(points.map((p) => p.isPersonalBest)).toEqual([true, true, false]);
  });

  it("measures each delta against the previous swim, not against the best", () => {
    const points = buildPbTrajectory(results, "Freestyle", 50);
    expect(points.map((p) => p.deltaMs)).toEqual([null, -1_000, 500]);
  });

  it("returns nothing for an event the swimmer has never swum", () => {
    expect(buildPbTrajectory(results, "Backstroke", 100)).toEqual([]);
  });
});
