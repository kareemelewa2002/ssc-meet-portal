import { describe, expect, it } from "vitest";
import {
  heatAssignmentVisibility,
  isHeatSheetVisible,
  PENDING_SEEDING_LABEL,
} from "@/lib/heat-assignment-visibility";

describe("isHeatSheetVisible", () => {
  it("treats published and official as visible", () => {
    expect(isHeatSheetVisible("published")).toBe(true);
    expect(isHeatSheetVisible("official")).toBe(true);
  });

  it("hides draft and unknown statuses", () => {
    expect(isHeatSheetVisible("draft")).toBe(false);
    expect(isHeatSheetVisible(null)).toBe(false);
    expect(isHeatSheetVisible(undefined)).toBe(false);
  });
});

describe("heatAssignmentVisibility", () => {
  it("shows assigned heat only when confirmed and published with a lane", () => {
    expect(heatAssignmentVisibility("confirmed", true, true)).toEqual({ kind: "assigned" });
  });

  it("asks for seeding when paid but the sheet is not published", () => {
    expect(heatAssignmentVisibility("confirmed", false, false)).toEqual({
      kind: "pending_seeding",
    });
    expect(heatAssignmentVisibility("confirmed", false, true)).toEqual({
      kind: "pending_seeding",
    });
    expect(PENDING_SEEDING_LABEL).toMatch(/Payment confirmed/);
  });

  it("keeps unpaid entries on the desk-payment path", () => {
    expect(heatAssignmentVisibility("pending_payment", true, true)).toEqual({
      kind: "pending_payment",
    });
    expect(heatAssignmentVisibility("pending_payment", false, false)).toEqual({
      kind: "pending_payment",
    });
  });

  it("hides heat info for released holds", () => {
    expect(heatAssignmentVisibility("hold_expired", true, true)).toEqual({
      kind: "unavailable",
    });
  });
});
