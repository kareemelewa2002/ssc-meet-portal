import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import type { DqReason, Gender, HeatGroup, PublishStatus, ResultOutcome } from "@/lib/supabase/types";

export interface PendingReviewLane {
  heatLaneId: string;
  laneNumber: number;
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  resultOutcome: ResultOutcome | null;
  officialTimeMs: number | null;
  finishPlace: number | null;
  dqCode: DqReason | null;
}

export interface PendingReviewHeat {
  heatId: string;
  heatNumber: number;
  eventName: string;
  /** For the dashboard's session filter — null if the embed came back thin. */
  sessionNumber: number | null;
  heatGroup: HeatGroup;
  gender: Gender | null;
  /** Publish state of the heat as a whole. 'partial' means some lanes are
   * published and some are not, which should never happen but is worth
   * surfacing rather than rounding to one or the other. */
  publishState: "draft" | "partial" | "published";
  lanes: PendingReviewLane[];
  /** True once every seeded lane has a submitted (draft) outcome — the
   * signal that the referee considers this heat card complete and ready
   * for Admin to review/publish, not still mid-entry. */
  complete: boolean;
}

interface RawHeatLane {
  id: string;
  lane_number: number;
  heats:
    | { id: string; heat_number: number; heat_group: HeatGroup; gender: Gender | null; event_id: string; events: { name: string; sessions?: { session_number: number } | { session_number: number }[] | null } | { name: string; sessions?: { session_number: number } | { session_number: number }[] | null }[] | null }
    | { id: string; heat_number: number; heat_group: HeatGroup; gender: Gender | null; event_id: string; events: { name: string; sessions?: { session_number: number } | { session_number: number }[] | null } | { name: string; sessions?: { session_number: number } | { session_number: number }[] | null }[] | null }[]
    | null;
  entries:
    | {
        athletes:
          | { id: string; users: { full_name: string } | { full_name: string }[] | null; teams: { name: string } | { name: string }[] | null }
          | { id: string; users: { full_name: string } | { full_name: string }[] | null; teams: { name: string } | { name: string }[] | null }[]
          | null;
      }
    | {
        athletes:
          | { id: string; users: { full_name: string } | { full_name: string }[] | null; teams: { name: string } | { name: string }[] | null }
          | { id: string; users: { full_name: string } | { full_name: string }[] | null; teams: { name: string } | { name: string }[] | null }[]
          | null;
      }[]
    | null;
  results:
    | { result_outcome: ResultOutcome | null; official_time_ms: number | null; finish_place: number | null; dq_code: DqReason | null; status: PublishStatus }
    | { result_outcome: ResultOutcome | null; official_time_ms: number | null; finish_place: number | null; dq_code: DqReason | null; status: PublishStatus }[]
    | null;
}

/** Every heat that has at least one referee-submitted draft result and is
 * not yet fully published — the Admin's "Referee Heat Cards" review queue.
 * A heat only needs reviewing once (publishHeatResults then removes it, as
 * every lane's status flips to 'published'). */
export async function fetchPendingReviewHeats(): Promise<PendingReviewHeat[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("heat_lanes")
      .select(
        // Qualify the FK — athletes has two (user_id and parent_id), so a
        // bare "users(...)" embed is ambiguous to PostgREST (PGRST201).
        "id, lane_number, heats ( id, heat_number, heat_group, gender, event_id, events ( name, sessions ( session_number ) ) ), entries ( athletes ( id, users!athletes_user_id_fkey ( full_name ), teams ( name ) ) ), results ( result_outcome, official_time_ms, finish_place, dq_code, status )",
      )
      .order("lane_number", { ascending: true });
    if (error || !data) return [];

    const heatMap = new Map<string, PendingReviewHeat>();
    // Counted rather than folded in-place: a heat is published only when
    // EVERY scored lane is, and 'partial' (some published, some not) has to be
    // distinguishable from both rather than rounded to one of them.
    const statusCounts = new Map<string, { scored: number; published: number }>();

    for (const lane of data as unknown as RawHeatLane[]) {
      const heat = firstOf(lane.heats);
      if (!heat) continue;
      const event = firstOf(heat.events);
      const entry = firstOf(lane.entries);
      const athlete = entry ? firstOf(entry.athletes) : null;
      const user = athlete ? firstOf(athlete.users) : null;
      const team = athlete ? firstOf(athlete.teams) : null;
      const result = firstOf(lane.results);
      if (!athlete || !user) continue;

      const existing = heatMap.get(heat.id) ?? {
        heatId: heat.id,
        heatNumber: heat.heat_number,
        eventName: event?.name ?? "Event",
        sessionNumber: firstOf(event?.sessions)?.session_number ?? null,
        heatGroup: heat.heat_group,
        gender: heat.gender ?? null,
        publishState: "published",
        lanes: [],
        complete: true,
      };

      existing.lanes.push({
        heatLaneId: lane.id,
        laneNumber: lane.lane_number,
        athleteId: athlete.id,
        athleteName: user.full_name,
        teamName: team?.name ?? null,
        resultOutcome: result?.result_outcome ?? null,
        officialTimeMs: result?.official_time_ms ?? null,
        finishPlace: result?.finish_place ?? null,
        dqCode: result?.dq_code ?? null,
      });
      if (!result?.result_outcome) existing.complete = false;
      if (result?.result_outcome) {
        const counts = statusCounts.get(heat.id) ?? { scored: 0, published: 0 };
        counts.scored += 1;
        if (result.status === "published") counts.published += 1;
        statusCounts.set(heat.id, counts);
      }
      heatMap.set(heat.id, existing);
    }

    return [...heatMap.values()]
      .filter((h) => h.lanes.some((l) => l.resultOutcome != null))
      .map((h) => {
        const counts = statusCounts.get(h.heatId) ?? { scored: 0, published: 0 };
        const publishState: PendingReviewHeat["publishState"] =
          counts.published === 0
            ? "draft"
            : counts.published === counts.scored
              ? "published"
              : "partial";
        return {
          ...h,
          publishState,
          lanes: h.lanes.sort((a, b) => a.laneNumber - b.laneNumber),
        };
      })
      .sort(
        (a, b) =>
          (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0) ||
          a.eventName.localeCompare(b.eventName) ||
          a.heatNumber - b.heatNumber,
      );
  } catch {
    return [];
  }
}

/** Admin-only action: flips every lane's draft result in this heat to
 * 'published' — enforce_result_publish in supabase/schema.sql rejects this
 * from anyone but an admin, including the referee who submitted it. */
export async function publishHeatResults(heatId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { data: laneRows, error: laneError } = await supabase
    .from("heat_lanes")
    .select("id")
    .eq("heat_id", heatId);
  if (laneError) return { success: false, error: laneError.message };

  const laneIds = (laneRows ?? []).map((l) => l.id);
  if (laneIds.length === 0) return { success: false, error: "No lanes found for this heat." };

  const { error } = await supabase
    .from("results")
    .update({ status: "published" })
    .in("heat_lane_id", laneIds)
    .not("result_outcome", "is", null);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Corrects a single lane's official time from the admin review queue.
 *
 * The admin reviewing a heat card is the person who spots a mistyped time,
 * and until now their only options were publish it wrong or send the referee
 * back to the deck. finish_place and placement_points are deliberately not
 * written: public.recompute_heat_finish_places() re-ranks the whole heat from
 * official_time_ms the moment this lands, so writing them here would race the
 * trigger and could disagree with it.
 */
export async function updateLaneTime(
  heatLaneId: string,
  officialTimeMs: number,
): Promise<{ success: boolean; error?: string }> {
  if (!Number.isFinite(officialTimeMs) || officialTimeMs <= 0) {
    return { success: false, error: "A corrected time must be greater than zero." };
  }
  const supabase = createClient();
  const { error } = await supabase
    .from("results")
    .update({ official_time_ms: officialTimeMs, result_outcome: "valid" })
    .eq("heat_lane_id", heatLaneId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
