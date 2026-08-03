import { describe, expect, it } from "vitest";
import { LANE_SEQUENCE, seedEvent, type DraftHeat, type SeedableEntry } from "@/lib/seeding";

function makeEntry(overrides: Partial<SeedableEntry> & { entryId: string }): SeedableEntry {
  return {
    entryId: overrides.entryId,
    athleteId: overrides.athleteId ?? overrides.entryId,
    ageGroup: overrides.ageGroup ?? "U17",
    // Default to one gender so tests that aren't about the gender split get
    // a single bucket and keep asserting what they were written to assert.
    gender: overrides.gender ?? "male",
    age: overrides.age ?? 17,
    seedTimeMs: overrides.seedTimeMs ?? null,
    isNt: overrides.isNt ?? false,
    waPoints: "waPoints" in overrides ? overrides.waPoints : null,
  };
}

function heatNumberOfEntry(heats: DraftHeat[], entryId: string): number {
  const heat = heats.find((h) => h.lanes.some((l) => l.entryId === entryId));
  if (!heat) throw new Error(`entry ${entryId} not seeded into any heat`);
  return heat.heatNumber;
}

describe("seedEvent", () => {
  it("swims NT entries before timed entries", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "timed-1", ageGroup: "U17", isNt: false, seedTimeMs: 30000, age: 17 }),
      makeEntry({ entryId: "timed-2", ageGroup: "U17", isNt: false, seedTimeMs: 32000, age: 16 }),
      makeEntry({ entryId: "nt-1", ageGroup: "U17", isNt: true, age: 15 }),
      makeEntry({ entryId: "nt-2", ageGroup: "U17", isNt: true, age: 16 }),
    ];

    const heats = seedEvent(entries);

    const ntHeatNumbers = ["nt-1", "nt-2"].map((id) => heatNumberOfEntry(heats, id));
    const timedHeatNumbers = ["timed-1", "timed-2"].map((id) => heatNumberOfEntry(heats, id));

    expect(Math.max(...ntHeatNumbers)).toBeLessThan(Math.min(...timedHeatNumbers));
  });

  it("ranks NT entries oldest-first, placing the oldest closest to the timed heats", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "nt-young", ageGroup: "Open", isNt: true, age: 14 }),
      makeEntry({ entryId: "nt-old", ageGroup: "Open", isNt: true, age: 40 }),
      makeEntry({ entryId: "nt-mid", ageGroup: "Open", isNt: true, age: 25 }),
    ];

    const heats = seedEvent(entries);
    // All 3 fit in a single heat (<= 6 lanes), so verify lane order directly:
    // rank 1 (oldest) -> lane 4, rank 2 -> lane 3, rank 3 -> lane 1... per LANE_SEQUENCE.
    const heat = heats[0];
    const laneFor = (id: string) => heat.lanes.find((l) => l.entryId === id)!.laneNumber;

    expect(laneFor("nt-old")).toBe(LANE_SEQUENCE[0]); // lane 4, "fastest" of the NT group
    expect(laneFor("nt-mid")).toBe(LANE_SEQUENCE[1]); // lane 3
    expect(laneFor("nt-young")).toBe(LANE_SEQUENCE[2]); // lane 5
  });

  it("schedules U13-14 heats entirely before U17/Open heats", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "u1314-a", ageGroup: "U14", age: 13, seedTimeMs: 40000 }),
      makeEntry({ entryId: "u1314-b", ageGroup: "U14", age: 14, seedTimeMs: 41000 }),
      makeEntry({ entryId: "u17-a", ageGroup: "U17", age: 17, seedTimeMs: 30000 }),
      makeEntry({ entryId: "open-a", ageGroup: "Open", age: 22, seedTimeMs: 28000 }),
    ];

    const heats = seedEvent(entries);

    const u1314Heats = heats.filter((h) => h.heatGroup === "U13_14");
    const combinedHeats = heats.filter((h) => h.heatGroup === "U17_OPEN");

    expect(u1314Heats.length).toBeGreaterThan(0);
    expect(combinedHeats.length).toBeGreaterThan(0);

    const maxU1314Number = Math.max(...u1314Heats.map((h) => h.heatNumber));
    const minCombinedNumber = Math.min(...combinedHeats.map((h) => h.heatNumber));

    expect(maxU1314Number).toBeLessThan(minCombinedNumber);
  });

  it("swims U17 and Open athletes of the same gender together in combined heats", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "u17-1", ageGroup: "U17", age: 17, seedTimeMs: 30000 }),
      makeEntry({ entryId: "open-1", ageGroup: "Open", age: 22, seedTimeMs: 30500 }),
      makeEntry({ entryId: "open-2", ageGroup: "Open", age: 24, seedTimeMs: 29500 }),
    ];

    const heats = seedEvent(entries);
    const combinedHeats = heats.filter((h) => h.heatGroup === "U17_OPEN");

    expect(combinedHeats).toHaveLength(1);
    const entryIds = combinedHeats[0].lanes.map((l) => l.entryId);
    expect(entryIds).toEqual(expect.arrayContaining(["u17-1", "open-1", "open-2"]));
  });

  it("fills lanes in the exact sequence [4, 3, 5, 2, 1, 6], fastest swimmer in lane 4", () => {
    const times = [35000, 31000, 33000, 29000, 30000, 32000];
    const entries: SeedableEntry[] = times.map((t, i) =>
      makeEntry({ entryId: `e${i}`, ageGroup: "Open", age: 20, seedTimeMs: t }),
    );

    const heats = seedEvent(entries);
    expect(heats).toHaveLength(1);

    const ranked = [...entries].sort((a, b) => (a.seedTimeMs ?? 0) - (b.seedTimeMs ?? 0));
    const lanesById = new Map(heats[0].lanes.map((l) => [l.entryId, l.laneNumber]));

    ranked.forEach((entry, rankIndex) => {
      expect(lanesById.get(entry.entryId)).toBe(LANE_SEQUENCE[rankIndex]);
    });

    // Fastest swimmer (lowest seed_time_ms) must be in lane 4.
    expect(lanesById.get(ranked[0].entryId)).toBe(4);
  });

  it("fills lanes from the center out, leaving unused lanes empty when a heat has fewer than 6 swimmers", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "a", ageGroup: "Open", age: 20, seedTimeMs: 31000 }),
      makeEntry({ entryId: "b", ageGroup: "Open", age: 20, seedTimeMs: 30000 }),
      makeEntry({ entryId: "c", ageGroup: "Open", age: 20, seedTimeMs: 29000 }),
    ];

    const heats = seedEvent(entries);
    const laneNumbers = heats[0].lanes.map((l) => l.laneNumber).sort();

    // 3 swimmers consume the first 3 slots of [4, 3, 5, 2, 1, 6] -> {3, 4, 5}.
    expect(laneNumbers).toEqual([3, 4, 5]);
    expect(laneNumbers).not.toContain(1);
    expect(laneNumbers).not.toContain(6);
  });

  it("schedules the fastest heat last within a sub-group, with any partial heat first", () => {
    // 10 timed entries -> two heats: a partial heat (4 swimmers, the
    // slowest) scheduled first, and a full heat (6 fastest) scheduled last.
    const entries: SeedableEntry[] = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        entryId: `t${i}`,
        ageGroup: "Open",
        age: 20,
        seedTimeMs: 20000 + i * 1000, // t0 fastest ... t9 slowest
      }),
    );

    const heats = seedEvent(entries);
    expect(heats).toHaveLength(2);

    const [firstHeat, lastHeat] = heats;
    expect(firstHeat.lanes).toHaveLength(4);
    expect(lastHeat.lanes).toHaveLength(6);

    const fastestSixIds = entries.slice(0, 6).map((e) => e.entryId);
    const lastHeatIds = lastHeat.lanes.map((l) => l.entryId);
    expect(new Set(lastHeatIds)).toEqual(new Set(fastestSixIds));

    const slowestFourIds = entries.slice(6).map((e) => e.entryId);
    const firstHeatIds = firstHeat.lanes.map((l) => l.entryId);
    expect(new Set(firstHeatIds)).toEqual(new Set(slowestFourIds));

    expect(firstHeat.heatNumber).toBeLessThan(lastHeat.heatNumber);
  });

  it("marks every produced heat as draft status", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "a", ageGroup: "U14", age: 13, isNt: true }),
    ];
    const heats = seedEvent(entries);
    expect(heats.every((h) => h.status === "draft")).toBe(true);
  });

  it("returns no heats for an event with no entries", () => {
    expect(seedEvent([])).toEqual([]);
  });
});

describe("seedEvent — male and female swim separately in every age group", () => {
  it("never puts two genders in the same heat", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "f1", ageGroup: "U17", gender: "female", seedTimeMs: 30000 }),
      makeEntry({ entryId: "m1", ageGroup: "U17", gender: "male", seedTimeMs: 30100 }),
      makeEntry({ entryId: "f2", ageGroup: "U17", gender: "female", seedTimeMs: 30200 }),
      makeEntry({ entryId: "m2", ageGroup: "U17", gender: "male", seedTimeMs: 30300 }),
    ];
    const heats = seedEvent(entries);
    const genderOf = new Map(entries.map((e) => [e.entryId, e.gender]));

    for (const heat of heats) {
      const genders = new Set(heat.lanes.map((l) => genderOf.get(l.entryId)));
      expect(genders.size).toBe(1);
      // The heat's own label must agree with who is actually in it.
      expect([...genders][0]).toBe(heat.gender);
    }
    // Adjacent seed times across genders would have shared a heat before.
    expect(heats).toHaveLength(2);
  });

  it("orders the four buckets U13-14 female, U13-14 male, U17/Open female, U17/Open male", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "open-m", ageGroup: "Open", gender: "male", seedTimeMs: 28000 }),
      makeEntry({ entryId: "open-f", ageGroup: "Open", gender: "female", seedTimeMs: 29000 }),
      makeEntry({ entryId: "u14-m", ageGroup: "U14", gender: "male", age: 14, seedTimeMs: 40000 }),
      makeEntry({ entryId: "u14-f", ageGroup: "U14", gender: "female", age: 13, seedTimeMs: 41000 }),
    ];
    const heats = seedEvent(entries);

    expect(heats.map((h) => [h.heatGroup, h.gender])).toEqual([
      ["U13_14", "female"],
      ["U13_14", "male"],
      ["U17_OPEN", "female"],
      ["U17_OPEN", "male"],
    ]);
    // Heat numbers stay contiguous and unique across all four buckets.
    expect(heats.map((h) => h.heatNumber)).toEqual([1, 2, 3, 4]);
  });

  it("keeps fastest-heat-last within each gender bucket independently", () => {
    // 7 women -> 2 heats (remainder first, fastest last); 1 man -> 1 heat.
    const women = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ entryId: `f${i}`, gender: "female", seedTimeMs: 30000 + i * 100 }),
    );
    const entries = [...women, makeEntry({ entryId: "m0", gender: "male", seedTimeMs: 25000 })];
    const heats = seedEvent(entries);

    const femaleHeats = heats.filter((h) => h.gender === "female");
    expect(femaleHeats).toHaveLength(2);
    // The fastest woman (f0) swims in the LAST female heat.
    const fastestHeat = femaleHeats.find((h) => h.lanes.some((l) => l.entryId === "f0"));
    expect(fastestHeat!.heatNumber).toBe(Math.max(...femaleHeats.map((h) => h.heatNumber)));
    expect(heats.filter((h) => h.gender === "male")).toHaveLength(1);
  });
});

describe("NT swimmers are seeded by World Aquatics points", () => {
  it("ranks NT entries by points descending, not by age", () => {
    // Deliberately inverted against age: the youngest swimmer has the best
    // points. Age-based seeding would put oldest in lane 4.
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "old-weak", isNt: true, age: 24, waPoints: 300 }),
      makeEntry({ entryId: "young-strong", isNt: true, age: 15, waPoints: 700 }),
      makeEntry({ entryId: "mid", isNt: true, age: 19, waPoints: 500 }),
    ];
    const heats = seedEvent(entries);
    expect(heats).toHaveLength(1);

    // Lane 4 is the top-ranked slot.
    const laneOf = (id: string) => heats[0].lanes.find((l) => l.entryId === id)!.laneNumber;
    expect(laneOf("young-strong")).toBe(4);
    expect(laneOf("mid")).toBe(3);
    expect(laneOf("old-weak")).toBe(5);
  });

  it("puts unrated swimmers last, and falls back to age only among them", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "unrated-young", isNt: true, age: 15, waPoints: null }),
      makeEntry({ entryId: "unrated-old", isNt: true, age: 25, waPoints: null }),
      makeEntry({ entryId: "rated-low", isNt: true, age: 16, waPoints: 100 }),
    ];
    const heats = seedEvent(entries);
    const order = [4, 3, 5].map(
      (lane) => heats[0].lanes.find((l) => l.laneNumber === lane)!.entryId,
    );
    // Any rated swimmer outranks every unrated one; among the unrated, older
    // first (the pre-existing proxy, now only a last resort).
    expect(order).toEqual(["rated-low", "unrated-old", "unrated-young"]);
  });

  it("still swims NT entries before timed entries regardless of points", () => {
    const entries: SeedableEntry[] = [
      makeEntry({ entryId: "timed", isNt: false, seedTimeMs: 25000 }),
      makeEntry({ entryId: "nt-strong", isNt: true, waPoints: 900 }),
    ];
    const heats = seedEvent(entries);
    expect(heatNumberOfEntry(heats, "nt-strong")).toBeLessThan(
      heatNumberOfEntry(heats, "timed"),
    );
  });
});
