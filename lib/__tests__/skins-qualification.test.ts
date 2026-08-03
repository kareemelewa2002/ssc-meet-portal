import { describe, expect, it } from "vitest";
import {
  applySkinsRollover,
  buildSkinsQualifierBoards,
  detectQualifyingSwimOff,
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
    // Default to one gender so tests that aren't about the gender split stay
    // in a single board and keep asserting what they were written to assert.
    gender: overrides.gender ?? "male",
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
    // A board is (category x gender) now — these candidates are all male, so
    // the female boards for the same categories are legitimately empty.
    const u17 = boards.find((b) => b.category === "U17" && b.gender === "male")!;
    const open = boards.find((b) => b.category === "Open" && b.gender === "male")!;

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

describe("Skins boards are split by gender as well as age group", () => {
  it("men and women fill their own six slots rather than competing for the same ones", () => {
    // Eight women and eight men in one category. If gender were ignored, the
    // six slots would be shared and the slower gender would be squeezed out.
    const women = Array.from({ length: 8 }, (_, i) =>
      candidate({ athleteId: `f${i + 1}`, gender: "female", sourceRank: i + 1, bestTimeMs: 26000 + i * 100 }),
    );
    const men = Array.from({ length: 8 }, (_, i) =>
      candidate({ athleteId: `m${i + 1}`, gender: "male", sourceRank: i + 1, bestTimeMs: 25000 + i * 100 }),
    );

    const boards = buildSkinsQualifierBoards([...women, ...men]);
    const openFemale = boards.find((b) => b.category === "Open" && b.gender === "female")!;
    const openMale = boards.find((b) => b.category === "Open" && b.gender === "male")!;

    expect(openFemale.active).toHaveLength(SKINS_SLOTS_PER_CATEGORY);
    expect(openMale.active).toHaveLength(SKINS_SLOTS_PER_CATEGORY);
    expect(openFemale.active.every((q) => q.gender === "female")).toBe(true);
    expect(openMale.active.every((q) => q.gender === "male")).toBe(true);
  });

  it("produces one board per category x gender", () => {
    const boards = buildSkinsQualifierBoards([]);
    expect(boards).toHaveLength(6);
    expect(boards.map((b) => `${b.category}-${b.gender}`)).toEqual([
      "U14-female", "U14-male", "U17-female", "U17-male", "Open-female", "Open-male",
    ]);
  });

  it("never builds a mixed-gender skins heat", () => {
    const accepted: SkinsCandidate[] = [
      candidate({ athleteId: "f1", gender: "female", category: "Open", sourceRank: 1, response: "accepted" }),
      candidate({ athleteId: "m1", gender: "male", category: "Open", sourceRank: 1, response: "accepted" }),
    ];
    const heats = populateSkinsHeatSheets(accepted);

    expect(heats).toHaveLength(2);
    expect(heats.map((h) => h.gender)).toEqual(["female", "male"]);
    for (const heat of heats) expect(heat.lanes).toHaveLength(1);
  });
});

describe("a tie on the qualifying cutoff forces a swim-off", () => {
  const timed = (id: string, ms: number, response: SkinsCandidate["response"] = "pending") =>
    candidate({ athleteId: id, sourceRank: 1, bestTimeMs: ms, response });

  it("detects two swimmers tied for the last slot", () => {
    // 5 clear, then two identical times for the 6th and final place.
    const rows = [
      timed("a1", 25000), timed("a2", 25100), timed("a3", 25200),
      timed("a4", 25300), timed("a5", 25400),
      timed("a6", 25500), timed("a7", 25500),
    ];
    const swimOff = detectQualifyingSwimOff(rows);
    expect(swimOff).not.toBeNull();
    expect(swimOff!.athletes.map((a) => a.athleteId).sort()).toEqual(["a6", "a7"]);
    expect(swimOff!.slotsRemaining).toBe(1);
    expect(swimOff!.contestedTimeMs).toBe(25500);
  });

  it("three tied for the last two places contest both", () => {
    const rows = [
      timed("a1", 25000), timed("a2", 25100), timed("a3", 25200), timed("a4", 25300),
      timed("a5", 25500), timed("a6", 25500), timed("a7", 25500),
    ];
    const swimOff = detectQualifyingSwimOff(rows);
    expect(swimOff!.athletes).toHaveLength(3);
    expect(swimOff!.slotsRemaining).toBe(2);
  });

  it("a tie entirely inside the cutoff decides nothing", () => {
    const rows = [
      timed("a1", 25000), timed("a2", 25000), timed("a3", 25200),
      timed("a4", 25300), timed("a5", 25400), timed("a6", 25500), timed("a7", 26000),
    ];
    expect(detectQualifyingSwimOff(rows)).toBeNull();
  });

  it("a tie entirely outside the cutoff decides nothing either", () => {
    const rows = [
      timed("a1", 25000), timed("a2", 25100), timed("a3", 25200),
      timed("a4", 25300), timed("a5", 25400), timed("a6", 25500),
      timed("a7", 26000), timed("a8", 26000),
    ];
    expect(detectQualifyingSwimOff(rows)).toBeNull();
  });

  it("a field no larger than the slots never needs a swim-off", () => {
    const rows = [timed("a1", 25000), timed("a2", 25000)];
    expect(detectQualifyingSwimOff(rows)).toBeNull();
  });

  it("declined swimmers cannot be part of a tie for a place they gave up", () => {
    // a6 declines, so a7/a8's tie is now for the LAST slot, not the first
    // place outside it — the swim-off appears precisely because of the decline.
    const rows = [
      timed("a1", 25000), timed("a2", 25100), timed("a3", 25200),
      timed("a4", 25300), timed("a5", 25400),
      timed("a6", 25450, "declined"),
      timed("a7", 25500), timed("a8", 25500),
    ];
    const swimOff = detectQualifyingSwimOff(rows);
    expect(swimOff!.athletes.map((a) => a.athleteId).sort()).toEqual(["a7", "a8"]);
    expect(swimOff!.slotsRemaining).toBe(1);
  });

  it("surfaces on the board for the right category and gender", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        candidate({ athleteId: `m${i}`, sourceRank: i + 1, bestTimeMs: 25000 + i * 100, gender: "male" }),
      ),
      candidate({ athleteId: "m5", sourceRank: 6, bestTimeMs: 25500, gender: "male" }),
      candidate({ athleteId: "m6", sourceRank: 6, bestTimeMs: 25500, gender: "male" }),
    ];
    const boards = buildSkinsQualifierBoards(rows);
    expect(boards.find((b) => b.category === "Open" && b.gender === "male")!.swimOff).not.toBeNull();
    expect(boards.find((b) => b.category === "Open" && b.gender === "female")!.swimOff).toBeNull();
  });
});
