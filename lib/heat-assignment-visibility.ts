import type { EntryStatus } from "@/lib/supabase/types";

/**
 * What an athlete/parent may see for Heat · Lane (and projected start).
 *
 * Draft seeding must not leak: a published-or-official heat is the only
 * sheet a swimmer should warm up against. Payment must also be settled —
 * an unpaid entry is still a hold, not a lane assignment.
 *
 * `heats.status` is the publish column (`draft` | `published`). There is no
 * `heats.published` boolean. `'official'` is accepted as a synonym if it
 * ever appears, so this guard stays forward-compatible.
 */
export type HeatAssignmentVisibility =
  | { kind: "assigned" }
  | { kind: "pending_seeding" }
  | { kind: "pending_payment" }
  | { kind: "unavailable" };

export const PENDING_SEEDING_LABEL =
  "Payment confirmed — Heat & Lane assignments pending seeding";

export function isHeatSheetVisible(heatStatus: string | null | undefined): boolean {
  return heatStatus === "published" || heatStatus === "official";
}

/**
 * @param entryStatus — `entries.status`
 * @param heatPublished — true when the assigned heat's status is published/official
 * @param hasLane — true when a heat_lanes row exists for the entry (may still be draft)
 */
export function heatAssignmentVisibility(
  entryStatus: EntryStatus,
  heatPublished: boolean,
  hasLane: boolean,
): HeatAssignmentVisibility {
  if (entryStatus === "pending_payment") {
    return { kind: "pending_payment" };
  }
  if (entryStatus !== "confirmed") {
    return { kind: "unavailable" };
  }
  if (heatPublished && hasLane) {
    return { kind: "assigned" };
  }
  return { kind: "pending_seeding" };
}

/**
 * 'HH:MM:SS' (or 'HH:MM') from public.heat_projected_starts -> 'HH:MM'.
 *
 * Deliberately not Date-based: the value is a wall-clock time of day at the
 * pool, with no date and no zone. Parsing it through Date would attach the
 * VIEWER's timezone and shift a 09:00 heat for anyone reading the page from
 * another country — which parents travelling to a meet actually do.
 */
export function formatTimeOfDay(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return null;
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}
