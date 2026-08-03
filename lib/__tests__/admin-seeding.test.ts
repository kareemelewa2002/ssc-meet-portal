import { describe, expect, it } from "vitest";
import {
  mapEntryRowsToSeedableEntries,
  prepareEventSeeding,
  type RawSeedableEntryRow,
} from "@/lib/admin-seeding";
import { LANE_SEQUENCE } from "@/lib/seeding";

function rawEntry(overrides: Partial<RawSeedableEntryRow> & { id: string }): RawSeedableEntryRow {
  // `??` can't distinguish "explicitly passed null" from "omitted" — both
  // are nullish — so fields that legitimately default to null (rather than
  // just being absent) must check `in` instead.
  return {
    id: overrides.id,
    athlete_id: overrides.athlete_id ?? `athlete-${overrides.id}`,
    age_group_at_entry: "age_group_at_entry" in overrides ? overrides.age_group_at_entry! : "Open",
    seed_time_ms: overrides.seed_time_ms ?? 30000,
    is_nt: overrides.is_nt ?? false,
    athletes: "athletes" in overrides ? overrides.athletes! : { age: 20, age_group: "Open", gender: "male" },
  };
}

describe("mapEntryRowsToSeedableEntries", () => {
  it("prefers age_group_at_entry over the athlete's current age_group", () => {
    const rows = [
      rawEntry({
        id: "e1",
        age_group_at_entry: "U14",
        athletes: { age: 15, age_group: "U17", gender: "male" }, // athlete has since aged up
      }),
    ];
    const [seedable] = mapEntryRowsToSeedableEntries(rows);
    expect(seedable.ageGroup).toBe("U14");
  });

  it("falls back to the athlete's age_group for legacy rows with no snapshot", () => {
    const rows = [rawEntry({ id: "e1", age_group_at_entry: null, athletes: { age: 16, age_group: "U17", gender: "male" } })];
    const [seedable] = mapEntryRowsToSeedableEntries(rows);
    expect(seedable.ageGroup).toBe("U17");
  });

  it("drops rows with no resolvable age group and no linked athlete", () => {
    const rows = [rawEntry({ id: "e1", age_group_at_entry: null, athletes: null })];
    expect(mapEntryRowsToSeedableEntries(rows)).toHaveLength(0);
  });

  it("drops rows with no gender — a swimmer with no gender has no heat to go in", () => {
    const rows = [
      rawEntry({
        id: "e1",
        athletes: { age: 20, age_group: "Open" } as unknown as RawSeedableEntryRow["athletes"],
      }),
    ];
    expect(mapEntryRowsToSeedableEntries(rows)).toHaveLength(0);
  });

  it("normalizes array-shaped athlete embeds", () => {
    const rows = [
      rawEntry({ id: "e1", age_group_at_entry: null, athletes: [{ age: 14, age_group: "U14", gender: "female" }] }),
    ];
    const [seedable] = mapEntryRowsToSeedableEntries(rows);
    expect(seedable.age).toBe(14);
    expect(seedable.ageGroup).toBe("U14");
  });
});

describe("prepareEventSeeding — fetch -> transform -> seedEvent -> write payload", () => {
  it("produces insertable heat/heat_lane payloads from raw entry rows", () => {
    const rows: RawSeedableEntryRow[] = [
      rawEntry({ id: "e1", age_group_at_entry: "Open", seed_time_ms: 24000 }),
      rawEntry({ id: "e2", age_group_at_entry: "Open", seed_time_ms: 25000 }),
      rawEntry({ id: "e3", age_group_at_entry: "U14", is_nt: true, seed_time_ms: null, athletes: { age: 14, age_group: "U14", gender: "male" } }),
    ];

    const prepared = prepareEventSeeding("event-123", rows);

    expect(prepared.eventId).toBe("event-123");
    // U13-14 heat scheduled before the U17/Open heat.
    expect(prepared.heats[0].heat_group).toBe("U13_14");
    expect(prepared.heats[0].event_id).toBe("event-123");
    expect(prepared.heats[0].status).toBe("draft");
    expect(prepared.heats[0].lanes).toEqual([{ lane_number: 4, entry_id: "e3" }]);

    const openHeat = prepared.heats.find((h) => h.heat_group === "U17_OPEN")!;
    expect(openHeat.lanes.map((l) => l.lane_number)).toEqual(
      [LANE_SEQUENCE[0], LANE_SEQUENCE[1]],
    );
    // Fastest (e1, 24000ms) gets lane 4.
    expect(openHeat.lanes[0].entry_id).toBe("e1");
  });

  it("returns no heats when there are no entries", () => {
    expect(prepareEventSeeding("event-1", []).heats).toEqual([]);
  });
});
