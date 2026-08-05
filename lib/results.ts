import type { DqReason, ResultOutcome } from "@/lib/supabase/types";

export const DQ_REASON_LABELS: Record<DqReason, string> = {
  false_start: "False start",
  stroke_infraction: "Stroke infraction",
  turn_infraction: "Turn infraction",
  turn_stroke_violation: "Turn / stroke violation",
  finish_infraction: "Finish infraction",
  unsporting_conduct: "Unsporting conduct",
  other: "Other",
};

export const RESULT_OUTCOME_LABELS: Record<ResultOutcome, string> = {
  valid: "Valid Time",
  dq: "DQ — Disqualified",
  no_show: "NS — No-Show",
};

export interface ScoredResultInput {
  outcome: ResultOutcome;
  /** Finish place 1..n — used for placement points when outcome is valid. */
  finishPlace?: number | null;
  /** Optional improvement calculation input (seed vs official). */
  seedTimeMs?: number | null;
  officialTimeMs?: number | null;
  /** Max placement points for 1st place (default 6 for a 6-lane heat). */
  maxPlacementPoints?: number;
}

export interface ScoredResult {
  resultOutcome: ResultOutcome;
  officialTimeMs: number | null;
  finishPlace: number | null;
  dqCode: DqReason | null;
  isNoShow: boolean;
  placementPoints: number;
  improvementPoints: number;
}

/**
 * Applies SSC scoring rules for a single heat result.
 * DQ and NS always receive 0 placement and 0 improvement points.
 * NS is flagged via isNoShow and must be excluded from Skins ranking.
 */
export function scoreHeatResult(
  input: ScoredResultInput,
  dqCode: DqReason | null = null,
): ScoredResult {
  const maxPoints = input.maxPlacementPoints ?? 6;

  if (input.outcome === "no_show") {
    return {
      resultOutcome: "no_show",
      officialTimeMs: null,
      finishPlace: null,
      dqCode: null,
      isNoShow: true,
      placementPoints: 0,
      improvementPoints: 0,
    };
  }

  if (input.outcome === "dq") {
    if (!dqCode) {
      throw new Error("DQ results require an official dq_code.");
    }
    return {
      resultOutcome: "dq",
      officialTimeMs: null,
      finishPlace: null,
      dqCode,
      isNoShow: false,
      placementPoints: 0,
      improvementPoints: 0,
    };
  }

  const finishPlace = input.finishPlace ?? null;
  const placementPoints =
    finishPlace != null && finishPlace >= 1
      ? Math.max(0, maxPoints + 1 - finishPlace)
      : 0;

  let improvementPoints = 0;
  if (
    input.seedTimeMs != null &&
    input.officialTimeMs != null &&
    input.seedTimeMs > 0 &&
    input.officialTimeMs > 0 &&
    input.officialTimeMs < input.seedTimeMs
  ) {
    // 0.1 point per 100ms improved, capped lightly for unit predictability.
    improvementPoints = Math.min(
      maxPoints,
      Math.round(((input.seedTimeMs - input.officialTimeMs) / 100) * 10) / 10,
    );
  }

  return {
    resultOutcome: "valid",
    officialTimeMs: input.officialTimeMs ?? null,
    finishPlace,
    dqCode: null,
    isNoShow: false,
    placementPoints,
    improvementPoints,
  };
}

/** NS (and optionally DQ) must never feed Skins qualification rankings. */
export function isEligibleForSkinsQualification(outcome: ResultOutcome): boolean {
  return outcome === "valid";
}

// ---------------------------------------------------------------------------
// Standing order — where a swim sits in a result table.
// ---------------------------------------------------------------------------

/**
 * Sort tier for one result: valid swims first, then DQ, then NS, then lanes
 * with nothing recorded at all.
 *
 * This is the same fact scoreHeatResult() already encodes — DQ and NS score
 * zero and NS is additionally excluded from Skins ranking — read as an
 * ordering rather than as points. Deliberately NOT a second notion of
 * validity: everything here keys off ResultOutcome, so a new outcome cannot
 * be added to the scoring rules and silently forgotten by the tables.
 *
 * DQ ahead of NS because a DQ swam and an NS did not, which is the order a
 * results sheet is read in. Both sit below every valid swim.
 */
export function resultStandingTier(outcome: ResultOutcome | null | undefined): number {
  if (outcome === "valid") return 0;
  if (outcome === "dq") return 1;
  if (outcome === "no_show") return 2;
  return 3;
}

export interface StandingSortable {
  outcome: ResultOutcome | null | undefined;
  /** Rank among the valid swims. Null on DQ/NS, which have no place. */
  place?: number | null;
  /** Tiebreaker when two rows share a tier and neither has a place. */
  officialTimeMs?: number | null;
}

/**
 * Comparator putting DQ and NS at the very bottom of a standing, below every
 * valid swim, in every table that ranks results.
 *
 * Within the valid tier it ranks by place, falling back to time when a place
 * has not been computed (a heat mid-entry) — never by lane number, which is
 * where a swimmer was put, not how they finished.
 */
export function compareResultStanding(a: StandingSortable, b: StandingSortable): number {
  const tier = resultStandingTier(a.outcome) - resultStandingTier(b.outcome);
  if (tier !== 0) return tier;

  const placeA = a.place ?? null;
  const placeB = b.place ?? null;
  if (placeA != null && placeB != null && placeA !== placeB) return placeA - placeB;
  if (placeA != null && placeB == null) return -1;
  if (placeA == null && placeB != null) return 1;

  const timeA = a.officialTimeMs ?? null;
  const timeB = b.officialTimeMs ?? null;
  if (timeA != null && timeB != null && timeA !== timeB) return timeA - timeB;
  if (timeA != null && timeB == null) return -1;
  if (timeA == null && timeB != null) return 1;

  return 0;
}
