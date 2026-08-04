import { describe, expect, it } from "vitest";
import { instanceIdentity } from "@/e2e/global-setup";

/**
 * The guard that stops the E2E suite resetting one database while testing
 * another — and, worse, stops a production connection string being wiped by a
 * run that only meant to reset fixtures.
 */
describe("instanceIdentity", () => {
  it("treats every loopback form as the same local instance", () => {
    // The API and Postgres listen on different ports of the same stack.
    expect(instanceIdentity("http://127.0.0.1:54321")).toBe("local");
    expect(instanceIdentity("postgresql://postgres:postgres@127.0.0.1:54322/postgres")).toBe("local");
    expect(instanceIdentity("http://localhost:54321")).toBe("local");
    expect(instanceIdentity("postgresql://postgres:pw@host.docker.internal:54322/postgres")).toBe(
      "local",
    );
  });

  it("pairs a cloud project's API host with its database host", () => {
    expect(instanceIdentity("https://abcdefghijklm.supabase.co")).toBe("abcdefghijklm");
    expect(
      instanceIdentity("postgresql://postgres:pw@db.abcdefghijklm.supabase.co:5432/postgres"),
    ).toBe("abcdefghijklm");
  });

  it("separates two different cloud projects", () => {
    const live = instanceIdentity("https://liveproject.supabase.co");
    const test = instanceIdentity("postgresql://postgres:pw@db.testproject.supabase.co:5432/postgres");
    expect(live).not.toBe(test);
  });

  it("never conflates local with a cloud project", () => {
    expect(instanceIdentity("http://127.0.0.1:54321")).not.toBe(
      instanceIdentity("postgresql://postgres:pw@db.liveproject.supabase.co:5432/postgres"),
    );
  });

  it("returns null for input it cannot identify, so the caller refuses rather than guesses", () => {
    expect(instanceIdentity("not-a-url")).toBeNull();
    expect(instanceIdentity("")).toBeNull();
  });
});
