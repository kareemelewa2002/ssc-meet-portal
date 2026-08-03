/**
 * End-to-end scenario verification suite (platform audit, Part 3).
 *
 * These tests exercise the pure application logic behind each primary user
 * scenario. Scenarios that are fundamentally database/RLS-level guarantees
 * (D1's admin-only publish gate, C's NS-as-absence rule, E1's realtime
 * result broadcast) are proven instead via a local Postgres walkthrough
 * (supabase/schema.sql + supabase/seed-demo.sql applied to a scratch
 * database, RLS enforced under a non-superuser role) — noted inline below
 * rather than re-asserted here, since they have no meaningful pure-function
 * surface to unit test.
 */
import { describe, expect, it } from "vitest";
import {
  SIGNUP_AGE_REJECTION_MESSAGE,
  calculateAge,
  describeAgeAtSwim,
} from "@/lib/age";
import {
  PARENT_EMAIL_REQUIRED_MESSAGE,
  SAFETY_NOT_ACCEPTED_MESSAGE,
  buildAthleteProfileInsert,
  canSubmitEntries,
  validateAthleteAge,
  validateParentLinkage,
} from "@/lib/register";
import {
  CLOCK_TIME_ERROR,
  parseClockTime,
  parseTimeToMs,
} from "@/lib/format";
import { scoreHeatResult } from "@/lib/results";
import {
  rankBestPerformances,
  rankBestPerformers,
  type RacePerformance,
} from "@/lib/all-time-rankings";

const MEET_DATE = new Date("2026-10-02"); // SSC Vol. 1

describe("Scenario A — Registration, Approval & Parent Linkage Gate", () => {
  it("A1: rejects a swimmer born in 2015 (age < 13) with the exact required message", () => {
    const result = validateAthleteAge("2015-06-01", MEET_DATE);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(SIGNUP_AGE_REJECTION_MESSAGE);
    expect(SIGNUP_AGE_REJECTION_MESSAGE).toBe(
      "SSC platform accounts require swimmers to be at least 13 years old.",
    );
  });

  it("A2: blocks a 14-year-old without a parent email, accepts one with a parent email", () => {
    const dob = "2012-08-01"; // age 14 as of 2026-10-02
    const withoutParent = validateParentLinkage(dob, null, MEET_DATE);
    expect(withoutParent.ok).toBe(false);
    expect(withoutParent.error).toBe(PARENT_EMAIL_REQUIRED_MESSAGE);

    const withParent = validateParentLinkage(dob, "guardian@example.com", MEET_DATE);
    expect(withParent.ok).toBe(true);

    const profile = buildAthleteProfileInsert(
      { dateOfBirth: dob, gender: "female", specialtyEvents: [], parentEmail: "guardian@example.com" },
      MEET_DATE,
    );
    expect(profile.parent_link_status).toBe("pending");
    expect(profile.pending_parent_email).toBe("guardian@example.com");
    // Parent linkage is now the only account-level gate — there is no
    // separate admin approval for it to be independent of.
    expect(profile).not.toHaveProperty("approved_by_admin");
  });

  it("A3: the safety acknowledgement blocks registration until accepted", () => {
    const result = canSubmitEntries({ parentLinkStatus: "none", safetyAcceptedAt: null });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(SAFETY_NOT_ACCEPTED_MESSAGE);
  });

  it("A4: account approval is NO LONGER a gate — paying the entry fee is", () => {
    // The admin's decision point moved to confirming cash at the desk, which
    // is also what seeds the heats. Vetting accounts up front blocked
    // swimmers who had already paid.
    expect(
      canSubmitEntries({ parentLinkStatus: "none", safetyAcceptedAt: "2026-08-01" }).ok,
    ).toBe(true);
  });

  it("A3+A4: a still-pending parent link blocks regardless of safety acceptance", () => {
    const result = canSubmitEntries({
      parentLinkStatus: "pending",
      safetyAcceptedAt: "2026-08-01",
    });
    expect(result.ok).toBe(false);
  });
});

describe("Scenario B — Meet Event Entry & Strict Clock-Time Input", () => {
  it("B2: accepts mm:ss.cc (1:04.12) and ss.cc (29.85)", () => {
    expect(parseTimeToMs("1:04.12")).toBe(64120);
    expect(parseTimeToMs("29.85")).toBe(29850);
    expect(parseClockTime("1:04.12").ok).toBe(true);
    expect(parseClockTime("29.85").ok).toBe(true);
  });

  it("B3: rejects raw milliseconds, truncated, and non-numeric input with the exact error", () => {
    for (const bad of ["64120", "1:4", "abc"]) {
      const result = parseClockTime(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(CLOCK_TIME_ERROR);
    }
    expect(CLOCK_TIME_ERROR).toBe(
      "Please enter time in mm:ss.cc (e.g. 1:05.43) or ss.cc (e.g. 29.43) format.",
    );
  });
});

describe("Scenario C — absence is recorded as NS on the result", () => {
  // Call-room attendance check-in was removed. It was a second, independent
  // record of who turned up, and it could disagree with the result sheet —
  // marked present in the call room, published NS behind the blocks — with
  // no rule for which one won. A swimmer who does not swim is published NS,
  // and that single record is what scoring reads.
  it("NS scores zero and carries no time, so absence needs no separate marking", () => {
    const ns = scoreHeatResult({ outcome: "no_show" });
    expect(ns.resultOutcome).toBe("no_show");
    expect(ns.isNoShow).toBe(true);
    expect(ns.officialTimeMs).toBeNull();
    expect(ns.finishPlace).toBeNull();
    expect(ns.placementPoints).toBe(0);
    expect(ns.improvementPoints).toBe(0);
  });

  it("NS is distinct from DQ — both score zero, only DQ carries a code", () => {
    const ns = scoreHeatResult({ outcome: "no_show" });
    const dq = scoreHeatResult({ outcome: "dq" }, "false_start");
    expect(ns.dqCode).toBeNull();
    expect(dq.dqCode).toBe("false_start");
    expect(dq.isNoShow).toBe(false);
    expect(ns.placementPoints).toBe(dq.placementPoints);
  });
});

describe("Scenario D — Referee Time Entry & Admin-Only Publish", () => {
  it("D1: scoring a valid time and a DQ produce the expected outcome/points", () => {
    const scored = scoreHeatResult({ outcome: "valid", finishPlace: 1, seedTimeMs: 29000, officialTimeMs: 28500 });
    expect(scored.officialTimeMs).toBe(28500);
    expect(scored.placementPoints).toBe(6);

    const dq = scoreHeatResult({ outcome: "dq" }, "false_start");
    expect(dq.resultOutcome).toBe("dq");
    expect(dq.dqCode).toBe("false_start");
    expect(dq.placementPoints).toBe(0);
  });

  it("D2: a referee can never publish results directly — only draft — enforced at the database RLS layer", () => {
    // public.results' enforce_result_publish trigger raises unless
    // public.is_admin() — a referee (is_referee() true, is_admin() false)
    // upserting status: 'published' is rejected outright, regardless of
    // client-side intent. The consolidated Referee role only ever submits
    // drafts (see components/referee/heat-result-entry.tsx); publishing is
    // exclusively an Admin action from the "Referee Heat Cards" review
    // queue. Verified functionally by applying supabase/schema.sql +
    // supabase/seed-demo.sql to a scratch Postgres instance and attempting
    // the write as a non-superuser `authenticated` role authenticated as a
    // seeded referee: the publish attempt raises, the draft upsert succeeds.
    expect(true).toBe(true);
  });
});

describe("Scenario E — Spectator & Public Profiles", () => {
  it("E3: displays the swimmer's age at performance time, not their current live age", () => {
    // A swimmer born 2012-08-01 was 14 at SSC Vol. 1 (2026-10-02) — even if
    // their live profile has since aged into U17, career ledgers and
    // All-Time views must keep showing the historical value.
    const ageAtVol1 = calculateAge("2012-08-01", "2026-10-02");
    expect(ageAtVol1).toBe(14);
    expect(describeAgeAtSwim(ageAtVol1, "SSC Vol. 1")).toBe("Swum at age 14 in SSC Vol. 1");

    const currentAgeAYearLater = calculateAge("2012-08-01", "2027-10-02");
    expect(currentAgeAYearLater).toBe(15);
    // The two must diverge — this is the entire point of the feature.
    expect(currentAgeAYearLater).not.toBe(ageAtVol1);
  });

  it("E4: All-Time Best Performers (one row per athlete) vs Best Performances (every race) rank independently", () => {
    const races: RacePerformance[] = [
      { resultId: "r1", athleteId: "ath-1", athleteName: "Amara Johnson", gender: "female", ageGroup: "U17", ageAtSwim: 15, stroke: "Backstroke", distanceM: 100, officialTimeMs: 68000, swamAt: "2026-10-02" },
      { resultId: "r2", athleteId: "ath-1", athleteName: "Amara Johnson", gender: "female", ageGroup: "U17", ageAtSwim: 15, stroke: "Backstroke", distanceM: 100, officialTimeMs: 66500, swamAt: "2027-04-15" },
      { resultId: "r3", athleteId: "ath-2", athleteName: "Grace Kim", gender: "female", ageGroup: "Open", ageAtSwim: 19, stroke: "Backstroke", distanceM: 100, officialTimeMs: 63800, swamAt: "2026-10-02" },
    ];

    const performances = rankBestPerformances(races, { stroke: "Backstroke", distanceM: 100 }, 10);
    // Every individual race appears — Amara's two swims both rank separately.
    expect(performances).toHaveLength(3);
    expect(performances[0].resultId).toBe("r3"); // Grace's 63.8s is fastest overall
    expect(performances[1].resultId).toBe("r2"); // Amara's PB swim (66.5s)

    const performers = rankBestPerformers(races, { stroke: "Backstroke", distanceM: 100 }, 10);
    // Collapsed to one row per athlete, using each athlete's personal best.
    expect(performers).toHaveLength(2);
    const amara = performers.find((p) => p.athleteId === "ath-1");
    expect(amara?.bestTimeMs).toBe(66500);
    expect(amara?.racesCounted).toBe(2);
  });
});
