/** Swim-meet clock validation / display helpers (mm:ss.cc or ss.cc). */

export const CLOCK_TIME_ERROR =
  "Please enter time in mm:ss.cc (e.g. 1:05.43) or ss.cc (e.g. 29.43) format.";

export const CLOCK_TIME_PLACEHOLDER = "mm:ss.cc or ss.cc";

export const CLOCK_TIME_HINT =
  "Enter time as mm:ss.cc (e.g. 1:05.43) or ss.cc (e.g. 29.43).";

/** mm:ss.cc — minutes 0–99, seconds 00–59, exactly two centisecond digits. */
const CLOCK_WITH_MINUTES = /^(\d{1,2}):([0-5]\d)\.(\d{2})$/;

/** ss.cc — whole seconds 0–59, exactly two centisecond digits. */
const CLOCK_SECONDS_ONLY = /^([0-5]?\d)\.(\d{2})$/;

export type ClockParseResult =
  | { ok: true; ms: number }
  | { ok: false; error: string };

/**
 * Strictly parses swim-meet clock input. Rejects raw millisecond integers and
 * any string that is not mm:ss.cc or ss.cc.
 */
export function parseClockTime(value: string): ClockParseResult {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, error: CLOCK_TIME_ERROR };
  }

  // Explicitly reject bare integers (raw ms) and other non-clock shapes.
  if (/^\d+$/.test(trimmed)) {
    return { ok: false, error: CLOCK_TIME_ERROR };
  }

  const withMinutes = trimmed.match(CLOCK_WITH_MINUTES);
  if (withMinutes) {
    const minutes = Number(withMinutes[1]);
    const seconds = Number(withMinutes[2]);
    const centiseconds = Number(withMinutes[3]);
    const ms = minutes * 60_000 + seconds * 1000 + centiseconds * 10;
    if (ms <= 0) return { ok: false, error: CLOCK_TIME_ERROR };
    return { ok: true, ms };
  }

  const secondsOnly = trimmed.match(CLOCK_SECONDS_ONLY);
  if (secondsOnly) {
    const seconds = Number(secondsOnly[1]);
    const centiseconds = Number(secondsOnly[2]);
    const ms = seconds * 1000 + centiseconds * 10;
    if (ms <= 0) return { ok: false, error: CLOCK_TIME_ERROR };
    return { ok: true, ms };
  }

  return { ok: false, error: CLOCK_TIME_ERROR };
}

/** Formats milliseconds as swim-meet clock time, e.g. 65432 -> "1:05.43". */
export function formatTimeMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const totalCentiseconds = Math.round(ms / 10);
  const minutes = Math.floor(totalCentiseconds / 6000);
  const seconds = Math.floor((totalCentiseconds % 6000) / 100);
  const centiseconds = totalCentiseconds % 100;
  const secondsStr = seconds.toString().padStart(2, "0");
  const centisecondsStr = centiseconds.toString().padStart(2, "0");
  return minutes > 0
    ? `${minutes}:${secondsStr}.${centisecondsStr}`
    : `${seconds}.${centisecondsStr}`;
}

/**
 * Parses a swim-meet clock time entered as "mm:ss.cc" or "ss.cc".
 * Returns null for empty/invalid input (including raw millisecond integers).
 */
export function parseTimeToMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const result = parseClockTime(trimmed);
  return result.ok ? result.ms : null;
}

/** Positive time drop in seconds (seed -> official), or null if not an improvement. */
export function timeDropSeconds(
  seedTimeMs: number | null | undefined,
  officialTimeMs: number | null | undefined,
): number | null {
  if (seedTimeMs == null || officialTimeMs == null) return null;
  if (officialTimeMs >= seedTimeMs) return null;
  return Math.round((seedTimeMs - officialTimeMs) / 10) / 100;
}

/** Heat-sheet label for the gender a heat is restricted to. null means a
 * legacy heat seeded before male and female were split into separate races. */
export function heatGenderLabel(gender: "male" | "female" | null | undefined): string | null {
  if (gender === "male") return "Men";
  if (gender === "female") return "Women";
  return null;
}

/**
 * The full name of a heat as it is called on deck: age board, gender, and the
 * heat's number WITHIN that board — "17 & Under Women Heat 2".
 *
 * heat_number restarts per (age group, gender), so the number alone is
 * ambiguous across an event; heat_order carries the global running order.
 */
export function heatTitle(heat: {
  heatGroup: "U13_14" | "U17_OPEN";
  gender: "male" | "female" | null | undefined;
  heatNumber: number;
}): string {
  const board = heat.heatGroup === "U13_14" ? "14 & Under" : "17 & Under / Open";
  const gender = heatGenderLabel(heat.gender);
  return [board, gender, `Heat ${heat.heatNumber}`].filter(Boolean).join(" ");
}
