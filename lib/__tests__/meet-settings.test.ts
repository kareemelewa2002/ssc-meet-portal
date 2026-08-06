import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEET_SETTINGS,
  computeScheduleCapacity,
  defaultMeetSettings,
  estimatedSessionSeconds,
  eventLimitExceedsSchedule,
  formatDurationSeconds,
  maxHeatsPerSession,
  maxSwimsPerSession,
  parseTimeOfDaySeconds,
  registrationState,
  requiredSwims,
  sessionDurationSeconds,
  turnaroundProfile,
  type MeetSettings,
  type ScheduledEvent,
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

const settings = (overrides: Partial<MeetSettings> = {}): MeetSettings => ({
  ...defaultMeetSettings("vol-1"),
  ...overrides,
});

const race = (
  id: string,
  sessionId: string,
  turnaroundSeconds: number,
  overrides: Partial<ScheduledEvent> = {},
): ScheduledEvent => ({
  id,
  sessionId,
  name: id,
  distanceM: 50,
  stroke: "Freestyle",
  isRelay: false,
  eventOrder: 1,
  turnaroundSeconds,
  surchargeEgp: 0,
  capacityCap: 64,
  ...overrides,
});

describe("parseTimeOfDaySeconds", () => {
  it("accepts both HH:MM and HH:MM:SS", () => {
    expect(parseTimeOfDaySeconds("09:30")).toBe(9 * 3600 + 30 * 60);
    expect(parseTimeOfDaySeconds("09:30:15")).toBe(9 * 3600 + 30 * 60 + 15);
  });

  it("rejects nonsense rather than coercing it", () => {
    expect(parseTimeOfDaySeconds("25:00")).toBeNull();
    expect(parseTimeOfDaySeconds("09:60")).toBeNull();
    expect(parseTimeOfDaySeconds("half nine")).toBeNull();
    expect(parseTimeOfDaySeconds("")).toBeNull();
    expect(parseTimeOfDaySeconds(null)).toBeNull();
  });
});

describe("sessionDurationSeconds", () => {
  it("measures an ordinary session", () => {
    expect(sessionDurationSeconds("09:00", "13:00")).toBe(4 * 3600);
  });

  it("reads an end time before the start as crossing midnight", () => {
    // A Skins final running 22:00-00:30 is a real schedule. Reporting it as a
    // negative duration would put a nonsense heat count in front of an admin.
    expect(sessionDurationSeconds("22:00", "00:30")).toBe(2.5 * 3600);
  });

  it("is null when either end is unparseable", () => {
    expect(sessionDurationSeconds("09:00", "nope")).toBeNull();
  });
});

describe("turnaroundProfile", () => {
  it("summarises the spread of the races in a session", () => {
    const profile = turnaroundProfile([
      race("a", "s1", 45),
      race("b", "s1", 45),
      race("c", "s1", 150),
    ]);
    expect(profile.eventCount).toBe(3);
    expect(profile.meanTurnaroundSeconds).toBe(80);
    expect(profile.minTurnaroundSeconds).toBe(45);
    expect(profile.maxTurnaroundSeconds).toBe(150);
    expect(profile.singlePassSeconds).toBe(240);
  });

  it("is all zeroes for a session with no races, not NaN", () => {
    // A mean of NaN would propagate into every downstream figure and render
    // as "NaN heats" rather than as an empty session.
    const profile = turnaroundProfile([]);
    expect(profile.meanTurnaroundSeconds).toBe(0);
    expect(Number.isNaN(profile.meanTurnaroundSeconds)).toBe(false);
  });
});

describe("maxHeatsPerSession", () => {
  it("floors — a heat that does not fit does not half-run", () => {
    expect(maxHeatsPerSession(3600, 90)).toBe(40);
    expect(maxHeatsPerSession(3650, 90)).toBe(40);
  });

  it("is zero rather than infinite when turnaround is zero or missing", () => {
    expect(maxHeatsPerSession(3600, 0)).toBe(0);
    expect(maxHeatsPerSession(null, 90)).toBe(0);
    expect(maxHeatsPerSession(-100, 90)).toBe(0);
  });
});

describe("maxSwimsPerSession", () => {
  it("multiplies heats by the configured lane count", () => {
    expect(maxSwimsPerSession(3600, 90, 8)).toBe(40 * 8);
    expect(maxSwimsPerSession(3600, 90, 6)).toBe(40 * 6);
  });
});

describe("estimatedSessionSeconds", () => {
  it("weights each race by its OWN turnaround, not by an average", () => {
    // This is the whole point of per-event turnaround: 2 heats of a 45s race
    // and 3 heats of a 150s race is 540s, not 5 heats x some mean.
    const events = [race("sprint", "s1", 45), race("distance", "s1", 150)];
    const heats = new Map([
      ["sprint", 2],
      ["distance", 3],
    ]);
    expect(estimatedSessionSeconds(events, heats)).toBe(2 * 45 + 3 * 150);
  });

  it("counts a race with no heats as nothing", () => {
    expect(estimatedSessionSeconds([race("a", "s1", 90)], new Map())).toBe(0);
  });
});

describe("computeScheduleCapacity", () => {
  const sessions = [
    session({ id: "s1", sessionNumber: 1, startTime: "09:00", endTime: "13:00" }),
    session({ id: "s2", sessionNumber: 2, startTime: "13:30", endTime: "17:00" }),
  ];

  it("derives each session's figures from the races actually in it", () => {
    const events = [
      race("a", "s1", 45),
      race("b", "s1", 45),
      // s2 holds distance events, so it turns over far more slowly and must
      // NOT inherit s1's rate.
      race("c", "s2", 150),
    ];

    const readout = computeScheduleCapacity(sessions, settings({ laneCount: 8 }), events);

    expect(readout.perSession[0].profile.meanTurnaroundSeconds).toBe(45);
    expect(readout.perSession[0].maxHeats).toBe(Math.floor((4 * 3600) / 45));
    expect(readout.perSession[1].profile.meanTurnaroundSeconds).toBe(150);
    expect(readout.perSession[1].maxHeats).toBe(Math.floor((3.5 * 3600) / 150));
  });

  it("flags a session whose seeded heats overrun its own clock", () => {
    const events = [race("a", "s1", 3600)];
    const heats = new Map([["a", 5]]); // 5 hours of racing in a 4-hour session
    const readout = computeScheduleCapacity(sessions, settings(), events, heats);

    expect(readout.perSession[0].estimatedSeconds).toBe(5 * 3600);
    expect(readout.perSession[0].overrunsClock).toBe(true);
  });

  it("reports no estimate at all before anything is seeded", () => {
    // null, not 0. Zero would read as "this session takes no time".
    const readout = computeScheduleCapacity(sessions, settings(), [race("a", "s1", 90)]);
    expect(readout.perSession[0].estimatedSeconds).toBeNull();
    expect(readout.perSession[0].overrunsClock).toBe(false);
  });

  it("divides total swims by athlete capacity for the event-limit ceiling", () => {
    const events = [race("a", "s1", 90), race("b", "s2", 90)];
    const readout = computeScheduleCapacity(
      sessions,
      settings({ athleteCapacity: 100, laneCount: 8 }),
      events,
    );
    expect(readout.computedEventLimitCeiling).toBe(
      Math.floor(readout.totalSwims / 100),
    );
  });

  it("gives a ceiling of zero rather than dividing by zero", () => {
    const readout = computeScheduleCapacity(
      sessions,
      settings({ athleteCapacity: 0 }),
      [race("a", "s1", 90)],
    );
    expect(readout.computedEventLimitCeiling).toBe(0);
  });
});

describe("eventLimitExceedsSchedule", () => {
  const sessions = [session({ id: "s1", startTime: "09:00", endTime: "13:00" })];
  const events = [race("a", "s1", 90)];

  it("warns when a full field at the chosen limit does not fit", () => {
    const cfg = settings({ athleteCapacity: 500, athleteEventLimit: 4, laneCount: 8 });
    const capacity = computeScheduleCapacity(sessions, cfg, events);
    expect(requiredSwims(500, 4)).toBe(2000);
    expect(eventLimitExceedsSchedule(capacity, 500, 4)).toBe(true);
  });

  it("does not warn when it fits", () => {
    const cfg = settings({ athleteCapacity: 50, athleteEventLimit: 2, laneCount: 8 });
    const capacity = computeScheduleCapacity(sessions, cfg, events);
    expect(eventLimitExceedsSchedule(capacity, 50, 2)).toBe(false);
  });
});

describe("registrationState", () => {
  const now = new Date("2026-08-10T12:00:00Z");

  it("is open inside the window", () => {
    const state = registrationState(
      settings({
        registrationOpensAt: "2026-08-01T00:00:00Z",
        registrationClosesAt: "2026-08-20T00:00:00Z",
      }),
      now,
    );
    expect(state.open).toBe(true);
    expect(state.reason).toBeNull();
  });

  it("explains why it is shut rather than just hiding the form", () => {
    const before = registrationState(
      settings({ registrationOpensAt: "2026-09-01T00:00:00Z" }),
      now,
    );
    expect(before.open).toBe(false);
    expect(before.reason).toContain("opens");

    const after = registrationState(
      settings({ registrationClosesAt: "2026-08-01T00:00:00Z" }),
      now,
    );
    expect(after.open).toBe(false);
    expect(after.reason).toContain("closed");
  });

  it("reopens a closed window when late registration is enabled", () => {
    // The published deadline stays where it is — athletes may have
    // screenshotted it — and the toggle is what changes.
    const state = registrationState(
      settings({
        registrationClosesAt: "2026-08-01T00:00:00Z",
        lateRegistrationEnabled: true,
      }),
      now,
    );
    expect(state.open).toBe(true);
    expect(state.reason).toContain("Late");
  });

  it("is open when no window is configured at all", () => {
    expect(registrationState(settings(), now).open).toBe(true);
  });
});

describe("formatDurationSeconds", () => {
  it("renders hours and minutes", () => {
    expect(formatDurationSeconds(4 * 3600)).toBe("4h");
    expect(formatDurationSeconds(3.5 * 3600)).toBe("3h 30m");
    expect(formatDurationSeconds(45 * 60)).toBe("45m");
  });

  it("shows an em dash for nothing, never '0m'", () => {
    expect(formatDurationSeconds(null)).toBe("—");
    expect(formatDurationSeconds(0)).toBe("—");
  });
});

describe("DEFAULT_MEET_SETTINGS", () => {
  it("mirrors the schema column defaults", () => {
    // These exist so an unconfigured VOLUME renders a usable form. They are
    // not a fallback for a failed query — see lib/fetch-policy.ts.
    expect(DEFAULT_MEET_SETTINGS.athleteCapacity).toBe(200);
    expect(DEFAULT_MEET_SETTINGS.holdWindowHours).toBe(48);
    expect(DEFAULT_MEET_SETTINGS.waitlistClaimHours).toBe(24);
    expect(DEFAULT_MEET_SETTINGS.sellingOutThresholdPercent).toBe(20);
    expect(DEFAULT_MEET_SETTINGS.athleteEventLimit).toBe(4);
    expect(DEFAULT_MEET_SETTINGS.pinnedPricingTier).toBeNull();
  });
});
