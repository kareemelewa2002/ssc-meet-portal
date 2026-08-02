import { describe, expect, it } from "vitest";
import {
  PARENT_EMAIL_REQUIRED_MESSAGE,
  SWIMMER_PENDING_APPROVAL_MESSAGE,
  buildAthleteProfileInsert,
  buildParentInviteLink,
  canSubmitEntries,
  validateAthleteAge,
  validateParentLinkage,
} from "@/lib/register";
import { buildEntryInserts } from "@/lib/event-registration";
import { SIGNUP_AGE_REJECTION_MESSAGE } from "@/lib/age";

describe("validateAthleteAge", () => {
  it("rejects swimmers under 13 with the exact required message", () => {
    const result = validateAthleteAge("2015-01-01", new Date("2026-10-02"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(SIGNUP_AGE_REJECTION_MESSAGE);
  });

  it("accepts swimmers 13 and older", () => {
    expect(validateAthleteAge("2013-06-01", new Date("2026-10-02")).ok).toBe(true);
  });

  it("accepts a swimmer born 2013 even before their birthday this year (birth-year rule)", () => {
    // Turns 13 in 2026 regardless of whether Dec 31 has passed by Jan 1.
    expect(validateAthleteAge("2013-12-31", new Date("2026-01-01")).ok).toBe(true);
  });
});

describe("validateParentLinkage", () => {
  const under15Dob = "2012-06-15"; // age 14 as of 2026-10-02

  it("requires a parent email for under-15 swimmers", () => {
    const result = validateParentLinkage(under15Dob, null, new Date("2026-10-02"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe(PARENT_EMAIL_REQUIRED_MESSAGE);
  });

  it("accepts under-15 swimmers who provide a parent email", () => {
    const result = validateParentLinkage(under15Dob, "parent@example.com", new Date("2026-10-02"));
    expect(result.ok).toBe(true);
  });

  it("does not require a parent email for 15+", () => {
    const result = validateParentLinkage("2010-01-01", null, new Date("2026-10-02"));
    expect(result.ok).toBe(true);
  });
});

describe("buildAthleteProfileInsert", () => {
  it("marks under-15 athletes pending with their named parent email", () => {
    const payload = buildAthleteProfileInsert(
      {
        dateOfBirth: "2012-06-15",
        gender: "male",
        specialtyEvents: ["Freestyle"],
        parentEmail: "parent@example.com",
      },
      new Date("2026-10-02"),
    );
    expect(payload.age).toBe(14);
    expect(payload.age_group).toBe("U14");
    expect(payload.parent_link_status).toBe("pending");
    expect(payload.pending_parent_email).toBe("parent@example.com");
    expect(payload.approved_by_admin).toBe(false);
  });

  it("marks 15+ athletes as needing no parent link", () => {
    const payload = buildAthleteProfileInsert(
      { dateOfBirth: "2010-01-01", gender: "female", specialtyEvents: [] },
      new Date("2026-10-02"),
    );
    expect(payload.parent_link_status).toBe("none");
    expect(payload.pending_parent_email).toBeNull();
    expect(payload.approved_by_admin).toBe(false);
  });
});

describe("buildParentInviteLink", () => {
  it("builds a register link carrying the invited parent email", () => {
    const link = buildParentInviteLink("parent@example.com", "https://ssc.example.com");
    expect(link).toContain("/register");
    expect(link).toContain("role=parent");
    expect(link).toContain(encodeURIComponent("parent@example.com"));
  });
});

describe("canSubmitEntries", () => {
  it("blocks entry submission while parent linkage is pending", () => {
    const result = canSubmitEntries({ parentLinkStatus: "pending", approvedByAdmin: true });
    expect(result.ok).toBe(false);
  });

  it("blocks entry submission while swimmer registration is unapproved", () => {
    const result = canSubmitEntries({ parentLinkStatus: "none", approvedByAdmin: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(SWIMMER_PENDING_APPROVAL_MESSAGE);
  });

  it("allows entry submission once verified/not required and approved", () => {
    expect(canSubmitEntries({ parentLinkStatus: "verified", approvedByAdmin: true }).ok).toBe(true);
    expect(canSubmitEntries({ parentLinkStatus: "none", approvedByAdmin: true }).ok).toBe(true);
    // Undefined approval is treated as not explicitly blocked (legacy callers).
    expect(canSubmitEntries({ parentLinkStatus: "none" }).ok).toBe(true);
  });
});

describe("account creation vs. meet registration state separation", () => {
  it("the athlete profile payload and the entry payload share no fields", () => {
    const profilePayload = buildAthleteProfileInsert(
      { dateOfBirth: "2010-01-01", gender: "male", specialtyEvents: ["Freestyle"] },
      new Date("2026-10-02"),
    );
    const [entryPayload] = buildEntryInserts("athlete-1", [
      { eventId: "event-1", seedTimeMs: 30000, isNt: false },
    ]);

    const profileKeys = new Set(Object.keys(profilePayload));
    const entryKeys = new Set(Object.keys(entryPayload));
    const overlap = [...profileKeys].filter((key) => entryKeys.has(key));

    expect(overlap).toEqual([]);
    // Sanity check both payloads are non-trivial, so an empty overlap isn't
    // just because one of them is empty.
    expect(profileKeys.size).toBeGreaterThan(0);
    expect(entryKeys.size).toBeGreaterThan(0);
  });

  it("building meet entries never requires or produces account/auth fields", () => {
    const [entryPayload] = buildEntryInserts("athlete-1", [
      { eventId: "event-1", seedTimeMs: null, isNt: true },
    ]);
    expect(entryPayload).not.toHaveProperty("email");
    expect(entryPayload).not.toHaveProperty("password");
    expect(entryPayload).not.toHaveProperty("date_of_birth");
    expect(entryPayload.status).toBe("pending_payment");
  });
});
