import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS_MESSAGE,
  MAX_EVENTS_PER_MEET,
  RACE_PRICE_EGP,
  computeRegistrationTotalEgp,
  validateEventCount,
} from "@/lib/event-registration";

describe("cash-on-deck pricing", () => {
  it("is a flat per-race price", () => {
    expect(RACE_PRICE_EGP).toBe(300);
    expect(computeRegistrationTotalEgp(0)).toBe(0);
    expect(computeRegistrationTotalEgp(3)).toBe(900);
    expect(computeRegistrationTotalEgp(MAX_EVENTS_PER_MEET)).toBe(1200);
  });
});
describe("MAX_EVENTS_PER_MEET cap", () => {
  it("allows up to 4 events", () => {
    expect(validateEventCount(4).ok).toBe(true);
    expect(validateEventCount(1, 3).ok).toBe(true);
  });

  it("rejects a 5th event, counting ones already entered earlier", () => {
    expect(validateEventCount(5).ok).toBe(false);
    expect(validateEventCount(2, 3).ok).toBe(false);
    expect(validateEventCount(5).error).toBe(MAX_EVENTS_MESSAGE);
  });

  it("the cap is per meet, not per submission", () => {
    // Someone who already entered 4 cannot add even one more.
    expect(validateEventCount(1, 4).ok).toBe(false);
  });
});
