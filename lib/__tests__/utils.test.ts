import { afterEach, describe, expect, it, vi } from "vitest";
import { formatSignInError, getErrorMessage } from "@/lib/utils";

describe("getErrorMessage", () => {
  it("extracts the message from a real Error instance", () => {
    expect(getErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });

  it("extracts the message from a Postgrest-style plain object error", () => {
    // Supabase/Postgrest throws plain {message, code, ...} objects — these
    // are NOT `instanceof Error`, which is exactly the bug this helper
    // fixes (see components/admin/user-role-management.tsx's
    // "Failed to load users" / heat-result-entry's "Failed to save heat
    // results" reports: the real reason was always being swallowed).
    const postgrestError = { message: "permission denied for table results", code: "42501" };
    expect(getErrorMessage(postgrestError, "fallback")).toBe(
      "permission denied for table results",
    );
  });

  it("falls back when the error has no usable message", () => {
    expect(getErrorMessage(null, "fallback")).toBe("fallback");
    expect(getErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(getErrorMessage("a bare string", "fallback")).toBe("fallback");
    expect(getErrorMessage({ code: "42501" }, "fallback")).toBe("fallback");
    // supabase-js has been observed to attach these as AuthError.message
    // after serializing an empty/opaque failure payload — never show them.
    expect(getErrorMessage({ message: "{}" }, "fallback")).toBe("fallback");
    expect(getErrorMessage({ message: "[object Object]" }, "fallback")).toBe("fallback");
    expect(getErrorMessage(new Error("{}"), "fallback")).toBe("fallback");
  });
});

describe("formatSignInError", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("explains placeholder Supabase env configuration", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://your-project.supabase.co");
    expect(formatSignInError(new Error("Failed to fetch"))).toMatch(/Supabase is not configured/);
  });

  it("maps invalid credentials to a seed/password hint", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://crocqqhajpboltigzkxp.supabase.co");
    expect(formatSignInError(new Error("Invalid login credentials"))).toMatch(
      /Invalid email or password/,
    );
  });

  it("maps empty AuthError messages to the demo-identities hotfix hint", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://crocqqhajpboltigzkxp.supabase.co");
    expect(formatSignInError(new Error("{}"))).toMatch(/fix-demo-auth-identities/);
    expect(formatSignInError({})).toMatch(/fix-demo-auth-identities/);
  });

  it("maps network failures when the project URL is set", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://crocqqhajpboltigzkxp.supabase.co");
    expect(formatSignInError(new Error("Failed to fetch"))).toMatch(/Could not reach Supabase/);
  });
});
