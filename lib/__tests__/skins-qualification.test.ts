import { describe, expect, it } from "vitest";
import {
  applySkinsRollover,
  buildSkinsQualifierBoards,
  nextRolloverAthlete,
  populateSkinsHeatSheets,
  SKINS_SLOTS_PER_CATEGORY,
  type SkinsCandidate,
} from "@/lib/skins-qualification";
import { LANE_SEQUENCE } from "@/lib/seeding";

function candidate(
  overrides: Partial<SkinsCandidate> & Pick<SkinsCandidate, "athleteId" | "sourceRank">,
): SkinsCandidate {
  return {
    athleteId: overrides.athleteId,
    athleteName: overrides.athleteName ?? overrides.athleteId,
    teamName: overrides.teamName ?? null,
    category: overrides.category ?? "Open",
    sourceRank: overrides.sourceRank,
    bestTimeMs: overrides.bestTimeMs ?? 20000 + overrides.sourceRank * 100,
    response: overrides.response ?? "pending",
  };
}

describe("applySkinsRollover", () => {
  it("keeps the top 6 non-declined athletes as active qualifiers", () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate({ athleteId: `a${i + 1}`, sourceRank: i + 1 }),
    );

    const result = applySkinsRollover(candidates);

    expect(result.filter((q) => q.isActiveQualifier)).toHaveLength(SKINS_SLOTS_PER_CATEGORY);
    expect(result.slice(0, 6).every((q) => q.isActiveQualifier)).toBe(true);
    expect(result[6].isActiveQualifier).toBe(false);
    expect(result[0].slotNumber).toBe(1);
    expect(result[5].slotNumber).toBe(6);
  });

  it("rolls a declined top-6 slot to the 7th-place swimmer", () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate({
        athleteId: `a${i + 1}`,
        sourceRank: i + 1,
        response: i + 1 === 3 ? "declined" : "pending",
      }),
    );

    const result = applySkinsRollover(candidates);
    const activeIds = result.filter((q) => q.isActiveQualifier).map((q) => q.athleteId);

    expect(activeIds).toEqual(["a1", "a2", "a4", "a5", "a6", "a7"]);
    expect(result.find((q) => q.athleteId === "a3")?.isActiveQualifier).toBe(false);
    expect(result.find((q) => q.athleteId === "a8")?.isActiveQualifier).toBe(false);
  });

  it("continues rolling through multiple declines until 6 confirmed slots are filled", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      candidate({
        athleteId: `a${i + 1}`,
        sourceRank: i + 1,
        response: [1, 2, 4].includes(i + 1) ? "declined" : "accepted",
      }),
    );

    const result = applySkinsRollover(candidates);
    const active = result.filter((q) => q.isActiveQualifier);

    expect(active).toHaveLength(6);
    expect(active.map((q) => q.athleteId)).toEqual(["a3", "a5", "a6", "a7", "a8", "a9"]);
    expect(active.every((q) => q.isConfirmed)).toBe(true);
  });

  it("identifies the next rollover athlete when someone declines", () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate({ athleteId: `a${i + 1}`, sourceRank: i + 1, response: "pending" }),
    );

    const next = nextRolloverAthlete(candidates, "a2");
    expect(next?.athleteId).toBe("a7");
  });
});

describe("buildSkinsQualifierBoards", () => {
  it("applies rollover independently per age category", () => {
    const candidates: SkinsCandidate[] = [
      ...Array.from({ length: 7 }, (_, i) =>
        candidate({ athleteId: `u17-${i + 1}`, sourceRank: i + 1, category: "U17" }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        candidate({ athleteId: `open-${i + 1}`, sourceRank: i + 1, category: "Open" }),
      ),
    ];
    candidates[0] = { ...candidates[0], response: "declined" }; // u17-1 declines

    const boards = buildSkinsQualifierBoards(candidates);
    const u17 = boards.find((b) => b.category === "U17")!;
    const open = boards.find((b) => b.category === "Open")!;

    expect(u17.active.map((q) => q.athleteId)).toEqual([
      "u17-2",
      "u17-3",
      "u17-4",
      "u17-5",
      "u17-6",
      "u17-7",
    ]);
    expect(open.active).toHaveLength(3);
  });
});

describe("populateSkinsHeatSheets", () => {
  it("seeds accepted qualifiers into per-category heats with center-out lanes", () => {
    const accepted = Array.from({ length: 6 }, (_, i) =>
      candidate({
        athleteId: `open-${i + 1}`,
        sourceRank: i + 1,
        category: "Open",
        bestTimeMs: 25000 + i * 100,
        response: "accepted",
      }),
    );

    const heats = populateSkinsHeatSheets(accepted);
    expect(heats).toHaveLength(1);
    expect(heats[0].lanes).toHaveLength(6);
    expect(heats[0].lanes.map((l) => l.laneNumber)).toEqual([...LANE_SEQUENCE]);
    // Fastest accepted swimmer gets lane 4.
    expect(heats[0].lanes[0].athleteId).toBe("open-1");
    expect(heats[0].lanes[0].laneNumber).toBe(4);
  });

  it("ignores pending/declined athletes when building heat sheets", () => {
    const mixed: SkinsCandidate[] = [
      candidate({ athleteId: "a1", sourceRank: 1, response: "accepted", category: "U14" }),
      candidate({ athleteId: "a2", sourceRank: 2, response: "pending", category: "U14" }),
      candidate({ athleteId: "a3", sourceRank: 3, response: "declined", category: "U14" }),
    ];

    const heats = populateSkinsHeatSheets(mixed);
    expect(heats).toHaveLength(1);
    expect(heats[0].lanes.map((l) => l.athleteId)).toEqual(["a1"]);
  });
});
