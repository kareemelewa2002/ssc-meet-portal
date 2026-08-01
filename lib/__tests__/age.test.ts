import { describe, expect, it } from "vitest";
import {
  MIN_SIGNUP_AGE,
  PARENT_LINK_MAX_AGE,
  ageGroupForAge,
  calculateAge,
  describeAgeAtSwim,
  isEligibleForSignup,
  requiresParentLink,
} from "@/lib/age";

describe("calculateAge", () => {
  it("computes whole years between dob and a reference date", () => {
    expect(calculateAge("2012-06-15", "2026-10-02")).toBe(14);
  });

  it("hasn't rolled over yet if the birthday later this year hasn't happened", () => {
    // Born Nov 1 2012; as of Oct 2 2026 they're still 13, not 14.
    expect(calculateAge("2012-11-01", "2026-10-02")).toBe(13);
  });

  it("rolls over exactly on the birthday", () => {
    expect(calculateAge("2013-10-02", "2026-10-02")).toBe(13);
    expect(calculateAge("2013-10-03", "2026-10-02")).toBe(12);
    expect(calculateAge("2013-10-01", "2026-10-02")).toBe(13);
  });

  it("is the historical age at a past meet, not the age today", () => {
    const dob = "2012-06-15";
    const ageAtVol1 = calculateAge(dob, "2026-10-02");
    const ageMuchLater = calculateAge(dob, "2029-10-02");
    expect(ageAtVol1).toBe(14);
    expect(ageMuchLater).toBe(17);
    expect(ageAtVol1).not.toBe(ageMuchLater);
  });
});

describe("ageGroupForAge", () => {
  it("buckets 13-14 as U13_14", () => {
    expect(ageGroupForAge(13)).toBe("U13_14");
    expect(ageGroupForAge(14)).toBe("U13_14");
  });

  it("buckets 15-17 as U17", () => {
    expect(ageGroupForAge(15)).toBe("U17");
    expect(ageGroupForAge(17)).toBe("U17");
  });

  it("buckets 18+ as Open", () => {
    expect(ageGroupForAge(18)).toBe("Open");
    expect(ageGroupForAge(45)).toBe("Open");
  });
});

describe("isEligibleForSignup", () => {
  it("rejects under 13", () => {
    expect(isEligibleForSignup(12)).toBe(false);
    expect(isEligibleForSignup(MIN_SIGNUP_AGE - 1)).toBe(false);
  });

  it("accepts 13 and older", () => {
    expect(isEligibleForSignup(13)).toBe(true);
    expect(isEligibleForSignup(30)).toBe(true);
  });
});

describe("requiresParentLink", () => {
  it("requires linkage for ages 13-14 (under 15)", () => {
    expect(requiresParentLink(13)).toBe(true);
    expect(requiresParentLink(PARENT_LINK_MAX_AGE)).toBe(true);
  });

  it("does not require linkage from 15 onward", () => {
    expect(requiresParentLink(15)).toBe(false);
    expect(requiresParentLink(30)).toBe(false);
  });
});

describe("describeAgeAtSwim", () => {
  it("formats the historical-age display string", () => {
    expect(describeAgeAtSwim(14, "SSC Vol. 1")).toBe("Swum at age 14 in SSC Vol. 1");
  });
});
