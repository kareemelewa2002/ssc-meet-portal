import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import type { DqReason, PublishStatus, ResultOutcome } from "@/lib/supabase/types";

export interface PendingReviewLane {
  heatLaneId: string;
  laneNumber: number;
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
    | { id: string; heat_number: number; event_id: string; events: { name: string } | { name: string }[] | null }
    | { id: string; heat_number: number; event_id: string; events: { name: string } | { name: string }[] | null }[]
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
        "id, lane_number, heats ( id, heat_number, event_id, events ( name ) ), entries ( athletes ( id, users!athletes_user_id_fkey ( full_name ), teams ( name ) ) ), results ( result_outcome, official_time_ms, finish_place, dq_code, status )",
      )
      .order("lane_number", { ascending: true });
    if (error || !data) return [];

    const heatMap = new Map<string, PendingReviewHeat>();

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
        lanes: [],
        complete: true,
      };

      existing.lanes.push({
        heatLaneId: lane.id,
        laneNumber: lane.lane_number,
        athleteName: user.full_name,
        teamName: team?.name ?? null,
        resultOutcome: result?.result_outcome ?? null,
        officialTimeMs: result?.official_time_ms ?? null,
        finishPlace: result?.finish_place ?? null,
        dqCode: result?.dq_code ?? null,
      });
      if (!result?.result_outcome) existing.complete = false;
      heatMap.set(heat.id, existing);
    }

    return [...heatMap.values()]
      .filter((h) => h.lanes.some((l) => l.resultOutcome != null))
      .map((h) => ({ ...h, lanes: h.lanes.sort((a, b) => a.laneNumber - b.laneNumber) }))
      .sort((a, b) => a.heatNumber - b.heatNumber);
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
