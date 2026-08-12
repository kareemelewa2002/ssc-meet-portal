import { describe, expect, it } from "vitest";
import {
  MEDLEY_LEG_STROKES,
  RELAY_LEGS,
  genderRequirement,
  isMedleyRelay,
  legStroke,
  nextSquadLetter,
  relaySquadFeeEgp,
  validateSquad,
  type RelayCandidate,
} from "@/lib/relays";

const swimmer = (
  id: string,
  gender: "male" | "female",
  overrides: Partial<RelayCandidate> = {},
): RelayCandidate => ({
  athleteId: id,
  fullName: `Swimmer ${id}`,
  gender,
  ageGroup: "Open",
  enteredInMeet: true,
  takenBySquad: null,
  ...overrides,
});

describe("genderRequirement — every mixed relay is 2 + 2", () => {
  it("male-only relays need four men", () => {
    expect(genderRequirement("4x50m Freestyle Relay (Male)")).toEqual({ male: 4, female: 0 });
  });

  it("female-only relays need four women", () => {
    expect(genderRequirement("4x50m Medley Relay (Female)")).toEqual({ male: 0, female: 4 });
  });

  it("both spellings of mixed mean exactly 2 + 2", () => {
    // The programme spells this two ways; they are the same rule.
    expect(genderRequirement("4x50m Freestyle Relay (Mixed)")).toEqual({ male: 2, female: 2 });
    expect(
      genderRequirement("4x50m Medley Relay (Mixed: 2 Boys + 2 Girls)"),
    ).toEqual({ male: 2, female: 2 });
  });
});

describe("legStroke — medley order is fixed", () => {
  it("assigns Back, Breast, Fly, Free to legs 1-4", () => {
    const strokes = [1, 2, 3, 4].map((n) => legStroke("Medley Relay", n));
    expect(strokes).toEqual([...MEDLEY_LEG_STROKES]);
  });

  it("treats the 4x100 individual medley relay as a medley relay", () => {
    // Confirmed as medley legs, not four full IMs.
    expect(isMedleyRelay("Individual Medley Relay")).toBe(true);
    expect(legStroke("Individual Medley Relay", 1)).toBe("Backstroke");
  });

  it("freestyle relays have no stroke per leg — the number is only order", () => {
    expect(legStroke("Freestyle Relay", 1)).toBeNull();
    expect(isMedleyRelay("Freestyle Relay")).toBe(false);
  });
});

describe("squad fee and lettering", () => {
  it("charges one race fee per swimmer, at the meet's configured relay price", () => {
    // The price is meet_settings.relay_event_price_egp, not a constant — the
    // fee has to follow whatever an admin set in the Control Unit.
    expect(relaySquadFeeEgp(300)).toBe(RELAY_LEGS * 300);
    expect(relaySquadFeeEgp(450)).toBe(RELAY_LEGS * 450);
    // A short squad still pays per swimmer.
    expect(relaySquadFeeEgp(300, 2)).toBe(600);
  });

  it("letters squads A, B, C in creation order", () => {
    expect(nextSquadLetter([])).toBe("A");
    expect(nextSquadLetter(["A"])).toBe("B");
    expect(nextSquadLetter(["A", "B"])).toBe("C");
  });

  it("reuses a gap rather than colliding with an existing letter", () => {
    // B was removed; the next squad takes B, not C, and never duplicates A.
    expect(nextSquadLetter(["A", "C"])).toBe("B");
  });
});

describe("validateSquad", () => {
  const mixed = "4x50m Freestyle Relay (Mixed)";
  const roster = [
    swimmer("m1", "male"),
    swimmer("m2", "male"),
    swimmer("m3", "male"),
    swimmer("f1", "female"),
    swimmer("f2", "female"),
  ];

  it("accepts 2 male + 2 female, same age group, all entered", () => {
    const res = validateSquad({ eventName: mixed, ageGroup: "Open", legs: ["m1", "f1", "m2", "f2"] }, roster);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("rejects 3 male + 1 female in a mixed relay", () => {
    const res = validateSquad({ eventName: mixed, ageGroup: "Open", legs: ["m1", "m2", "m3", "f1"] }, roster);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/needs 2 male and 2 female/);
  });

  it("rejects a short squad and does not yet complain about gender", () => {
    // Reporting "needs 2 male, has 1" mid-pick would be noise, not a problem.
    const res = validateSquad({ eventName: mixed, ageGroup: "Open", legs: ["m1", null, null, null] }, roster);
    expect(res.ok).toBe(false);
    expect(res.errors.join(" ")).toMatch(/Pick 4 swimmers/);
    expect(res.errors.join(" ")).not.toMatch(/needs 2 male/);
  });

  it("rejects the same swimmer on two legs", () => {
    const res = validateSquad({ eventName: mixed, ageGroup: "Open", legs: ["m1", "m1", "f1", "f2"] }, roster);
    expect(res.errors.join(" ")).toMatch(/cannot swim two legs/);
  });

  it("accepts a younger swimmer in an older squad", () => {
    // Age eligibility is CUMULATIVE — Open means open to everyone, the same
    // rule public.event_results uses to rank a U14 swimmer on the Open board.
    // This previously required an exact match, so a swimmer could hold a place
    // on the Open standing and still be refused an Open relay.
    const mixedAges = [...roster, swimmer("y1", "female", { ageGroup: "U14" })];
    const res = validateSquad(
      { eventName: mixed, ageGroup: "Open", legs: ["m1", "m2", "f1", "y1"] },
      mixedAges,
    );
    expect(res.errors.join(" ")).not.toMatch(/too old/);
    expect(res.ok).toBe(true);
  });

  it("still refuses an older swimmer in a younger squad", () => {
    // Cumulative upward only. Letting an Open swimmer into a 14 & Under squad
    // would defeat the entire purpose of the age bands.
    const mixedAges = [
      swimmer("k1", "male", { ageGroup: "U14" }),
      swimmer("k2", "male", { ageGroup: "U14" }),
      swimmer("k3", "female", { ageGroup: "U14" }),
      swimmer("o1", "female", { ageGroup: "Open" }),
    ];
    const res = validateSquad(
      { eventName: mixed, ageGroup: "U14", legs: ["k1", "k2", "k3", "o1"] },
      mixedAges,
    );
    expect(res.errors.join(" ")).toMatch(/too old/);
  });

  it("rejects a swimmer with no individual entry in the meet", () => {
    const withGuest = [...roster, swimmer("g1", "female", { enteredInMeet: false })];
    const res = validateSquad({ eventName: mixed, ageGroup: "Open", legs: ["m1", "m2", "f1", "g1"] }, withGuest);
    expect(res.errors.join(" ")).toMatch(/not entered in this meet/);
  });

  it("rejects a swimmer already committed to another squad in this relay", () => {
    const taken = [...roster, swimmer("t1", "female", { takenBySquad: "A" })];
    const res = validateSquad({ eventName: mixed, ageGroup: "Open", legs: ["m1", "m2", "f1", "t1"] }, taken);
    expect(res.errors.join(" ")).toMatch(/already swims this relay in squad A/);
  });

  it("a male-only relay refuses a woman", () => {
    const res = validateSquad(
      { eventName: "4x50m Freestyle Relay (Male)", ageGroup: "Open", legs: ["m1", "m2", "m3", "f1"] },
      roster,
    );
    expect(res.errors.join(" ")).toMatch(/needs 4 male and 0 female/);
  });
});
