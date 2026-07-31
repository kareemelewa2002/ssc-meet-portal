import { describe, expect, it } from "vitest";
import {
  DEMO_ALL_TIME_RACES,
  rankBestPerformances,
  rankBestPerformers,
  type RacePerformance,
} from "@/lib/all-time-rankings";

describe("rankBestPerformances", () => {
  it("ranks individual race times and allows the same athlete multiple times", () => {
    const ranked = rankBestPerformances(DEMO_ALL_TIME_RACES, {
      stroke: "Freestyle",
      distanceM: 50,
      ageGroup: "Open",
      gender: "male",
    });

    expect(ranked[0].athleteName).toBe("Leo Fontaine");
    expect(ranked[0].officialTimeMs).toBe(23800);
    expect(ranked.filter((r) => r.athleteId === "ath-leo").length).toBeGreaterThan(1);
    expect(ranked.every((r) => r.rank <= 10)).toBe(true);
  });

  it("applies dense ranking for tied times", () => {
    const races: RacePerformance[] = [
      {
        resultId: "1",
        athleteId: "a",
        athleteName: "A",
        gender: "male",
        ageGroup: "Open",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 25000,
        swamAt: "2026-01-01",
      },
      {
        resultId: "2",
        athleteId: "b",
        athleteName: "B",
        gender: "male",
        ageGroup: "Open",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 25000,
        swamAt: "2026-01-02",
      },
      {
        resultId: "3",
        athleteId: "c",
        athleteName: "C",
        gender: "male",
        ageGroup: "Open",
        stroke: "Freestyle",
        distanceM: 50,
        officialTimeMs: 25100,
        swamAt: "2026-01-03",
      },
    ];
    const ranked = rankBestPerformances(races, {
      stroke: "Freestyle",
      distanceM: 50,
      gender: "male",
      ageGroup: "Open",
    });
    expect(ranked[0].rank).toBe(1);
    expect(ranked[1].rank).toBe(1);
    expect(ranked[2].rank).toBe(2);
  });
});

describe("rankBestPerformers", () => {
  it("collapses to each athlete's single fastest time before ranking", () => {
    const ranked = rankBestPerformers(DEMO_ALL_TIME_RACES, {
      stroke: "Freestyle",
      distanceM: 50,
      ageGroup: "Open",
      gender: "male",
    });

    const leo = ranked.find((r) => r.athleteId === "ath-leo");
    expect(leo?.bestTimeMs).toBe(23800);
    expect(leo?.racesCounted).toBe(2);
    expect(ranked.filter((r) => r.athleteId === "ath-leo")).toHaveLength(1);
    expect(ranked[0].athleteId).toBe("ath-leo");
  });

  it("filters by age group and gender", () => {
    const ranked = rankBestPerformers(DEMO_ALL_TIME_RACES, {
      stroke: "Freestyle",
      distanceM: 50,
      ageGroup: "U17",
      gender: "female",
    });
    expect(ranked.every((r) => r.gender === "female" && r.ageGroup === "U17")).toBe(true);
    expect(ranked[0].athleteName).toBe("Zara Khan");
  });
});
