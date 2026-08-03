import type { AgeGroup, Gender, HeatGroup } from "@/lib/supabase/types";

export const LANES_PER_HEAT = 6;

// Fastest (or "best") swimmer within a heat is assigned lane 4, then the
// remaining swimmers fan out from the center. Lanes 1 and 6 are left empty
// first when a heat isn't full.
export const LANE_SEQUENCE = [4, 3, 5, 2, 1, 6] as const;

export interface SeedableEntry {
  entryId: string;
  athleteId: string;
  ageGroup: AgeGroup;
  gender: Gender;
  age: number;
  seedTimeMs: number | null;
  isNt: boolean;
  /** Best World Aquatics points across the swimmer's other events. Ranks NT
   * swimmers, who have no time to rank on. null = nothing rateable on file. */
  waPoints?: number | null;
}

export interface DraftHeatLane {
  laneNumber: number;
  entryId: string;
  athleteId: string;
}

export interface DraftHeat {
  heatGroup: HeatGroup;
  gender: Gender;
  heatNumber: number;
  heatOrder: number;
  status: "draft";
  lanes: DraftHeatLane[];
}

function assignLanes(rankedChunk: SeedableEntry[]): DraftHeatLane[] {
  return rankedChunk.map((entry, index) => ({
    laneNumber: LANE_SEQUENCE[index],
    entryId: entry.entryId,
    athleteId: entry.athleteId,
  }));
}

// Splits a best-to-worst ranked list into heats of up to LANES_PER_HEAT,
// then reverses heat order so the heat built from the best-ranked swimmers
// (rank 1..6) is scheduled last — the classic "fastest heat last" format.
// Any undersized remainder heat is necessarily the worst-ranked group, so it
// naturally lands as heat 1.
function chunkRankedListIntoHeats(ranked: SeedableEntry[]): SeedableEntry[][] {
  const chunks: SeedableEntry[][] = [];
  for (let i = 0; i < ranked.length; i += LANES_PER_HEAT) {
    chunks.push(ranked.slice(i, i + LANES_PER_HEAT));
  }
  return chunks.reverse();
}

function seedBucket(
  entries: SeedableEntry[],
  heatGroup: HeatGroup,
  gender: Gender,
): Array<Omit<DraftHeat, "heatNumber" | "heatOrder">> {
  const ntEntries = entries.filter((e) => e.isNt);
  const timedEntries = entries.filter((e) => !e.isNt);

  // Rank 1 = "best" within each sub-group. Timed swimmers rank on
  // seed_time_ms. NT swimmers have no time at all, so they rank on their best
  // other event converted to World Aquatics points — age is only the last
  // resort, for a swimmer with nothing rateable on file. Must match
  // public.generate_heats_for_event()'s ORDER BY exactly.
  const ntRanked = [...ntEntries].sort((a, b) => {
    const aPoints = a.waPoints ?? null;
    const bPoints = b.waPoints ?? null;
    if (aPoints !== bPoints) {
      if (aPoints === null) return 1; // nulls last
      if (bPoints === null) return -1;
      return bPoints - aPoints;
    }
    return b.age - a.age;
  });
  const timedRanked = [...timedEntries].sort(
    (a, b) => (a.seedTimeMs ?? Infinity) - (b.seedTimeMs ?? Infinity),
  );

  const ntHeatChunks = chunkRankedListIntoHeats(ntRanked);
  const timedHeatChunks = chunkRankedListIntoHeats(timedRanked);

  // NTs swim before timed swimmers, so NT heat chunks precede timed ones.
  return [...ntHeatChunks, ...timedHeatChunks].map((chunk) => ({
    heatGroup,
    gender,
    status: "draft" as const,
    lanes: assignLanes(chunk),
  }));
}

/**
 * Produces draft heats/lanes for a single event, ready to insert into the
 * `heats` and `heat_lanes` tables.
 *
 * Rules applied (see supabase/schema.sql for the corresponding data model):
 *  1. Male and female swim separately in every age group, so there are four
 *     buckets, not two: U13-14 female, U13-14 male, U17/Open female,
 *     U17/Open male — scheduled in that order.
 *  2. NT entries swim before timed entries; NTs ranked by best World
 *     Aquatics points (then age), timed entries fastest-first by
 *     seed_time_ms.
 *  3. Lanes filled in sequence [4, 3, 5, 2, 1, 6] within each heat.
 *  4. The fastest heat of each sub-group is scheduled last.
 */
export function seedEvent(entries: SeedableEntry[]): DraftHeat[] {
  const inHeatGroup = (e: SeedableEntry, group: HeatGroup) =>
    group === "U13_14" ? e.ageGroup === "U14" : e.ageGroup === "U17" || e.ageGroup === "Open";

  // Order is significant — it is the order the heats are swum in, and it must
  // match public.generate_heats_for_event()'s bucket ordering exactly, or the
  // preview a coach sees would disagree with the sheet the referee gets.
  const buckets: [HeatGroup, Gender][] = [
    ["U13_14", "female"],
    ["U13_14", "male"],
    ["U17_OPEN", "female"],
    ["U17_OPEN", "male"],
  ];

  return buckets
    .flatMap(([group, gender]) =>
      seedBucket(
        entries.filter((e) => inHeatGroup(e, group) && e.gender === gender),
        group,
        gender,
      ),
    )
    .map((heat, index) => ({ ...heat, heatNumber: index + 1, heatOrder: index + 1 }));
}
