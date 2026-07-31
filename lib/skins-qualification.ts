import { LANE_SEQUENCE, LANES_PER_HEAT, type DraftHeat, type DraftHeatLane } from "@/lib/seeding";
import type { AgeGroup, HeatGroup, SkinsResponse } from "@/lib/supabase/types";

export const SKINS_SLOTS_PER_CATEGORY = 6;

export interface SkinsCandidate {
  athleteId: string;
  athleteName: string;
  teamName?: string | null;
  category: AgeGroup;
  /** 1-based rank within the category (1 = fastest). */
  sourceRank: number;
  bestTimeMs: number;
  response: SkinsResponse;
}

export interface SkinsQualifier extends SkinsCandidate {
  isActiveQualifier: boolean;
  isConfirmed: boolean;
  /** 1..6 when active; null when waitlisted / declined outside the window. */
  slotNumber: number | null;
}

export interface CategoryQualifierBoard {
  category: AgeGroup;
  active: SkinsQualifier[];
  confirmed: SkinsQualifier[];
  waitlisted: SkinsQualifier[];
  declined: SkinsQualifier[];
}

/**
 * Applies the decline / rollover rule within a single age-group category.
 *
 * Walk the ranked list (fastest first). Declined athletes are skipped.
 * The first `slots` non-declined athletes become active qualifiers
 * (pending or accepted). Confirmed participants are those who accepted.
 */
export function applySkinsRollover(
  candidates: SkinsCandidate[],
  slots: number = SKINS_SLOTS_PER_CATEGORY,
): SkinsQualifier[] {
  const ranked = [...candidates].sort((a, b) => {
    if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
    return a.bestTimeMs - b.bestTimeMs;
  });

  let activeCount = 0;

  return ranked.map((candidate) => {
    const declined = candidate.response === "declined";
    const isActiveQualifier = !declined && activeCount < slots;
    if (isActiveQualifier) activeCount += 1;

    return {
      ...candidate,
      isActiveQualifier,
      isConfirmed: candidate.response === "accepted",
      slotNumber: isActiveQualifier ? activeCount : null,
    };
  });
}

/**
 * Groups candidates by age category and applies rollover independently
 * for U13-14, U17, and Open — each fills up to 6 active slots.
 */
export function buildSkinsQualifierBoards(
  candidates: SkinsCandidate[],
  slots: number = SKINS_SLOTS_PER_CATEGORY,
): CategoryQualifierBoard[] {
  const categories: AgeGroup[] = ["U13_14", "U17", "Open"];

  return categories.map((category) => {
    const qualified = applySkinsRollover(
      candidates.filter((c) => c.category === category),
      slots,
    );
    return {
      category,
      active: qualified.filter((q) => q.isActiveQualifier),
      confirmed: qualified.filter((q) => q.isActiveQualifier && q.isConfirmed),
      waitlisted: qualified.filter((q) => !q.isActiveQualifier && q.response !== "declined"),
      declined: qualified.filter((q) => q.response === "declined"),
    };
  });
}

function categoryToHeatGroup(category: AgeGroup): HeatGroup {
  return category === "U13_14" ? "U13_14" : "U17_OPEN";
}

/**
 * Builds draft skins heats from accepted (confirmed) qualifiers.
 * Each category seeds its own heat of up to 6, lanes [4,3,5,2,1,6].
 */
export function populateSkinsHeatSheets(
  confirmed: SkinsCandidate[],
): DraftHeat[] {
  const categories: AgeGroup[] = ["U13_14", "U17", "Open"];
  const heats: DraftHeat[] = [];
  let heatNumber = 0;

  for (const category of categories) {
    const swimmers = confirmed
      .filter((c) => c.category === category && c.response === "accepted")
      .sort((a, b) => a.bestTimeMs - b.bestTimeMs)
      .slice(0, LANES_PER_HEAT);

    if (swimmers.length === 0) continue;

    heatNumber += 1;
    const lanes: DraftHeatLane[] = swimmers.map((s, index) => ({
      laneNumber: LANE_SEQUENCE[index],
      entryId: `skins-${s.athleteId}`,
      athleteId: s.athleteId,
    }));

    heats.push({
      heatGroup: categoryToHeatGroup(category),
      heatNumber,
      heatOrder: heatNumber,
      status: "draft",
      lanes,
    });
  }

  return heats;
}

/** After a decline, returns the athlete who rolls into the vacated slot (if any). */
export function nextRolloverAthlete(
  candidates: SkinsCandidate[],
  declinedAthleteId: string,
  slots: number = SKINS_SLOTS_PER_CATEGORY,
): SkinsCandidate | null {
  const declined = candidates.find((c) => c.athleteId === declinedAthleteId);
  if (!declined) return null;

  const before = applySkinsRollover(candidates, slots);
  const after = applySkinsRollover(
    candidates.map((c) =>
      c.athleteId === declinedAthleteId ? { ...c, response: "declined" as const } : c,
    ),
    slots,
  );

  const beforeIds = new Set(before.filter((q) => q.isActiveQualifier).map((q) => q.athleteId));
  const newlyActive = after.find((q) => q.isActiveQualifier && !beforeIds.has(q.athleteId));
  return newlyActive ?? null;
}
