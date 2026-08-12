import { describe, expect, it } from "vitest";
import {
  CATEGORY_RUNNING_ORDER,
  categoryLabel,
  categorySortOrder,
  compareByCategory,
  compareInRunningOrder,
  resultBoardSortOrder,
} from "@/lib/category-order";
import type { AgeGroup, Gender, HeatGroup } from "@/lib/supabase/types";

const heat = (heatGroup: HeatGroup, gender: Gender | null, heatNumber = 1) => ({
  heatGroup,
  gender,
  heatNumber,
});

describe("categorySortOrder — the four buckets, in running order", () => {
  it("puts 14 & Under Women first and 17 & Under/Open Men last", () => {
    const ordered = CATEGORY_RUNNING_ORDER.map((c) => categorySortOrder(c));
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    expect(new Set(ordered).size).toBe(4);
  });

  it("orders U13_14 Women -> U13_14 Men -> U17_OPEN Women -> U17_OPEN Men", () => {
    const shuffled = [
      heat("U17_OPEN", "male"),
      heat("U13_14", "male"),
      heat("U17_OPEN", "female"),
      heat("U13_14", "female"),
    ];
    expect(shuffled.sort(compareByCategory).map(categoryLabel)).toEqual([
      "14 & Under Women",
      "14 & Under Men",
      "17 & Under / Open Women",
      "17 & Under / Open Men",
    ]);
  });

  it("buckets by heat_group, not by age_group — there are four, not six", () => {
    // U17 and Open share a bucket because an ordinary heat only ever carries
    // heat_group, which folds them together. Sorting by age_group would
    // invent two boards no heat is assigned to.
    expect(categorySortOrder(heat("U17_OPEN", "female"))).toBe(4);
    expect(categorySortOrder(heat("U17_OPEN", "male"))).toBe(5);
  });

  it("sorts a legacy genderless heat last within its own board", () => {
    const rows = [
      heat("U17_OPEN", null),
      heat("U13_14", null),
      heat("U13_14", "male"),
      heat("U17_OPEN", "female"),
      heat("U13_14", "female"),
      heat("U17_OPEN", "male"),
    ];
    expect(rows.sort(compareByCategory).map(categoryLabel)).toEqual([
      "14 & Under Women",
      "14 & Under Men",
      "14 & Under Mixed",
      "17 & Under / Open Women",
      "17 & Under / Open Men",
      "17 & Under / Open Mixed",
    ]);
  });
});

describe("compareByCategory — heat number breaks ties within a bucket", () => {
  it("keeps heats of one bucket in numeric order", () => {
    const rows = [
      heat("U13_14", "female", 3),
      heat("U13_14", "female", 1),
      heat("U13_14", "female", 2),
    ];
    expect(rows.sort(compareByCategory).map((h) => h.heatNumber)).toEqual([1, 2, 3]);
  });

  it("category beats heat number — a 14 & Under heat 5 precedes an Open heat 1", () => {
    const rows = [heat("U17_OPEN", "female", 1), heat("U13_14", "female", 5)];
    const [first] = rows.sort(compareByCategory);
    expect(first.heatGroup).toBe("U13_14");
  });

  it("lists Skins rounds inline, in bracket order, not dumped at one end", () => {
    // materialise_skins_heat sets heat_group/gender like any other heat, and
    // skins_heat_number encodes category tens + round units (+5 swim-off):
    //   U17 R6=21, U17 R4=22, U17 R4 swim-off=27, Open R6=31.
    // So a U17 board runs before an Open board of the same gender, and a
    // swim-off follows the round it settles.
    const rows = [
      heat("U17_OPEN", "male", 31), // Open, Round of 6
      heat("U17_OPEN", "male", 27), // U17, Round of 4 swim-off
      heat("U13_14", "male", 11), // 14 & Under, Round of 6
      heat("U17_OPEN", "female", 21), // U17 women, Round of 6
      heat("U17_OPEN", "male", 21), // U17 men, Round of 6
      heat("U17_OPEN", "male", 22), // U17 men, Round of 4
    ];
    expect(rows.sort(compareByCategory).map((h) => `${h.heatGroup}/${h.gender}/${h.heatNumber}`))
      .toEqual([
        "U13_14/male/11",
        "U17_OPEN/female/21",
        "U17_OPEN/male/21",
        "U17_OPEN/male/22",
        "U17_OPEN/male/27",
        "U17_OPEN/male/31",
      ]);
  });
});

describe("compareInRunningOrder — session, then race, then category", () => {
  const row = (
    sessionNumber: number,
    eventOrder: number,
    heatGroup: HeatGroup,
    gender: Gender,
    heatNumber: number,
  ) => ({ sessionNumber, eventOrder, heatGroup, gender, heatNumber });

  it("session wins over everything", () => {
    const rows = [
      row(2, 1, "U13_14", "female", 1),
      row(1, 9, "U17_OPEN", "male", 9),
    ];
    expect(rows.sort(compareInRunningOrder)[0].sessionNumber).toBe(1);
  });

  it("race order wins over category within a session", () => {
    const rows = [
      row(1, 2, "U13_14", "female", 1),
      row(1, 1, "U17_OPEN", "male", 1),
    ];
    expect(rows.sort(compareInRunningOrder)[0].eventOrder).toBe(1);
  });

  it("category orders the heats of one race", () => {
    const rows = [
      row(1, 1, "U17_OPEN", "male", 1),
      row(1, 1, "U13_14", "male", 1),
      row(1, 1, "U17_OPEN", "female", 1),
      row(1, 1, "U13_14", "female", 1),
    ];
    expect(rows.sort(compareInRunningOrder).map(categoryLabel)).toEqual([
      "14 & Under Women",
      "14 & Under Men",
      "17 & Under / Open Women",
      "17 & Under / Open Men",
    ]);
  });

  it("treats a missing session or event order as first, not as NaN", () => {
    const rows = [
      { heatGroup: "U13_14" as HeatGroup, gender: "female" as Gender, heatNumber: 1 },
      row(1, 1, "U13_14", "female", 1),
    ];
    expect(() => rows.sort(compareInRunningOrder)).not.toThrow();
    expect(rows.sort(compareInRunningOrder)).toHaveLength(2);
  });
});

describe("resultBoardSortOrder", () => {
  const board = (ageGroup: AgeGroup, gender: Gender) => ({ ageGroup, gender });

  it("lists a standing's boards youngest first, women before men", () => {
    const rows = [
      board("Open", "male"),
      board("U14", "male"),
      board("Open", "female"),
      board("U17", "male"),
      board("U14", "female"),
      board("U17", "female"),
    ];
    expect(
      rows
        .sort((a, b) => resultBoardSortOrder(a) - resultBoardSortOrder(b))
        .map((r) => `${r.ageGroup} ${r.gender}`),
    ).toEqual([
      "U14 female",
      "U14 male",
      "U17 female",
      "U17 male",
      "Open female",
      "Open male",
    ]);
  });

  it("keeps U17 and Open apart, unlike the heat_group buckets", () => {
    // A heat folds these two together (U17_OPEN) because they swim the same
    // water. A standing must not: they are separate boards with separate
    // places and separate points.
    expect(resultBoardSortOrder(board("U17", "female"))).not.toBe(
      resultBoardSortOrder(board("Open", "female")),
    );
  });

  it("sorts an unrecognised board last rather than ahead of 14 & Under", () => {
    // indexOf returns -1 for anything unexpected; used raw it would produce a
    // negative rank and float the unknown board to the top of the page.
    const unknown = { ageGroup: "U11" as AgeGroup, gender: "female" as Gender };
    expect(resultBoardSortOrder(unknown)).toBeGreaterThan(
      resultBoardSortOrder(board("Open", "male")),
    );
  });
});
