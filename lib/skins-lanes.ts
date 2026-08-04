import { LANE_SEQUENCE, LANES_PER_HEAT } from "@/lib/seeding";
import { resolveCutoff } from "@/lib/ranking";

/**
 * Lane allocation and round progression for the Skins knockout.
 *
 * Kept pure and separate from both the database and the bracket UI: these are
 * the rules of the format, and they are the part most worth testing directly.
 */

export type SkinsRound = 6 | 4 | 2;

export const ROUND_SEQUENCE: SkinsRound[] = [6, 4, 2];

export function nextRound(round: SkinsRound): SkinsRound | null {
  const idx = ROUND_SEQUENCE.indexOf(round);
  return idx >= 0 && idx < ROUND_SEQUENCE.length - 1 ? ROUND_SEQUENCE[idx + 1] : null;
}

/** How many swimmers come out of this round. The final produces a winner, not
 * a set of qualifiers, so it advances nobody. */
export function advanceCount(round: SkinsRound): number {
  if (round === 6) return 4;
  if (round === 4) return 2;
  return 0;
}

export function roundLabel(round: SkinsRound): string {
  return round === 2 ? "Final 2" : `Round of ${round}`;
}

/**
 * The centred block of `count` lanes in a `lanes`-lane pool.
 *
 * A shrinking field swims down the middle of the pool rather than leaving a
 * gap along one wall: four swimmers take lanes 2-5, the last two take 3-4.
 */
export function centredLanes(count: number, lanes: number = LANES_PER_HEAT): number[] {
  if (count <= 0) return [];
  if (count >= lanes) return Array.from({ length: lanes }, (_, i) => i + 1);
  const start = Math.floor((lanes - count) / 2) + 1;
  return Array.from({ length: count }, (_, i) => start + i);
}

/**
 * Re-seeds the survivors into the next round's lanes.
 *
 * Order is taken from the lane a swimmer just swam in, NOT from where they
 * finished: they keep their relative position across the pool and shift into
 * the centred block, so nobody crosses the pool between rounds on three
 * minutes' rest. Four qualifiers out of lanes 1-4 come back in lanes 2-5, in
 * that same order.
 */
export function reseedByLane<T extends { laneNumber: number }>(swimmers: readonly T[]): (T & { laneNumber: number })[] {
  const byLane = [...swimmers].sort((a, b) => a.laneNumber - b.laneNumber);
  const lanes = centredLanes(byLane.length);
  return byLane.map((swimmer, i) => ({ ...swimmer, laneNumber: lanes[i] }));
}

/** First-round lanes: fastest qualifier to lane 4, then 3, 5, 2, 1, 6. */
export function openingLanes(count: number): number[] {
  return LANE_SEQUENCE.slice(0, count) as unknown as number[];
}

export interface RoundOutcome<T> {
  /** Through to the next round. */
  advancing: T[];
  /** Tied exactly on the last qualifying place — they swim off for it. */
  swimOff: T[];
  /** How many of `swimOff` go through. */
  slotsRemaining: number;
}

/**
 * Who comes out of a round.
 *
 * A tie is a real result and is recorded as one — two swimmers who touch
 * together are both given the place. It only forces a re-swim when it
 * straddles the cutoff, because that is the one case where lane order would
 * otherwise decide who goes home. In the final there is no cutoff to
 * straddle, so a dead heat simply stands and the round has two winners.
 */
export function resolveRound<T extends { finishPlace: number | null; outcome: string | null }>(
  round: SkinsRound,
  swimmers: readonly T[],
): RoundOutcome<T> {
  const finishers = swimmers
    .filter((s) => s.outcome === "valid" && s.finishPlace !== null)
    .sort((a, b) => (a.finishPlace ?? 0) - (b.finishPlace ?? 0));

  // The final advances nobody, so there is no cutoff and nothing to swim off.
  if (advanceCount(round) === 0) {
    return { advancing: [], swimOff: [], slotsRemaining: 0 };
  }

  return resolveCutoff(finishers, advanceCount(round), (s) => s.finishPlace ?? Number.MAX_SAFE_INTEGER);
}

export interface RoundLaneLike {
  athleteId: string;
  laneNumber: number;
  finishPlace: number | null;
  outcome: string | null;
}

export interface RoundLike {
  round: SkinsRound;
  swimOff: boolean;
  /** Every lane has a recorded outcome. */
  complete: boolean;
  lanes: RoundLaneLike[];
}

/** What the board does next, once a round has been scored. */
export type BoardNextStep =
  | { kind: "waiting" }
  | { kind: "swim-off"; athletes: RoundLaneLike[]; lanes: number[]; slotsRemaining: number }
  | { kind: "next-round"; round: SkinsRound; field: (RoundLaneLike & { laneNumber: number })[] }
  | { kind: "complete"; winners: RoundLaneLike[] };

/**
 * Decides what follows `round` on one board.
 *
 * The swim-off is a real round with its own result, so it is read back from
 * the recorded rounds rather than assumed: until it has been swum and scored
 * the board waits, and once it has, its winners join the swimmers who were
 * already clear of the cutoff.
 *
 * Swim-off winners are re-seeded from the lane they held in the MAIN round,
 * not the lane they were given for the swim-off — the swim-off is a tiebreak,
 * not a re-draw of the field.
 */
export function planNextStep(rounds: readonly RoundLike[], round: SkinsRound): BoardNextStep {
  const main = rounds.find((r) => r.round === round && !r.swimOff);
  if (!main || !main.complete) return { kind: "waiting" };

  const { advancing, swimOff, slotsRemaining } = resolveRound(round, main.lanes);

  // The final decides a winner rather than a field. A dead heat stands.
  if (advanceCount(round) === 0) {
    const best = main.lanes
      .filter((l) => l.outcome === "valid" && l.finishPlace !== null)
      .sort((a, b) => (a.finishPlace ?? 0) - (b.finishPlace ?? 0));
    const topPlace = best[0]?.finishPlace ?? null;
    return { kind: "complete", winners: best.filter((l) => l.finishPlace === topPlace) };
  }

  let throughFromTie: RoundLaneLike[] = [];
  if (swimOff.length > 0) {
    const decider = rounds.find((r) => r.round === round && r.swimOff);
    if (!decider) {
      return { kind: "swim-off", athletes: swimOff, lanes: centredLanes(swimOff.length), slotsRemaining };
    }
    if (!decider.complete) return { kind: "waiting" };

    const settled = decider.lanes
      .filter((l) => l.outcome === "valid" && l.finishPlace !== null)
      .sort((a, b) => (a.finishPlace ?? 0) - (b.finishPlace ?? 0))
      .slice(0, slotsRemaining);
    // Back to their main-round lanes, so the re-seed reflects the round proper.
    const laneInMain = new Map(main.lanes.map((l) => [l.athleteId, l.laneNumber]));
    throughFromTie = settled.map((l) => ({ ...l, laneNumber: laneInMain.get(l.athleteId) ?? l.laneNumber }));
  }

  const upcoming = nextRound(round);
  if (!upcoming) return { kind: "waiting" };

  return { kind: "next-round", round: upcoming, field: reseedByLane([...advancing, ...throughFromTie]) };
}
