import { describe, expect, it } from "vitest";
import {
  canClaimLane,
  canEditLane,
  findLaneOccupant,
  isReadOnlyMode,
  laneOccupiedBadge,
  type PresenceOccupant,
} from "@/lib/referee-lanes";

const occupants: PresenceOccupant[] = [
  {
    refereeId: "ref-a",
    refereeName: "Alex",
    laneNumber: 3,
    mode: "lane",
  },
  {
    refereeId: "ref-chief",
    refereeName: "Chief",
    laneNumber: null,
    mode: "chief",
  },
];

describe("canClaimLane", () => {
  it("allows claiming an unoccupied lane", () => {
    expect(canClaimLane(occupants, 1, "ref-b")).toEqual({ ok: true });
  });

  it("blocks claiming a lane held by another referee", () => {
    const result = canClaimLane(occupants, 3, "ref-b");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.badge).toBe(laneOccupiedBadge(3, "Alex"));
    }
  });

  it("allows the same referee to keep their own lane", () => {
    expect(canClaimLane(occupants, 3, "ref-a")).toEqual({ ok: true });
  });
});

describe("canEditLane / modes", () => {
  it("lets chief edit every lane", () => {
    expect(canEditLane("chief", null, 1)).toBe(true);
    expect(canEditLane("chief", null, 6)).toBe(true);
  });

  it("restricts lane referees to their focused lane", () => {
    expect(canEditLane("lane", 2, 2)).toBe(true);
    expect(canEditLane("lane", 2, 3)).toBe(false);
  });

  it("marks observer as read-only", () => {
    expect(isReadOnlyMode("observer")).toBe(true);
    expect(canEditLane("observer", null, 1)).toBe(false);
  });
});

describe("findLaneOccupant", () => {
  it("ignores chief/observer when looking up a lane claim", () => {
    expect(findLaneOccupant(occupants, 3)?.refereeName).toBe("Alex");
    expect(findLaneOccupant(occupants, 4)).toBeNull();
  });
});
