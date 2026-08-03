/**
 * Standard competition ranking ("1224"), the swimming placing rule.
 *
 * Swimmers who record the same time share a place, and the places they
 * consume are skipped: two swimmers tied for 1st are both 1st, and the next
 * swimmer is 3rd — not 2nd. That last part is what separates this from dense
 * ranking (which would say 2nd) and from a plain row number (which would
 * break the tie arbitrarily and hand one of them 2nd).
 *
 * ON PRECISION: official times are captured as mm:ss.cc / ss.cc and parsed as
 * `centiseconds * 10`, so every official_time_ms is an exact multiple of 10.
 * "Equal to the hundredth" is therefore exact integer equality — no epsilon or
 * rounding is needed, and introducing one would be wrong, since it would tie
 * times that the timing system distinguished.
 */

/** Assigns competition ranks to an array ALREADY SORTED best-first.
 *
 * The caller owns the sort — including any secondary key used purely for
 * stable display order. Only `keyOf` decides what counts as a tie, so a
 * display tiebreaker (e.g. who swam first) can order the rows without
 * silently splitting a genuine tie. */
export function assignCompetitionRanks<T>(
  sorted: readonly T[],
  keyOf: (item: T) => number,
): { item: T; rank: number }[] {
  let lastKey: number | null = null;
  let lastRank = 0;

  return sorted.map((item, index) => {
    const key = keyOf(item);
    if (lastKey === null || key !== lastKey) {
      // The skip is implicit: a new value takes its own 1-based position, so
      // the places consumed by the tie above it are simply never handed out.
      lastRank = index + 1;
      lastKey = key;
    }
    return { item, rank: lastRank };
  });
}

/** Convenience wrapper for the common `{ ...row, rank }` shape. */
export function withCompetitionRanks<T>(
  sorted: readonly T[],
  keyOf: (item: T) => number,
): (T & { rank: number })[] {
  return assignCompetitionRanks(sorted, keyOf).map(({ item, rank }) => ({ ...item, rank }));
}

/**
 * Splits a ranked field at a cutoff, refusing to break a tie that straddles it.
 *
 * Skins qualification takes the top 6, and each knockout round takes the top
 * 4 then the top 2. Slicing the list at that index silently decides a tie by
 * array position — two swimmers on identical times, one advances, one goes
 * home, on nothing but sort order. The rule is that they swim off.
 *
 * `keyOf` is lower-is-better (a time). Returns who is clear of the cutoff,
 * who is tied ON it, and how many places those tied swimmers are contesting.
 */
export interface CutoffResolution<T> {
  /** Clear of the cutoff — through on merit, no swim-off needed. */
  advancing: T[];
  /** Tied exactly on the cutoff place. Empty when the cutoff is clean. */
  swimOff: T[];
  /** How many of `swimOff` advance. Always >= 1 when swimOff is non-empty. */
  slotsRemaining: number;
}

export function resolveCutoff<T>(
  sorted: readonly T[],
  cutoff: number,
  keyOf: (item: T) => number,
): CutoffResolution<T> {
  if (cutoff <= 0) return { advancing: [], swimOff: [], slotsRemaining: 0 };
  // Field no bigger than the cutoff: everyone goes through, nothing to decide.
  if (sorted.length <= cutoff) return { advancing: [...sorted], swimOff: [], slotsRemaining: 0 };

  const boundary = keyOf(sorted[cutoff - 1]);
  const clear = sorted.filter((item) => keyOf(item) < boundary);
  const tied = sorted.filter((item) => keyOf(item) === boundary);

  // The tie sits entirely inside the cutoff — it decides nothing.
  if (clear.length + tied.length <= cutoff) {
    return { advancing: [...clear, ...tied], swimOff: [], slotsRemaining: 0 };
  }

  return { advancing: clear, swimOff: tied, slotsRemaining: cutoff - clear.length };
}
