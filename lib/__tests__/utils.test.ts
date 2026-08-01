import { describe, expect, it } from "vitest";
import { getErrorMessage } from "@/lib/utils";

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
  });
});
