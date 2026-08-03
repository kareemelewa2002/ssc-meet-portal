import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS_MESSAGE,
  MAX_EVENTS_PER_MEET,
  RACE_PRICE_EGP,
  buildEntryInserts,
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

describe("stroke-switch events are always entered NT", () => {
  it("forces is_nt and discards any seed time the client supplied", () => {
    const [payload] = buildEntryInserts("athlete-1", [
      { eventId: "switch-event", seedTimeMs: 28000, isNt: false, seedsAsNt: true },
    ]);
    expect(payload.is_nt).toBe(true);
    expect(payload.seed_time_ms).toBeNull();
  });

  it("leaves ordinary events alone", () => {
    const [payload] = buildEntryInserts("athlete-1", [
      { eventId: "normal-event", seedTimeMs: 28000, isNt: false, seedsAsNt: false },
    ]);
    expect(payload.is_nt).toBe(false);
    expect(payload.seed_time_ms).toBe(28000);
  });

  it("an explicit NT on an ordinary event still clears the time", () => {
    const [payload] = buildEntryInserts("athlete-1", [
      { eventId: "normal-event", seedTimeMs: 28000, isNt: true },
    ]);
    expect(payload.is_nt).toBe(true);
    expect(payload.seed_time_ms).toBeNull();
  });
});
