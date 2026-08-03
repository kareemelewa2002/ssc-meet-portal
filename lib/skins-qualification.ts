import { LANE_SEQUENCE, LANES_PER_HEAT, type DraftHeat, type DraftHeatLane } from "@/lib/seeding";
import type { AgeGroup, Gender, HeatGroup, SkinsResponse } from "@/lib/supabase/types";
import { createClient } from "@/lib/supabase/client";
import { ok, runQuery, type FetchResult } from "@/lib/fetch-policy";
import { isValidUuid } from "@/lib/utils";
import { resolveCutoff } from "@/lib/ranking";

export const SKINS_SLOTS_PER_CATEGORY = 6;

export interface SkinsCandidate {
  athleteId: string;
  athleteName: string;
  teamName?: string | null;
  category: AgeGroup;
  gender: Gender;
  /** 1-based rank within the category AND gender (1 = fastest). */
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
  gender: Gender;
  active: SkinsQualifier[];
  confirmed: SkinsQualifier[];
  waitlisted: SkinsQualifier[];
  declined: SkinsQualifier[];
  /** Set when the last qualifying place is tied and must be swum off. */
  swimOff: SkinsSwimOff | null;
}

/** A tie sitting exactly on a cutoff place. The tied swimmers race again for
 * the places they are contesting — the alternative is deciding it on sort
 * order, which is not a result. */
export interface SkinsSwimOff {
  athletes: SkinsCandidate[];
  contestedTimeMs: number;
  slotsRemaining: number;
}

/**
 * Detects a tie sitting on the qualifying cutoff.
 *
 * Declined swimmers are removed first: they have given up their place, so
 * they cannot be part of a tie for it, and their removal is what pulls the
 * cutoff down onto a different pair in the first place.
 */
export function detectQualifyingSwimOff(
  candidates: SkinsCandidate[],
  slots: number = SKINS_SLOTS_PER_CATEGORY,
): SkinsSwimOff | null {
  const contenders = [...candidates]
    .filter((c) => c.response !== "declined")
    .sort((a, b) => a.bestTimeMs - b.bestTimeMs);

  const { swimOff, slotsRemaining } = resolveCutoff(contenders, slots, (c) => c.bestTimeMs);
  if (swimOff.length === 0) return null;
  return { athletes: swimOff, contestedTimeMs: swimOff[0].bestTimeMs, slotsRemaining };
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
 * Groups candidates by age category AND gender, applying rollover
 * independently to each of the six boards (U14/U17/Open x female/male).
 * Men and women never race each other, so they cannot compete for the same
 * six slots either — each board fills its own.
 */
export function buildSkinsQualifierBoards(
  candidates: SkinsCandidate[],
  slots: number = SKINS_SLOTS_PER_CATEGORY,
): CategoryQualifierBoard[] {
  const categories: AgeGroup[] = ["U14", "U17", "Open"];
  const genders: Gender[] = ["female", "male"];

  return categories.flatMap((category) => genders.map((gender) => {
    const qualified = applySkinsRollover(
      candidates.filter((c) => c.category === category && c.gender === gender),
      slots,
    );
    return {
      category,
      gender,
      active: qualified.filter((q) => q.isActiveQualifier),
      confirmed: qualified.filter((q) => q.isActiveQualifier && q.isConfirmed),
      waitlisted: qualified.filter((q) => !q.isActiveQualifier && q.response !== "declined"),
      declined: qualified.filter((q) => q.response === "declined"),
      swimOff: detectQualifyingSwimOff(
        candidates.filter((c) => c.category === category && c.gender === gender),
        slots,
      ),
    };
  }));
}

function categoryToHeatGroup(category: AgeGroup): HeatGroup {
  return category === "U14" ? "U13_14" : "U17_OPEN";
}

/**
 * Builds draft skins heats from accepted (confirmed) qualifiers.
 * Each category x gender seeds its own heat of up to 6, lanes [4,3,5,2,1,6].
 */
export function populateSkinsHeatSheets(
  confirmed: SkinsCandidate[],
): DraftHeat[] {
  const categories: AgeGroup[] = ["U14", "U17", "Open"];
  const genders: Gender[] = ["female", "male"];
  const heats: DraftHeat[] = [];
  let heatNumber = 0;

  for (const category of categories) {
    for (const gender of genders) {
      const swimmers = confirmed
        .filter((c) => c.category === category && c.gender === gender && c.response === "accepted")
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
        gender,
        heatNumber,
        heatOrder: heatNumber,
        status: "draft",
        lanes,
      });
    }
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

/**
 * Resolves the Skins event's real UUID.
 *
 * The admin dashboard used to hard-code `eventId="50m-freestyle-skins"` — a
 * slug, not a UUID — so every query it issued against uuid columns failed
 * with 22P02 and the Skins tab could never load real data.
 * NEXT_PUBLIC_SKINS_EVENT_ID is the intended override, but it ships as the
 * literal string "placeholder-skins-event-uuid" in fresh checkouts, so it is
 * only trusted when it actually parses as a UUID. Otherwise the single
 * `events.is_skins = true` row is authoritative — that flag is set by
 * supabase/seed-demo.sql's canonical program, so this self-heals across
 * re-seeds instead of drifting whenever ids are regenerated.
 */
export async function resolveSkinsEventId(): Promise<FetchResult<string | null>> {
  const configured = process.env.NEXT_PUBLIC_SKINS_EVENT_ID;
  if (configured && isValidUuid(configured)) return ok(configured);

  const result = await runQuery<{ id: string }[]>(
    "Resolving the Skins event",
    async () => {
      const supabase = createClient();
      return supabase.from("events").select("id").eq("is_skins", true).limit(1);
    },
    { empty: [] },
  );

  return { ...result, data: result.data[0]?.id ?? null };
}
