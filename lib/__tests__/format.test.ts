import { describe, expect, it } from "vitest";
import { formatTimeMs, parseTimeToMs, timeDropSeconds } from "@/lib/format";

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

describe("parseTimeToMs", () => {
  it("parses mm:ss.cc", () => {
    expect(parseTimeToMs("1:05.43")).toBe(65430);
  });

  it("parses ss.cc", () => {
    expect(parseTimeToMs("29.43")).toBe(29430);
  });

  it("parses a plain millisecond integer", () => {
    expect(parseTimeToMs("29430")).toBe(29430);
  });

  it("returns null for empty or invalid input", () => {
    expect(parseTimeToMs("")).toBeNull();
    expect(parseTimeToMs("   ")).toBeNull();
    expect(parseTimeToMs("not-a-time")).toBeNull();
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
