import type { AgeGroup, HeatGroup } from "@/lib/supabase/types";

export const LANES_PER_HEAT = 6;

// Fastest (or "best") swimmer within a heat is assigned lane 4, then the
// remaining swimmers fan out from the center. Lanes 1 and 6 are left empty
// first when a heat isn't full.
export const LANE_SEQUENCE = [4, 3, 5, 2, 1, 6] as const;

export interface SeedableEntry {
  entryId: string;
  athleteId: string;
  ageGroup: AgeGroup;
  age: number;
  seedTimeMs: number | null;
  isNt: boolean;
}

export interface DraftHeatLane {
  laneNumber: number;
  entryId: string;
  athleteId: string;
}

export interface DraftHeat {
  heatGroup: HeatGroup;
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
): Array<Omit<DraftHeat, "heatNumber" | "heatOrder">> {
  const ntEntries = entries.filter((e) => e.isNt);
  const timedEntries = entries.filter((e) => !e.isNt);

  // Rank 1 = "best" within each sub-group: oldest among NT swimmers (used as
  // a proxy for speed when no official time exists), fastest among timed
  // swimmers by seed_time_ms.
  const ntRanked = [...ntEntries].sort((a, b) => b.age - a.age);
  const timedRanked = [...timedEntries].sort(
    (a, b) => (a.seedTimeMs ?? Infinity) - (b.seedTimeMs ?? Infinity),
  );

  const ntHeatChunks = chunkRankedListIntoHeats(ntRanked);
  const timedHeatChunks = chunkRankedListIntoHeats(timedRanked);

  // NTs swim before timed swimmers, so NT heat chunks precede timed ones.
  return [...ntHeatChunks, ...timedHeatChunks].map((chunk) => ({
    heatGroup,
    status: "draft" as const,
    lanes: assignLanes(chunk),
  }));
}

/**
 * Produces draft heats/lanes for a single event, ready to insert into the
 * `heats` and `heat_lanes` tables.
 *
 * Rules applied (see supabase/schema.sql for the corresponding data model):
 *  1. U13-14 swims first; U17 and Open swim together afterward.
 *  2. NT entries swim before timed entries; NTs ranked oldest-first, timed
 *     entries ranked fastest-first by seed_time_ms.
 *  3. Lanes filled in sequence [4, 3, 5, 2, 1, 6] within each heat.
 *  4. The fastest heat of each sub-group is scheduled last.
 */
export function seedEvent(entries: SeedableEntry[]): DraftHeat[] {
  const u1314Entries = entries.filter((e) => e.ageGroup === "U14");
  const combinedEntries = entries.filter(
    (e) => e.ageGroup === "U17" || e.ageGroup === "Open",
  );

  const u1314Heats = seedBucket(u1314Entries, "U13_14");
  const combinedHeats = seedBucket(combinedEntries, "U17_OPEN");

  return [...u1314Heats, ...combinedHeats].map((heat, index) => ({
    ...heat,
    heatNumber: index + 1,
    heatOrder: index + 1,
  }));
}
