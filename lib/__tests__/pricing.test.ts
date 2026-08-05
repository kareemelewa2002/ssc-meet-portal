import { describe, expect, it } from "vitest";
import {
  ADDITIONAL_RACE_ROW,
  activeTier,
  formatEgp,
  marginalRacePriceEgp,
  quoteSelection,
  tierEndsAt,
  type PricingMatrixCell,
  type TierWindow,
} from "@/lib/pricing";
import { defaultMeetSettings } from "@/lib/meet-settings";

/** The default matrix from schema.sql, so these tests fail if it drifts. */
const MATRIX: PricingMatrixCell[] = [
  { raceCount: ADDITIONAL_RACE_ROW, tier: "early_bird", priceEgp: 200 },
  { raceCount: ADDITIONAL_RACE_ROW, tier: "standard", priceEgp: 300 },
  { raceCount: ADDITIONAL_RACE_ROW, tier: "late", priceEgp: 400 },
  { raceCount: 1, tier: "early_bird", priceEgp: 200 },
  { raceCount: 1, tier: "standard", priceEgp: 300 },
  { raceCount: 1, tier: "late", priceEgp: 400 },
  { raceCount: 2, tier: "early_bird", priceEgp: 380 },
  { raceCount: 2, tier: "standard", priceEgp: 560 },
  { raceCount: 3, tier: "standard", priceEgp: 700 },
  { raceCount: 4, tier: "standard", priceEgp: 900 },
];

const windows: TierWindow[] = [
  { tier: "early_bird", startsAt: "2026-08-01T00:00:00Z", endsAt: "2026-08-20T00:00:00Z" },
  { tier: "standard", startsAt: "2026-08-20T00:00:00Z", endsAt: "2026-09-05T00:00:00Z" },
  { tier: "late", startsAt: "2026-09-05T00:00:00Z", endsAt: "2026-09-12T00:00:00Z" },
];

const race = (id: string, name: string, surchargeEgp = 0, isRelay = false) => ({
  id,
  name,
  surchargeEgp,
  isRelay,
});

describe("activeTier", () => {
  const settings = defaultMeetSettings("vol-1");

  it("picks the tier whose window contains now", () => {
    expect(activeTier(settings, windows, new Date("2026-08-10T00:00:00Z"))).toBe("early_bird");
    expect(activeTier(settings, windows, new Date("2026-08-25T00:00:00Z"))).toBe("standard");
    expect(activeTier(settings, windows, new Date("2026-09-08T00:00:00Z"))).toBe("late");
  });

  it("lets an admin pin override the calendar entirely", () => {
    // The whole point of a pin: extending a deadline without editing dates.
    const pinned = { ...settings, pinnedPricingTier: "early_bird" as const };
    expect(activeTier(pinned, windows, new Date("2026-09-08T00:00:00Z"))).toBe("early_bird");
  });

  it("quotes the earliest tier before selling opens", () => {
    // Not "nothing" — a meet that has not started selling should read Early
    // Bird, or the registration form has no price to show.
    expect(activeTier(settings, windows, new Date("2026-07-01T00:00:00Z"))).toBe("early_bird");
  });

  it("quotes the LAST tier after every window closes, never Early Bird", () => {
    // Whether registration is still open is a different question. Whatever
    // does get sold late must not sell at the cheapest rate.
    expect(activeTier(settings, windows, new Date("2026-10-01T00:00:00Z"))).toBe("late");
  });

  it("falls back to standard rather than crashing with no windows at all", () => {
    expect(activeTier(settings, [], new Date())).toBe("standard");
  });
});

describe("tierEndsAt", () => {
  it("reports when the quoted price stops applying", () => {
    // The registration form shows this, because the price settles at PAYMENT
    // time — a swimmer needs to know the deadline they are racing.
    expect(tierEndsAt("early_bird", windows)?.toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });

  it("is null for a tier with no window configured", () => {
    expect(tierEndsAt("late", [])).toBeNull();
  });
});

describe("quoteSelection", () => {
  const base = {
    matrix: MATRIX,
    tier: "standard" as const,
    relaySwimmerPriceEgp: 300,
  };

  it("charges the package for the race count, not a per-race price", () => {
    const quote = quoteSelection({
      ...base,
      events: [race("a", "50 Free"), race("b", "100 Back")],
    });
    expect(quote.totalEgp).toBe(560);
    expect(quote.lines).toHaveLength(1);
    expect(quote.lines[0].kind).toBe("package");
    expect(quote.lines[0].label).toBe("2-race package");
  });

  it("adds each race's own surcharge on top of the package", () => {
    const quote = quoteSelection({
      ...base,
      events: [race("a", "50 Free"), race("b", "100 Back"), race("c", "400 IM", 150)],
    });
    // 3-race package 700 + 400 IM surcharge 150
    expect(quote.totalEgp).toBe(850);
    expect(quote.lines.filter((l) => l.kind === "surcharge")).toHaveLength(1);
  });

  it("omits zero surcharges instead of listing them as +0", () => {
    // A breakdown of forty lines that are mostly zero explains nothing.
    const quote = quoteSelection({
      ...base,
      events: [race("a", "50 Free"), race("b", "100 Back")],
    });
    expect(quote.lines.some((l) => l.kind === "surcharge")).toBe(false);
  });

  it("prices races past the fourth one at a time, each on its own line", () => {
    const quote = quoteSelection({
      ...base,
      events: [
        race("a", "R1"),
        race("b", "R2"),
        race("c", "R3"),
        race("d", "R4"),
        race("e", "R5"),
        race("f", "R6"),
      ],
    });
    // 4-race package 900 + 2 additional at 300
    expect(quote.totalEgp).toBe(1500);
    expect(quote.lines.filter((l) => l.kind === "additional_race")).toHaveLength(2);
    expect(quote.lines[0].label).toContain("4-race package + 2 extra");
  });

  it("charges relay legs on top and does NOT count them toward the package", () => {
    const quote = quoteSelection({
      ...base,
      events: [race("a", "50 Free"), race("b", "100 Back")],
      relayLegCount: 2,
    });
    // Still a 2-race package (560), plus 2 x 300 relay
    expect(quote.raceCount).toBe(2);
    expect(quote.totalEgp).toBe(560 + 600);
    expect(quote.lines.filter((l) => l.kind === "relay")).toHaveLength(2);
  });

  it("ignores relay events in the individual race count", () => {
    const quote = quoteSelection({
      ...base,
      events: [race("a", "50 Free"), race("r", "4x50 Relay", 0, true)],
    });
    expect(quote.raceCount).toBe(1);
    expect(quote.totalEgp).toBe(300);
  });

  it("quotes nothing for an empty selection rather than a zero-race package", () => {
    const quote = quoteSelection({ ...base, events: [] });
    expect(quote.lines).toHaveLength(0);
    expect(quote.totalEgp).toBe(0);
  });

  it("re-prices the whole basket when the tier changes", () => {
    const early = quoteSelection({
      ...base,
      tier: "early_bird",
      events: [race("a", "R1"), race("b", "R2")],
    });
    expect(early.totalEgp).toBe(380);
  });

  it("every line carries the tier it was priced at", () => {
    const quote = quoteSelection({
      ...base,
      events: [race("a", "R1"), race("b", "400 IM", 150)],
      relayLegCount: 1,
    });
    expect(quote.lines.every((l) => l.tier === "standard")).toBe(true);
  });
});

describe("marginalRacePriceEgp", () => {
  const base = { matrix: MATRIX, tier: "standard" as const };

  it("is the package difference while still inside the packages", () => {
    // 2-pack 560 -> 3-pack 700
    expect(marginalRacePriceEgp({ ...base, currentRaceCount: 2 })).toBe(140);
  });

  it("is the additional-race price past the fourth", () => {
    expect(marginalRacePriceEgp({ ...base, currentRaceCount: 4 })).toBe(300);
    expect(marginalRacePriceEgp({ ...base, currentRaceCount: 7 })).toBe(300);
  });

  it("is the 1-race price once they have already paid", () => {
    // The agreed rule: the original package stands, and the added race is its
    // own line at today's single-race rate.
    expect(
      marginalRacePriceEgp({ ...base, currentRaceCount: 2, alreadyPaid: true }),
    ).toBe(300);
  });

  it("adds the new race's surcharge in every case", () => {
    expect(
      marginalRacePriceEgp({ ...base, currentRaceCount: 2, surchargeEgp: 150 }),
    ).toBe(290);
    expect(
      marginalRacePriceEgp({
        ...base,
        currentRaceCount: 2,
        surchargeEgp: 150,
        alreadyPaid: true,
      }),
    ).toBe(450);
  });

  it("charges the full 1-race price for the very first race", () => {
    expect(marginalRacePriceEgp({ ...base, currentRaceCount: 0 })).toBe(300);
  });
});

describe("formatEgp", () => {
  it("groups thousands", () => {
    expect(formatEgp(1500)).toBe("1,500 EGP");
    expect(formatEgp(300)).toBe("300 EGP");
  });
});
