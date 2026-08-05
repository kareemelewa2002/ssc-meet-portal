import { describe, expect, it } from "vitest";
import {
  CLOCK_TIME_ERROR,
  formatTimeMs,
  maskClockTimeInput,
  parseClockTime,
  parseTimeToMs,
  timeDropSeconds,
} from "@/lib/format";

describe("formatTimeMs", () => {
  it("formats sub-minute times without a minutes segment", () => {
    expect(formatTimeMs(29430)).toBe("29.43");
  });

  it("formats times over a minute with mm:ss.cc", () => {
    expect(formatTimeMs(65432)).toBe("1:05.43");
  });

  it("returns an em dash for null/undefined", () => {
    expect(formatTimeMs(null)).toBe("—");
    expect(formatTimeMs(undefined)).toBe("—");
  });
});

describe("parseClockTime / parseTimeToMs", () => {
  it("parses mm:ss.cc", () => {
    expect(parseTimeToMs("1:05.43")).toBe(65430);
    expect(parseClockTime("1:05.43")).toEqual({ ok: true, ms: 65430 });
  });

  it("parses ss.cc", () => {
    expect(parseTimeToMs("29.43")).toBe(29430);
  });

  it("rejects raw millisecond integer strings", () => {
    expect(parseTimeToMs("29430")).toBeNull();
    expect(parseClockTime("29430")).toEqual({ ok: false, error: CLOCK_TIME_ERROR });
  });

  it("rejects invalid seconds (>= 60) and wrong decimal precision", () => {
    expect(parseTimeToMs("1:65.00")).toBeNull();
    expect(parseTimeToMs("29.4")).toBeNull();
    expect(parseTimeToMs("29.432")).toBeNull();
    const invalid = parseClockTime("not-a-time");
    expect(invalid.ok).toBe(false);
    expect(invalid.ok === false && invalid.error).toBe(CLOCK_TIME_ERROR);
  });

  it("returns null for empty input via parseTimeToMs", () => {
    expect(parseTimeToMs("")).toBeNull();
    expect(parseTimeToMs("   ")).toBeNull();
  });
});

describe("timeDropSeconds", () => {
  it("returns the positive drop when official is faster than seed", () => {
    expect(timeDropSeconds(30000, 29000)).toBe(1);
  });

  it("returns null when the swimmer did not improve", () => {
    expect(timeDropSeconds(29000, 30000)).toBeNull();
    expect(timeDropSeconds(29000, 29000)).toBeNull();
  });

  it("returns null when either time is missing", () => {
    expect(timeDropSeconds(null, 29000)).toBeNull();
    expect(timeDropSeconds(30000, null)).toBeNull();
  });
});

describe("maskClockTimeInput — poolside keypad entry", () => {
  /** Types `keys` one character at a time, as a referee's thumb would. */
  const typeAll = (keys: string) => {
    let value = "";
    let caret = 0;
    for (const key of keys) {
      const raw = value.slice(0, caret) + key + value.slice(caret);
      const next = maskClockTimeInput(raw, caret + 1, value);
      value = next.value;
      caret = next.caret;
    }
    return { value, caret };
  };

  it("grows the separators as digits arrive", () => {
    // The requirement: 1 0 5 4 3 renders as 1:05.43 without the referee ever
    // reaching for a colon or a dot.
    expect(typeAll("1").value).toBe("1");
    expect(typeAll("10").value).toBe("10");
    expect(typeAll("105").value).toBe("1.05");
    expect(typeAll("1054").value).toBe("10.54");
    expect(typeAll("10543").value).toBe("1:05.43");
    expect(typeAll("110543").value).toBe("11:05.43");
  });

  it("produces strings parseClockTime already accepts", () => {
    // The parse rules are deliberately unchanged; the mask exists so a phone
    // keypad can reach them.
    expect(parseClockTime(typeAll("10543").value)).toEqual({ ok: true, ms: 65430 });
    expect(parseClockTime(typeAll("2943").value)).toEqual({ ok: true, ms: 29430 });
  });

  it("leaves the caret after the digit just typed", () => {
    expect(typeAll("10543").caret).toBe(7);
    expect(typeAll("29").caret).toBe(2);
  });

  it("is idempotent on an already-formatted value", () => {
    // Re-masking a stored time (formatTimeMs output loaded for correction)
    // must not rewrite it.
    for (const value of ["1:05.43", "29.43", "0.05", "11:05.43"]) {
      expect(maskClockTimeInput(value, value.length).value).toBe(value);
    }
  });

  it("ignores non-digits and caps at 99:59.99", () => {
    expect(maskClockTimeInput("1a0b5c4d3", 9).value).toBe("1:05.43");
    // A seventh digit is dropped rather than shifting the minutes off.
    expect(maskClockTimeInput("1105432", 7).value).toBe("11:05.43");
  });

  it("backspacing a digit shifts the rest right", () => {
    // "1:05.43" with the caret at the end, delete the trailing 3.
    const after = maskClockTimeInput("1:05.4", 6, "1:05.43");
    expect(after.value).toBe("10.54");
    expect(after.caret).toBe(5);
  });

  it("backspacing a separator deletes the digit in front of it", () => {
    // Deleting the ":" of "1:05.43" leaves the digits unchanged, so a naive
    // re-mask would put the colon straight back and the key would look dead.
    const after = maskClockTimeInput("105.43", 1, "1:05.43");
    expect(after.value).toBe("05.43");
    expect(after.caret).toBe(0);
  });

  it("clears to empty when every digit is deleted", () => {
    expect(maskClockTimeInput("", 0, "1:05.43").value).toBe("");
    expect(maskClockTimeInput("", 0, "1:05.43").caret).toBe(0);
  });

  it("keeps the caret with the digits when editing mid-string", () => {
    // "29.43" with the caret after the 9, type a 5: digits become 29543, so
    // the value re-lays out as 2:95.43 and the caret follows the new digit.
    const after = maskClockTimeInput("295.43", 3, "29.43");
    expect(after.value).toBe("2:95.43");
    expect(after.caret).toBe(4);
  });
});
