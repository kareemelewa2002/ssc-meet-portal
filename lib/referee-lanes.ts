export type RefereeDeckMode = "lane" | "chief" | "observer";

export type LaneNumber = 1 | 2 | 3 | 4 | 5 | 6;

export interface LanePresenceClaim {
  laneNumber: LaneNumber;
  refereeId: string;
  refereeName: string;
  mode: "lane";
}

export interface PresenceOccupant {
  refereeId: string;
  refereeName: string;
  laneNumber: LaneNumber | null;
  mode: RefereeDeckMode;
}

export const LANE_NUMBERS: LaneNumber[] = [1, 2, 3, 4, 5, 6];

export function laneOccupiedBadge(lane: LaneNumber, occupantName: string): string {
  return `Lane ${lane} active by Referee ${occupantName}`;
}

/** Returns the occupant claiming a lane, if any (chief/observer do not occupy a single lane). */
export function findLaneOccupant(
  occupants: PresenceOccupant[],
  lane: LaneNumber,
): PresenceOccupant | null {
  return (
    occupants.find(
      (o) => o.mode === "lane" && o.laneNumber === lane,
    ) ?? null
  );
}

/**
 * Whether the current referee may claim `lane`.
 * Allowed when unoccupied, or already claimed by the same refereeId.
 */
export function canClaimLane(
  occupants: PresenceOccupant[],
  lane: LaneNumber,
  refereeId: string,
): { ok: true } | { ok: false; badge: string } {
  const occupant = findLaneOccupant(occupants, lane);
  if (!occupant || occupant.refereeId === refereeId) return { ok: true };
  return { ok: false, badge: laneOccupiedBadge(lane, occupant.refereeName) };
}

/** Lanes the referee may edit given their mode / focus. */
export function editableLaneNumbers(
  mode: RefereeDeckMode,
  focusedLane: LaneNumber | null,
): Set<LaneNumber> | "all" | "none" {
  if (mode === "chief") return "all";
  if (mode === "observer") return "none";
  if (focusedLane == null) return "none";
  return new Set([focusedLane]);
}

export function canEditLane(
  mode: RefereeDeckMode,
  focusedLane: LaneNumber | null,
  laneNumber: number,
): boolean {
  const editable = editableLaneNumbers(mode, focusedLane);
  if (editable === "all") return true;
  if (editable === "none") return false;
  return editable.has(laneNumber as LaneNumber);
}

export function isReadOnlyMode(mode: RefereeDeckMode): boolean {
  return mode === "observer";
}
