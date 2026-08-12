import type { AgeGroup, Gender, HeatGroup } from "@/lib/supabase/types";

/**
 * The order the deck calls the boards of one event.
 *
 *   14 & Under Women -> 14 & Under Men -> 17 & Under/Open Women -> ... Men
 *
 * Mirrors public.category_sort_order() in supabase/schema.sql — the SQL copy
 * exists so ordering is available to any query, this one so the three screens
 * that list heats (/admin/seeding, /events/[volId]/heats, /referee) all sort
 * the same way without a round trip.
 *
 * FOUR buckets, not six. age_group has three values (U14/U17/Open), but an
 * ordinary heat only ever carries heat_group, which folds 17 & Under together
 * with Open — so "Open" in the running order means the combined U17_OPEN
 * board. Sorting by age_group here would invent two boards that no heat is
 * ever assigned to.
 *
 * ORDERING ONLY — never a gate. Later-category heats are not hidden, locked,
 * collapsed or marked "waiting on 14 & Under": a referee may score any heat at
 * any time. A meet that deadlocks behind one disputed heat is a worse failure
 * than a meet scored slightly out of order.
 */
export const CATEGORY_RUNNING_ORDER = [
  { heatGroup: "U13_14", gender: "female" },
  { heatGroup: "U13_14", gender: "male" },
  { heatGroup: "U17_OPEN", gender: "female" },
  { heatGroup: "U17_OPEN", gender: "male" },
] as const satisfies readonly { heatGroup: HeatGroup; gender: Gender }[];

export interface CategorySortable {
  heatGroup: HeatGroup;
  /** null only on legacy heats seeded before male and female were split. */
  gender: Gender | null | undefined;
}

/**
 * 1, 2, 4, 5 for the four real buckets, in running order.
 *
 * 3 and 6 are legacy heats with no gender. They sort LAST within their own
 * board rather than being folded in with the men's — a mixed heat from before
 * the split is not a men's heat, and putting it there would misstate what it
 * is on a screen a referee reads to know what swims next.
 */
export function categorySortOrder(heat: CategorySortable): number {
  const board = heat.heatGroup === "U13_14" ? 0 : 3;
  const gender = heat.gender === "female" ? 1 : heat.gender === "male" ? 2 : 3;
  return board + gender;
}

/** Label for the bucket, for a heading or a legend. */
export function categoryLabel(heat: CategorySortable): string {
  const board = heat.heatGroup === "U13_14" ? "14 & Under" : "17 & Under / Open";
  const gender = heat.gender === "female" ? "Women" : heat.gender === "male" ? "Men" : "Mixed";
  return `${board} ${gender}`;
}

/**
 * Category first, then heat number within the category.
 *
 * heat_number is the right tiebreaker for Skins too: skins_heat_number()
 * encodes category tens + round units + 5 for a swim-off, so within the
 * U17_OPEN bucket the U17 rounds (2x) precede the Open rounds (3x), each board
 * runs 6 -> 4 -> 2, and a swim-off follows the round it settles. Skins is
 * listed inline with every other race rather than dumped at one end.
 */
export function compareByCategory<T extends CategorySortable & { heatNumber: number }>(
  a: T,
  b: T,
): number {
  return categorySortOrder(a) - categorySortOrder(b) || a.heatNumber - b.heatNumber;
}

/**
 * The order a published STANDING lists its boards: youngest first, women
 * before men.
 *
 * Six buckets, not the four above. A heat carries heat_group, which folds
 * 17 & Under together with Open because they swim the same water — but a
 * standing carries age_group, and U17 and Open are genuinely separate boards
 * there, each with its own places and its own points. Reusing
 * categorySortOrder() here would have to invent a heat_group for a row that
 * has none, and would merge two boards that are deliberately distinct.
 */
export function resultBoardSortOrder(row: { ageGroup: AgeGroup; gender: Gender }): number {
  const boards: AgeGroup[] = ["U14", "U17", "Open"];
  const board = boards.indexOf(row.ageGroup);
  // An unrecognised board sorts last rather than first: indexOf returns -1,
  // and a negative rank would float an unknown category above 14 & Under.
  const rank = board === -1 ? boards.length : board;
  return rank * 2 + (row.gender === "female" ? 0 : 1);
}

export interface RunningOrderHeat extends CategorySortable {
  /** null when the heat's session could not be resolved. */
  sessionNumber?: number | null;
  /** events.event_order — position of the race within its session. */
  eventOrder?: number | null;
  heatNumber: number;
}

/**
 * The full running order of a meet: session, then race, then category, then
 * heat number. This is the order every heat list uses, so /admin/seeding,
 * /events/[volId]/heats and /referee read top to bottom as the meet is run.
 */
export function compareInRunningOrder(a: RunningOrderHeat, b: RunningOrderHeat): number {
  return (
    (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0) ||
    (a.eventOrder ?? 0) - (b.eventOrder ?? 0) ||
    compareByCategory(a, b)
  );
}
