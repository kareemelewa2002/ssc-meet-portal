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

// ---------------------------------------------------------------------------
// Live input mask (poolside ergonomics)
// ---------------------------------------------------------------------------
//
// A referee scoring a heat on a phone has a numeric keypad in front of them
// and no colon or dot within reach. So they type digits and the field grows
// the separators: 1 0 5 4 3 renders as "1:05.43" while they type.
//
// The mask is right-anchored — the last two digits are always centiseconds,
// the two before that seconds, everything left of those minutes — because
// that is the direction a time is actually known. Nobody types the minutes of
// a 29-second swim first.
//
// This is FORMATTING ONLY. parseClockTime above is untouched: it still
// strictly accepts mm:ss.cc and ss.cc, still rejects raw integers, and the
// field still flags invalid input with aria-invalid exactly as before. The
// mask just means the referee reaches a valid string by pressing digits.

/** Longest time the field accepts: 99:59.99. */
const MAX_CLOCK_DIGITS = 6;

function formatClockDigits(digits: string): string {
  const n = digits.length;
  if (n === 0) return "";
  // One or two digits are still ambiguous (is "29" 29 seconds or the start of
  // 2:9x?), so no separator is guessed until a third digit settles it.
  if (n <= 2) return digits;
  if (n <= 4) return `${digits.slice(0, n - 2)}.${digits.slice(n - 2)}`;
  return `${digits.slice(0, n - 4)}:${digits.slice(n - 4, n - 2)}.${digits.slice(n - 2)}`;
}

export interface MaskedClockTime {
  value: string;
  /** Where the caret belongs in `value`, counted in characters. */
  caret: number;
}

/**
 * Applies the mask to whatever the input element now holds.
 *
 * `previousValue` exists for one case that is otherwise unfixable: backspacing
 * over a separator. Deleting the ":" of "1:05.43" leaves "105.43", whose digits
 * are unchanged — so a naive re-mask puts the ":" straight back and the key
 * appears dead. When the edit removed exactly one character and no digits, the
 * digit in front of the separator is removed instead, which is what the
 * referee meant.
 */
export function maskClockTimeInput(
  raw: string,
  caretPosition: number | null | undefined,
  previousValue?: string,
): MaskedClockTime {
  const caret = caretPosition ?? raw.length;
  let digits = raw.replace(/\D/g, "").slice(0, MAX_CLOCK_DIGITS);
  let digitsBeforeCaret = raw.slice(0, caret).replace(/\D/g, "").length;

  const deletedOneChar =
    previousValue !== undefined && raw.length === previousValue.length - 1;
  const digitsUnchanged =
    previousValue !== undefined && digits === previousValue.replace(/\D/g, "").slice(0, MAX_CLOCK_DIGITS);
  if (deletedOneChar && digitsUnchanged && digitsBeforeCaret > 0) {
    digits = digits.slice(0, digitsBeforeCaret - 1) + digits.slice(digitsBeforeCaret);
    digitsBeforeCaret -= 1;
  }

  digitsBeforeCaret = Math.min(digitsBeforeCaret, digits.length);
  const value = formatClockDigits(digits);

  // Walk the formatted string until as many digits have gone by as sat before
  // the caret in the raw input. Separators shift the caret along with them,
  // so inserting one never strands it mid-number.
  let seen = 0;
  let index = 0;
  while (index < value.length && seen < digitsBeforeCaret) {
    if (/\d/.test(value[index])) seen += 1;
    index += 1;
  }

  return { value, caret: index };
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
  /** Skins only: 6, 4 or 2. Set means this heat is one round of a bracket. */
  skinsRound?: number | null;
  skinsSwimOff?: boolean | null;
  /** Skins only. heat_group cannot tell 17 & Under from Open — it folds them
   * together — so without this the two boards of a gender render the SAME
   * title and are indistinguishable in a list. */
  skinsCategory?: "U14" | "U17" | "Open" | null;
}): string {
  const board = heat.heatGroup === "U13_14" ? "14 & Under" : "17 & Under / Open";
  const gender = heatGenderLabel(heat.gender);

  // A Skins heat's number encodes its board and round so the per-bucket
  // uniqueness constraint holds (see skins_heat_number). It is not a heat
  // number anybody should read — name the round instead.
  if (heat.skinsRound != null) {
    const round = heat.skinsRound === 2 ? "Final 2" : `Round of ${heat.skinsRound}`;
    const skinsBoard = heat.skinsCategory
      ? { U14: "14 & Under", U17: "17 & Under", Open: "Open" }[heat.skinsCategory]
      : board;
    return [skinsBoard, gender, heat.skinsSwimOff ? `${round} swim-off` : round]
      .filter(Boolean)
      .join(" ");
  }

  return [board, gender, `Heat ${heat.heatNumber}`].filter(Boolean).join(" ");
}
