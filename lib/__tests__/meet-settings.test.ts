import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEET_SETTINGS,
  computeScheduleCapacity,
  effectiveEventLimit,
  eventLimitExceedsSchedule,
  formatDurationSeconds,
  individualPriceBySession,
  maxHeatsPerSession,
  maxSwimsPerSession,
  parseTimeOfDaySeconds,
  requiredSwims,
  sessionDurationSeconds,
  settingsForSession,
  uniformIndividualPriceEgp,
  type MeetSettings,
  type SessionNumber,
  type SessionSchedule,
} from "@/lib/meet-settings";

const session = (
  overrides: Partial<SessionSchedule> & Pick<SessionSchedule, "id">,
): SessionSchedule => ({
  sessionNumber: 1,
  name: "Session",
  startTime: "09:00",
  endTime: "12:00",
  ...overrides,
});

/** Control Unit dials for one session. */
const dials = (
  sessionNumber: SessionNumber,
  overrides: Partial<MeetSettings> = {},
): MeetSettings => ({
  meetVolumeId: "vol-1",
  sessionNumber,
  ...DEFAULT_MEET_SETTINGS,
  ...overrides,
});

/** The same dials for every session — the common case. */
const uniformDials = (overrides: Partial<MeetSettings> = {}): MeetSettings[] =>
  ([1, 2, 3] as SessionNumber[]).map((n) => dials(n, overrides));

describe("parseTimeOfDaySeconds", () => {
  it("accepts both the input element's HH:MM and Postgres' HH:MM:SS", () => {
    expect(parseTimeOfDaySeconds("09:00")).toBe(9 * 3600);
    expect(parseTimeOfDaySeconds("09:00:00")).toBe(9 * 3600);
    expect(parseTimeOfDaySeconds("14:30:15")).toBe(14 * 3600 + 30 * 60 + 15);
  });

  it("returns null rather than a plausible number for junk", () => {
    expect(parseTimeOfDaySeconds("")).toBeNull();
    expect(parseTimeOfDaySeconds(null)).toBeNull();
    expect(parseTimeOfDaySeconds("9am")).toBeNull();
    expect(parseTimeOfDaySeconds("25:00")).toBeNull();
    expect(parseTimeOfDaySeconds("09:75")).toBeNull();
  });
});

describe("sessionDurationSeconds", () => {
  it("is end minus start", () => {
    expect(sessionDurationSeconds("09:00", "12:00")).toBe(3 * 3600);
    expect(sessionDurationSeconds("17:00", "19:30")).toBe(2.5 * 3600);
  });

  it("reads an end before the start as crossing midnight, not as negative", () => {
    // A finals session running 22:00 to 00:30 is a real schedule; reporting
    // -77400 seconds would put a nonsense heat count in front of an admin.
    expect(sessionDurationSeconds("22:00", "00:30")).toBe(2.5 * 3600);
  });

  it("is null when either end is unparseable", () => {
    expect(sessionDurationSeconds("09:00", "")).toBeNull();
    expect(sessionDurationSeconds("nope", "12:00")).toBeNull();
  });
});

describe("maxHeatsPerSession = floor(session length / heat turnaround)", () => {
  it("floors — a heat that does not fit does not half-run", () => {
    // 3h = 10800s, 90s turnaround -> 120 heats exactly.
    expect(maxHeatsPerSession(10_800, 90)).toBe(120);
    // 10800 / 100 = 108, 10800 / 700 = 15.43 -> 15
    expect(maxHeatsPerSession(10_800, 100)).toBe(108);
    expect(maxHeatsPerSession(10_800, 700)).toBe(15);
  });

  it("is zero rather than Infinity or NaN on degenerate input", () => {
    expect(maxHeatsPerSession(10_800, 0)).toBe(0);
    expect(maxHeatsPerSession(null, 90)).toBe(0);
    expect(maxHeatsPerSession(0, 90)).toBe(0);
    expect(maxHeatsPerSession(-100, 90)).toBe(0);
  });
});

describe("maxSwimsPerSession = max heats x 6 lanes", () => {
  it("counts swims, not swimmers", () => {
    expect(maxSwimsPerSession(10_800, 90)).toBe(120 * 6);
    expect(maxSwimsPerSession(3_600, 120)).toBe(30 * 6);
  });
});

describe("computeScheduleCapacity", () => {
  const sessions = [
    session({ id: "s1", sessionNumber: 1, startTime: "09:00", endTime: "12:00" }),
    session({ id: "s2", sessionNumber: 2, startTime: "14:00", endTime: "17:00" }),
    session({ id: "s3", sessionNumber: 3, startTime: "17:00", endTime: "19:00" }),
  ];

  it("sums swim slots across every session", () => {
    // 120 + 120 + 80 heats at 6 lanes.
    const capacity = computeScheduleCapacity(sessions, uniformDials({ athleteCapacity: 200 }));
    expect(capacity.perSession.map((s) => s.maxHeats)).toEqual([120, 120, 80]);
    expect(capacity.totalSwims).toBe((120 + 120 + 80) * 6);
  });

  it("derives the event-limit ceiling as floor(total swims / athlete capacity)", () => {
    // 1920 swims / 200 swimmers = 9.6 -> 9 races each.
    expect(computeScheduleCapacity(sessions, uniformDials({ athleteCapacity: 200 })).computedEventLimitCeiling).toBe(9);
    // A bigger field absorbs fewer races each.
    expect(computeScheduleCapacity(sessions, uniformDials({ athleteCapacity: 500 })).computedEventLimitCeiling).toBe(3);
    // 2000 swimmers cannot even get one race each.
    expect(computeScheduleCapacity(sessions, uniformDials({ athleteCapacity: 2000 })).computedEventLimitCeiling).toBe(0);
  });

  it("honours per-session turnaround rather than one meet-wide figure", () => {
    // A slower-turning session of 100s produces fewer heats than a 50s one,
    // which is exactly why turnaround is per session.
    const mixed = [
      session({ id: "fast", sessionNumber: 1 }),
      session({ id: "slow", sessionNumber: 2 }),
    ];
    const capacity = computeScheduleCapacity(mixed, [
      dials(1, { heatTurnaroundSeconds: 60 }),
      dials(2, { heatTurnaroundSeconds: 180 }),
    ]);
    expect(capacity.perSession.map((s) => s.maxHeats)).toEqual([180, 60]);
  });

  it("sizes the ceiling against the BUSIEST session, not an average", () => {
    // Sessions that admit different fields: the meet must hold the biggest of
    // them. Averaging would promise room session 2 does not have.
    const capacity = computeScheduleCapacity(sessions, [
      dials(1, { athleteCapacity: 100 }),
      dials(2, { athleteCapacity: 400 }),
      dials(3, { athleteCapacity: 100 }),
    ]);
    // 1920 swims / 400 (the largest) = 4.8 -> 4, not 1920/200 = 9.
    expect(capacity.computedEventLimitCeiling).toBe(4);
  });

  it("is zero, not Infinity, when the capacity is zero", () => {
    expect(computeScheduleCapacity(sessions, uniformDials({ athleteCapacity: 0 })).computedEventLimitCeiling).toBe(0);
  });

  it("reports no capacity for a session whose times do not parse", () => {
    const broken = [session({ id: "s1", startTime: "", endTime: "" })];
    const capacity = computeScheduleCapacity(broken, uniformDials({ athleteCapacity: 100 }));
    expect(capacity.perSession[0].durationSeconds).toBeNull();
    expect(capacity.totalSwims).toBe(0);
  });
});

describe("the event-limit warning is a warning, not a clamp", () => {
  const sessions = [session({ id: "s1", startTime: "09:00", endTime: "12:00" })];

  it("requiredSwims is capacity x limit", () => {
    expect(requiredSwims(200, 4)).toBe(800);
    expect(requiredSwims(0, 4)).toBe(0);
  });

  it("flags a limit the schedule cannot absorb", () => {
    // One 3h session = 720 swims. 200 swimmers x 4 races = 800 > 720.
    const capacity = computeScheduleCapacity(sessions, uniformDials({ athleteCapacity: 200 }));
    expect(capacity.totalSwims).toBe(720);
    expect(eventLimitExceedsSchedule(capacity, 200, 4)).toBe(true);
    // 3 races each fits.
    expect(eventLimitExceedsSchedule(capacity, 200, 3)).toBe(false);
  });

  it("exactly filling the schedule is not over-committed", () => {
    const capacity = computeScheduleCapacity(sessions, uniformDials({ athleteCapacity: 180 }));
    expect(capacity.totalSwims).toBe(720);
    expect(eventLimitExceedsSchedule(capacity, 180, 4)).toBe(false);
    expect(eventLimitExceedsSchedule(capacity, 180, 5)).toBe(true);
  });
});

describe("formatDurationSeconds", () => {
  it("renders hours and minutes, and an em dash for nothing", () => {
    expect(formatDurationSeconds(3 * 3600)).toBe("3h");
    expect(formatDurationSeconds(2.5 * 3600)).toBe("2h 30m");
    expect(formatDurationSeconds(45 * 60)).toBe("45m");
    expect(formatDurationSeconds(null)).toBe("—");
    expect(formatDurationSeconds(0)).toBe("—");
  });
});

describe("per-session dials", () => {
  it("falls back to the documented defaults for a session with no row", () => {
    // A MISSING row is an unconfigured session, not a failed query — the
    // difference the module's header comment turns on. Defaults here are
    // legitimate; a default after a fetch ERROR would not be.
    const only2 = [dials(2, { individualEventPriceEgp: 450 })];
    expect(settingsForSession(only2, "vol-1", 2).individualEventPriceEgp).toBe(450);
    expect(settingsForSession(only2, "vol-1", 1)).toEqual({
      meetVolumeId: "vol-1",
      sessionNumber: 1,
      ...DEFAULT_MEET_SETTINGS,
    });
  });

  it("prices a mixed basket by each race's own session", () => {
    const prices = individualPriceBySession([
      dials(1, { individualEventPriceEgp: 300 }),
      dials(2, { individualEventPriceEgp: 350 }),
      dials(3, { individualEventPriceEgp: 500 }),
    ]);
    // One race in the morning and one in the evening is 800, not 2 x 300.
    expect((prices.get(1) ?? 0) + (prices.get(3) ?? 0)).toBe(800);
  });

  it("reports a single meet price only when the sessions actually agree", () => {
    expect(uniformIndividualPriceEgp(uniformDials({ individualEventPriceEgp: 300 }))).toBe(300);
    // One session out of step means there is no honest headline figure, and
    // callers must say "varies" rather than print session 1's price.
    expect(
      uniformIndividualPriceEgp([
        dials(1, { individualEventPriceEgp: 300 }),
        dials(2, { individualEventPriceEgp: 300 }),
        dials(3, { individualEventPriceEgp: 500 }),
      ]),
    ).toBeNull();
    expect(uniformIndividualPriceEgp([])).toBeNull();
  });

  it("holds a swimmer to the STRICTEST event limit across the sessions", () => {
    // Taking the loosest would let someone exceed session 2's own limit by
    // spreading entries across the other two.
    expect(
      effectiveEventLimit([
        dials(1, { athleteEventLimit: 4 }),
        dials(2, { athleteEventLimit: 2 }),
        dials(3, { athleteEventLimit: 6 }),
      ]),
    ).toBe(2);
    expect(effectiveEventLimit([])).toBe(DEFAULT_MEET_SETTINGS.athleteEventLimit);
  });
});
