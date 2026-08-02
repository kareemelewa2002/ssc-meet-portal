import { describe, expect, it } from "vitest";
import {
  MIN_SIGNUP_AGE,
  PARENT_LINK_MAX_AGE,
  ageGroupForAge,
  ageGroupForBirthYear,
  ageTurningThisYear,
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

describe("ageTurningThisYear", () => {
  it("is a pure calendar-year subtraction, independent of whether the birthday has passed", () => {
    // Born Nov 1 2012; even before the Nov birthday, they "turn 14" in 2026.
    expect(ageTurningThisYear("2012-11-01", "2026-10-02")).toBe(14);
    expect(ageTurningThisYear("2012-01-01", "2026-10-02")).toBe(14);
  });

  it("never differs from calculateAge by more than the birthday-not-yet-happened case", () => {
    expect(ageTurningThisYear("2013-10-02", "2026-10-02")).toBe(13);
    expect(ageTurningThisYear("2013-10-03", "2026-10-02")).toBe(13);
  });
});

describe("ageGroupForAge", () => {
  it("buckets 13-14 as U14", () => {
    expect(ageGroupForAge(13)).toBe("U14");
    expect(ageGroupForAge(14)).toBe("U14");
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

describe("ageGroupForBirthYear", () => {
  // Reference year 2026: U14 = born 2012/2013, U17 = born 2009/2010/2011,
  // Open = born 2008 or earlier — regardless of whether the birthday has
  // happened yet this year.
  it("buckets swimmers born 2012 or 2013 as U14, even before their birthday", () => {
    expect(ageGroupForBirthYear("2012-01-01", "2026-01-01")).toBe("U14");
    expect(ageGroupForBirthYear("2013-12-31", "2026-01-01")).toBe("U14");
  });

  it("buckets swimmers born 2009-2011 as U17", () => {
    expect(ageGroupForBirthYear("2009-06-01", "2026-01-01")).toBe("U17");
    expect(ageGroupForBirthYear("2010-06-01", "2026-01-01")).toBe("U17");
    expect(ageGroupForBirthYear("2011-06-01", "2026-01-01")).toBe("U17");
  });

  it("buckets swimmers born 2008 or earlier as Open", () => {
    expect(ageGroupForBirthYear("2008-01-01", "2026-01-01")).toBe("Open");
    expect(ageGroupForBirthYear("1995-01-01", "2026-01-01")).toBe("Open");
  });
});

describe("isEligibleForSignup", () => {
  it("rejects swimmers who turn 12 or younger this year", () => {
    expect(isEligibleForSignup("2014-01-01", "2026-01-01")).toBe(false);
  });

  it("accepts swimmers who turn 13 or older this year, even before their birthday", () => {
    expect(isEligibleForSignup("2013-12-31", "2026-01-01")).toBe(true);
    expect(isEligibleForSignup("1996-01-01", "2026-01-01")).toBe(true);
  });

  it("uses MIN_SIGNUP_AGE as the exact cutoff", () => {
    expect(MIN_SIGNUP_AGE).toBe(13);
  });
});

describe("requiresParentLink", () => {
  it("requires linkage for swimmers turning 13-14 this year (born 2012/2013)", () => {
    expect(requiresParentLink("2013-01-01", "2026-01-01")).toBe(true);
    expect(requiresParentLink("2012-01-01", "2026-01-01")).toBe(true);
  });

  it("does not require linkage from born-2011-or-earlier onward", () => {
    expect(requiresParentLink("2011-01-01", "2026-01-01")).toBe(false);
    expect(requiresParentLink("1996-01-01", "2026-01-01")).toBe(false);
  });

  it("uses PARENT_LINK_MAX_AGE as the exact cutoff", () => {
    expect(PARENT_LINK_MAX_AGE).toBe(14);
  });
});

describe("describeAgeAtSwim", () => {
  it("formats the historical-age display string", () => {
    expect(describeAgeAtSwim(14, "SSC Vol. 1")).toBe("Swum at age 14 in SSC Vol. 1");
  });
});
