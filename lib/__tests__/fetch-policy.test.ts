import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { describeError, failure, firstError, ok, runQuery } from "@/lib/fetch-policy";

/**
 * The invariant these tests protect: a failed query must NEVER be
 * indistinguishable from a successful-but-empty one. That conflation is what
 * let a total heats/heat_lanes outage (HTTP 400, stale RLS policy referencing
 * the retired 'usher' enum label) render as "three sessions with the same two
 * events" instead of surfacing as an error.
 */

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ok", () => {
  it("marks success with no error and no fallback", () => {
    const r = ok([1, 2, 3]);
    expect(r.data).toEqual([1, 2, 3]);
    expect(r.error).toBeNull();
    expect(r.usedFallback).toBe(false);
  });

  it("treats a genuinely empty result as success, not failure", () => {
    const r = ok([]);
    expect(r.data).toEqual([]);
    expect(r.error).toBeNull();
  });
});

describe("failure", () => {
  it("always sets error, and returns the empty value when demo fallback is off", () => {
    const r = failure<number[]>("boom", [], [99]);
    expect(r.error).toBe("boom");
    // DEMO_FALLBACK_ENABLED is false under test (env var unset), so the demo
    // payload must NOT be substituted.
    expect(r.data).toEqual([]);
    expect(r.usedFallback).toBe(false);
  });

  it("logs every failure — the signal that was missing during the outage", () => {
    failure("kaboom", null);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("kaboom"));
  });
});

describe("runQuery", () => {
  it("returns data on success", async () => {
    const r = await runQuery("ctx", async () => ({ data: [1], error: null }), { empty: [] });
    expect(r.data).toEqual([1]);
    expect(r.error).toBeNull();
  });

  it("converts a supabase { error } result into a loud failure", async () => {
    const r = await runQuery(
      "Loading heat sheets",
      async () => ({ data: null, error: { message: 'invalid input value for enum user_role: "usher"' } }),
      { empty: [] as number[] },
    );
    expect(r.error).toContain("Loading heat sheets");
    expect(r.error).toContain("usher");
    expect(r.data).toEqual([]);
  });

  it("catches thrown exceptions (network/DNS) rather than letting them escape", async () => {
    const r = await runQuery(
      "Loading teams",
      async () => {
        throw new Error("fetch failed");
      },
      { empty: [] as string[] },
    );
    expect(r.error).toContain("fetch failed");
    expect(r.data).toEqual([]);
  });

  it("distinguishes an empty success from a failure — the core regression guard", async () => {
    const empty = await runQuery("ctx", async () => ({ data: [], error: null }), { empty: [] });
    const broken = await runQuery("ctx", async () => ({ data: null, error: { message: "500" } }), {
      empty: [],
    });

    expect(empty.data).toEqual(broken.data); // both render nothing...
    expect(empty.error).toBeNull(); // ...but only one is an error
    expect(broken.error).not.toBeNull();
  });

  it("treats a null data payload with no error as an empty success", async () => {
    const r = await runQuery("ctx", async () => ({ data: null, error: null }), { empty: [] });
    expect(r.data).toEqual([]);
    expect(r.error).toBeNull();
  });
});

describe("describeError", () => {
  it("prefixes the context so banners say what was being loaded", () => {
    expect(describeError("Loading teams", { message: "denied" })).toBe("Loading teams: denied");
    expect(describeError("Loading teams", new Error("nope"))).toBe("Loading teams: nope");
    expect(describeError("Loading teams", "raw string")).toBe("Loading teams: raw string");
    expect(describeError("Loading teams", undefined)).toBe("Loading teams: unknown error");
  });
});

describe("firstError", () => {
  it("returns the first failure across parallel results, else null", () => {
    expect(firstError({ error: null }, { error: null })).toBeNull();
    expect(firstError({ error: null }, { error: "second broke" })).toBe("second broke");
    expect(firstError({ error: "first broke" }, { error: "second broke" })).toBe("first broke");
  });
});
