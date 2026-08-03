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
