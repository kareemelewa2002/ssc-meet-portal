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

  it("accepts a bare string message", () => {
    expect(getErrorMessage("Invalid login credentials", "fallback")).toBe(
      "Invalid login credentials",
    );
  });

  it("falls back when the error has no usable message", () => {
    expect(getErrorMessage(null, "fallback")).toBe("fallback");
    expect(getErrorMessage(undefined, "fallback")).toBe("fallback");
    expect(getErrorMessage({ code: "42501" }, "fallback")).toBe("fallback");
    // Spreading an Error yields {} — never show that literal to users.
    expect(getErrorMessage("{}", "fallback")).toBe("fallback");
    expect(getErrorMessage("[object Object]", "fallback")).toBe("fallback");
    expect(getErrorMessage({ message: "{}" }, "fallback")).toBe("fallback");
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

  it("maps invalid credentials to a password hint for the real admin email", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://crocqqhajpboltigzkxp.supabase.co");
    expect(formatSignInError(new Error("Invalid login credentials"))).toMatch(
      /Invalid email or password/,
    );
  });

  it("maps network failures when the project URL is set", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://crocqqhajpboltigzkxp.supabase.co");
    expect(formatSignInError(new Error("Failed to fetch"))).toMatch(/Could not reach Supabase/);
  });
});
