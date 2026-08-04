import { describe, expect, it } from "vitest";
import {
  advanceCount,
  centredLanes,
  nextRound,
  openingLanes,
  planNextStep,
  reseedByLane,
  resolveRound,
  type RoundLike,
} from "@/lib/skins-lanes";
import { heatTitle } from "@/lib/format";

describe("centredLanes", () => {
  it("puts a shrinking field down the middle of the pool", () => {
    expect(centredLanes(6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(centredLanes(4)).toEqual([2, 3, 4, 5]);
    expect(centredLanes(2)).toEqual([3, 4]);
  });

  it("handles the odd fields a DQ or NS can leave behind", () => {
    expect(centredLanes(5)).toEqual([1, 2, 3, 4, 5]);
    expect(centredLanes(3)).toEqual([2, 3, 4]);
    expect(centredLanes(1)).toEqual([3]);
    expect(centredLanes(0)).toEqual([]);
  });
});

describe("reseedByLane", () => {
  it("keeps swimmers in lane order and shifts them into the centre block", () => {
    // The worked example: qualifiers out of lanes 1-4 come back in lanes 2-5.
    const survivors = [
      { id: "a", laneNumber: 1 },
      { id: "b", laneNumber: 2 },
      { id: "c", laneNumber: 3 },
      { id: "d", laneNumber: 4 },
    ];
    expect(reseedByLane(survivors)).toEqual([
      { id: "a", laneNumber: 2 },
      { id: "b", laneNumber: 3 },
      { id: "c", laneNumber: 4 },
      { id: "d", laneNumber: 5 },
    ]);
  });

  it("orders by the lane just swum, not by finishing place", () => {
    // Winner came out of lane 6, so they stay on the outside of the group.
    const survivors = [
      { id: "winner", laneNumber: 6, finishPlace: 1 },
      { id: "second", laneNumber: 1, finishPlace: 2 },
    ];
    expect(reseedByLane(survivors).map((s) => [s.id, s.laneNumber])).toEqual([
      ["second", 3],
      ["winner", 4],
    ]);
  });

  it("closes the gaps left by eliminated swimmers", () => {
    const survivors = [
      { id: "a", laneNumber: 1 },
      { id: "b", laneNumber: 3 },
      { id: "c", laneNumber: 5 },
      { id: "d", laneNumber: 6 },
    ];
    expect(reseedByLane(survivors).map((s) => s.laneNumber)).toEqual([2, 3, 4, 5]);
  });
});

describe("round progression", () => {
  it("runs 6 -> 4 -> 2 and stops", () => {
    expect(nextRound(6)).toBe(4);
    expect(nextRound(4)).toBe(2);
    expect(nextRound(2)).toBeNull();
    expect(openingLanes(6)).toEqual([4, 3, 5, 2, 1, 6]);
    expect(advanceCount(2)).toBe(0);
  });
});

describe("resolveRound", () => {
  const swimmer = (id: string, finishPlace: number | null, outcome = "valid") => ({
    id,
    finishPlace,
    outcome,
  });

  it("advances the top four out of a clean round of six", () => {
    const out = resolveRound(6, [
      swimmer("a", 1),
      swimmer("b", 2),
      swimmer("c", 3),
      swimmer("d", 4),
      swimmer("e", 5),
      swimmer("f", 6),
    ]);
    expect(out.advancing.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.swimOff).toEqual([]);
  });

  it("lets a tie clear of the cutoff stand — both advance, nobody re-swims", () => {
    const out = resolveRound(6, [
      swimmer("a", 1),
      swimmer("b", 1),
      swimmer("c", 3),
      swimmer("d", 4),
      swimmer("e", 5),
      swimmer("f", 6),
    ]);
    expect(out.advancing.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(out.swimOff).toEqual([]);
  });

  it("forces a swim-off when the tie straddles the last qualifying place", () => {
    const out = resolveRound(6, [
      swimmer("a", 1),
      swimmer("b", 2),
      swimmer("c", 3),
      swimmer("d", 4),
      swimmer("e", 4),
      swimmer("f", 6),
    ]);
    expect(out.advancing.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(out.swimOff.map((s) => s.id)).toEqual(["d", "e"]);
    expect(out.slotsRemaining).toBe(1);
  });

  it("allows a dead heat in the final rather than making them swim again", () => {
    const out = resolveRound(2, [swimmer("a", 1), swimmer("b", 1)]);
    expect(out.swimOff).toEqual([]);
    expect(out.slotsRemaining).toBe(0);
  });

  it("ignores DQ and NS swimmers when deciding who goes through", () => {
    const out = resolveRound(6, [
      swimmer("a", 1),
      swimmer("b", 2),
      swimmer("c", 3),
      swimmer("d", null, "dq"),
      swimmer("e", null, "no_show"),
      swimmer("f", 4),
    ]);
    expect(out.advancing.map((s) => s.id)).toEqual(["a", "b", "c", "f"]);
  });
});

describe("planNextStep", () => {
  const lane = (
    athleteId: string,
    laneNumber: number,
    finishPlace: number | null,
    outcome: string | null = "valid",
  ) => ({
    athleteId,
    laneNumber,
    finishPlace,
    outcome,
  });

  const roundOfSix = (places: number[]): RoundLike => ({
    round: 6,
    swimOff: false,
    complete: true,
    lanes: [1, 2, 3, 4, 5, 6].map((ln, i) => lane(`s${ln}`, ln, places[i])),
  });

  it("waits while the round is still being scored", () => {
    expect(planNextStep([{ ...roundOfSix([1, 2, 3, 4, 5, 6]), complete: false }], 6)).toEqual({
      kind: "waiting",
    });
    expect(planNextStep([], 6)).toEqual({ kind: "waiting" });
  });

  it("re-seeds the four survivors into the centre lanes, in lane order", () => {
    // Lanes 1-4 qualify; they come back in lanes 2-5 in that same order.
    const step = planNextStep([roundOfSix([1, 2, 3, 4, 5, 6])], 6);
    expect(step.kind).toBe("next-round");
    if (step.kind !== "next-round") throw new Error("expected next-round");
    expect(step.round).toBe(4);
    expect(step.field.map((f) => [f.athleteId, f.laneNumber])).toEqual([
      ["s1", 2],
      ["s2", 3],
      ["s3", 4],
      ["s4", 5],
    ]);
  });

  it("calls for a swim-off when the cutoff is tied, and waits for it", () => {
    // Lanes 4 and 5 dead-heat for 4th; only one of them goes through.
    const main = roundOfSix([1, 2, 3, 4, 4, 6]);
    const step = planNextStep([main], 6);
    expect(step.kind).toBe("swim-off");
    if (step.kind !== "swim-off") throw new Error("expected swim-off");
    expect(step.athletes.map((a) => a.athleteId)).toEqual(["s4", "s5"]);
    expect(step.lanes).toEqual([3, 4]);
    expect(step.slotsRemaining).toBe(1);

    const unscored: RoundLike = {
      round: 6,
      swimOff: true,
      complete: false,
      lanes: [lane("s4", 3, null, null), lane("s5", 4, null, null)],
    };
    expect(planNextStep([main, unscored], 6)).toEqual({ kind: "waiting" });
  });

  it("sends the swim-off winner through in their original lane order", () => {
    const main = roundOfSix([1, 2, 3, 4, 4, 6]);
    const decider: RoundLike = {
      round: 6,
      swimOff: true,
      complete: true,
      // s5 wins the swim-off from swim-off lane 4.
      lanes: [lane("s4", 3, 2), lane("s5", 4, 1)],
    };
    const step = planNextStep([main, decider], 6);
    if (step.kind !== "next-round") throw new Error("expected next-round");
    // s5 held lane 5 in the round proper, so they re-seed after s1..s3.
    expect(step.field.map((f) => [f.athleteId, f.laneNumber])).toEqual([
      ["s1", 2],
      ["s2", 3],
      ["s3", 4],
      ["s5", 5],
    ]);
  });

  it("declares the final's winner, and allows two of them", () => {
    const final: RoundLike = {
      round: 2,
      swimOff: false,
      complete: true,
      lanes: [lane("a", 3, 1), lane("b", 4, 2)],
    };
    const step = planNextStep([final], 2);
    if (step.kind !== "complete") throw new Error("expected complete");
    expect(step.winners.map((w) => w.athleteId)).toEqual(["a"]);

    const deadHeat: RoundLike = { ...final, lanes: [lane("a", 3, 1), lane("b", 4, 1)] };
    const tied = planNextStep([deadHeat], 2);
    if (tied.kind !== "complete") throw new Error("expected complete");
    expect(tied.winners.map((w) => w.athleteId)).toEqual(["a", "b"]);
  });

  it("shrinks the field when DQs leave fewer than four survivors", () => {
    const main: RoundLike = {
      round: 6,
      swimOff: false,
      complete: true,
      lanes: [
        lane("s1", 1, 1),
        lane("s2", 2, 2),
        lane("s3", 3, 3),
        lane("s4", 4, null, "dq"),
        lane("s5", 5, null, "no_show"),
        lane("s6", 6, null, "dq"),
      ],
    };
    const step = planNextStep([main], 6);
    if (step.kind !== "next-round") throw new Error("expected next-round");
    expect(step.field.map((f) => [f.athleteId, f.laneNumber])).toEqual([
      ["s1", 2],
      ["s2", 3],
      ["s3", 4],
    ]);
  });
});

describe("heatTitle for Skins heats", () => {
  it("names the round instead of exposing the encoded heat number", () => {
    // 21 is skins_heat_number('U17', 6, false) — an internal key, not
    // something a spectator or referee should ever be shown.
    expect(
      heatTitle({ heatGroup: "U17_OPEN", gender: "male", heatNumber: 21, skinsRound: 6 }),
    ).toBe("17 & Under / Open Men Round of 6");
    expect(
      heatTitle({ heatGroup: "U13_14", gender: "female", heatNumber: 13, skinsRound: 2 }),
    ).toBe("14 & Under Women Final 2");
    expect(
      heatTitle({
        heatGroup: "U17_OPEN",
        gender: "male",
        heatNumber: 26,
        skinsRound: 6,
        skinsSwimOff: true,
      }),
    ).toBe("17 & Under / Open Men Round of 6 swim-off");
  });

  it("leaves ordinary heats alone", () => {
    expect(heatTitle({ heatGroup: "U13_14", gender: "female", heatNumber: 2 })).toBe(
      "14 & Under Women Heat 2",
    );
    expect(
      heatTitle({ heatGroup: "U17_OPEN", gender: "male", heatNumber: 3, skinsRound: null }),
    ).toBe("17 & Under / Open Men Heat 3");
  });
});
