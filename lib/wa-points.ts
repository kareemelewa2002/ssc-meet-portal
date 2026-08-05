import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import type { Gender } from "@/lib/supabase/types";

/**
 * World Aquatics points, client side.
 *
 * The computation already lives in the database as
 * public.world_aquatics_points(), and views that can reach it (event_results,
 * performance_points) carry a wa_points column. This module exists for the
 * tables that CANNOT: an athlete's career ledger and the all-time boards are
 * assembled from rows that were never joined to wa_base_times, and per-row
 * RPC calls would be one round trip per line of the table.
 *
 * wa_base_times is twelve public rows. Fetch it once, score in the browser
 * with the identical formula, and the two agree by construction.
 *
 * UNRATEABLE IS NOT ZERO. Relays, Skins and the 50m switch events have no
 * base time on file, on purpose — they have no points system. Those score
 * null here and must render as an em dash. A 0 would read as a real score of
 * nought, which is a different and untrue claim about the swim.
 */

/** P = 1000 * (base / swum)^3, floored — mirrors public.world_aquatics_points. */
export function computeWaPoints(
  baseTimeMs: number | null | undefined,
  swumTimeMs: number | null | undefined,
): number | null {
  if (baseTimeMs == null || swumTimeMs == null) return null;
  if (baseTimeMs <= 0 || swumTimeMs <= 0) return null;
  return Math.floor(1000 * Math.pow(baseTimeMs / swumTimeMs, 3));
}

/** Base times keyed by `${stroke}|${distanceM}|${gender}`. */
export type WaBaseTimes = Map<string, number>;

export function waBaseTimeKey(stroke: string, distanceM: number, gender: Gender): string {
  return `${stroke}|${distanceM}|${gender}`;
}

/** Points for one swim, or null when the event is deliberately unrateable. */
export function waPointsFor(
  baseTimes: WaBaseTimes,
  swim: {
    stroke: string;
    distanceM: number;
    gender: Gender;
    officialTimeMs: number | null | undefined;
  },
): number | null {
  const base = baseTimes.get(waBaseTimeKey(swim.stroke, swim.distanceM, swim.gender));
  return computeWaPoints(base, swim.officialTimeMs);
}

/** What a points cell shows. The em dash is the honest reading of "no base
 * time on file", and is deliberately never "0". */
export function formatWaPoints(points: number | null | undefined): string {
  return points == null ? "—" : String(points);
}

interface WaBaseTimeRow {
  stroke: string;
  distance_m: number;
  gender: Gender;
  base_time_ms: number;
}

export async function fetchWaBaseTimes(): Promise<FetchResult<WaBaseTimes>> {
  const result = await runQuery<WaBaseTimeRow[]>(
    "Loading World Aquatics base times",
    async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("wa_base_times")
        .select("stroke, distance_m, gender, base_time_ms");
      return { data: data as unknown as WaBaseTimeRow[] | null, error };
    },
    { empty: [] },
  );

  const map: WaBaseTimes = new Map();
  for (const row of result.data) {
    map.set(waBaseTimeKey(row.stroke, row.distance_m, row.gender), row.base_time_ms);
  }
  return { ...result, data: map };
}
