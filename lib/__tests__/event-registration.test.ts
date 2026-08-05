import { describe, expect, it } from "vitest";
import {
  buildEntryInserts,
  computeRegistrationTotalEgp,
  maxEventsMessage,
  resolveSeedSource,
  validateEventCount,
} from "@/lib/event-registration";

// The old assertions here pinned RACE_PRICE_EGP === 300 and
// MAX_EVENTS_PER_MEET === 4 as module constants. Both are now per-volume
// admin settings (public.meet_settings, edited in /admin/control-unit) and
// this module carries no copy of either — so what is worth asserting is that
// the resolvers use whatever the caller was given, including values that are
// nothing like the old defaults.
describe("cash-on-deck pricing resolves from the passed price", () => {
  it("multiplies the race count by the meet's own price", () => {
    expect(computeRegistrationTotalEgp(0, 300)).toBe(0);
    expect(computeRegistrationTotalEgp(3, 300)).toBe(900);
    expect(computeRegistrationTotalEgp(4, 300)).toBe(1200);
  });

  it("follows a price the admin changed, rather than a baked-in 300", () => {
    expect(computeRegistrationTotalEgp(3, 450)).toBe(1350);
    expect(computeRegistrationTotalEgp(2, 0)).toBe(0);
  });
});

describe("athlete event limit", () => {
  it("allows exactly the configured limit", () => {
    expect(validateEventCount(4, 0, 4).ok).toBe(true);
    expect(validateEventCount(1, 3, 4).ok).toBe(true);
  });

  it("rejects one over, counting events already entered earlier", () => {
    expect(validateEventCount(5, 0, 4).ok).toBe(false);
    expect(validateEventCount(2, 3, 4).ok).toBe(false);
    expect(validateEventCount(5, 0, 4).error).toBe(maxEventsMessage(4));
  });

  it("the cap is per meet, not per submission", () => {
    // Someone who already entered the maximum cannot add even one more.
    expect(validateEventCount(1, 4, 4).ok).toBe(false);
  });

  it("honours a limit the admin changed", () => {
    expect(validateEventCount(6, 0, 6).ok).toBe(true);
    expect(validateEventCount(5, 0, 4).ok).toBe(false);
    expect(validateEventCount(2, 0, 1).error).toBe(
      "You can enter a maximum of 1 event per meet.",
    );
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

describe("resolveSeedSource — where a seed time comes from", () => {
  const normal = { seedsAsNt: false };
  const switchEvent = { seedsAsNt: true };

  it("volume 1: the swimmer declares their own time", () => {
    expect(resolveSeedSource(normal, 1, null).source).toBe("declared");
  });

  it("volume 2+: a previous official time is used instead of any declaration", () => {
    const seed = resolveSeedSource(normal, 2, 27340);
    expect(seed.source).toBe("historical");
    expect(seed.seedTimeMs).toBe(27340);
  });

  it("volume 2+: never swum it before means NT", () => {
    const seed = resolveSeedSource(normal, 2, null);
    expect(seed.source).toBe("nt");
    expect(seed.seedTimeMs).toBeNull();
  });

  it("an event with no long course equivalent is NT in every volume", () => {
    expect(resolveSeedSource(switchEvent, 1, null).source).toBe("nt");
    // Even with history on file — there is no declarable time either way.
    expect(resolveSeedSource(switchEvent, 3, 27000).source).toBe("nt");
  });

  it("history wins over a declaration from volume 2 on", () => {
    // The point of the rule: a claim never overrides the record.
    expect(resolveSeedSource(normal, 2, 30000).seedTimeMs).toBe(30000);
    expect(resolveSeedSource(normal, 5, 28000).seedTimeMs).toBe(28000);
  });
});
