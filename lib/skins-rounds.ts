import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import { ok, runQuery, type FetchResult } from "@/lib/fetch-policy";
import { scoreHeatResult } from "@/lib/results";
import { roundLabel, type SkinsRound } from "@/lib/skins-lanes";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import type { AgeGroup, DqReason, Gender, PublishStatus, ResultOutcome } from "@/lib/supabase/types";

/**
 * Reading and writing one ROUND of a Skins board.
 *
 * Skins is scored by the referee and approved by an admin, exactly like every
 * other heat card — the difference is that a bracket has three rounds plus
 * any swim-offs, and each of those is published on its own. Each is its own
 * heat (see materialise_skins_heat), which is what makes "published once, and
 * says so if you try again" answerable per round rather than per event.
 */

/** Publish state of a round as a whole. `partial` should never happen; it is
 * surfaced rather than rounded so a half-published round is visible. */
export type RoundPublishState = "unscored" | "draft" | "partial" | "published";

export interface SkinsRoundLane {
  heatLaneId: string;
  laneNumber: number;
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  outcome: ResultOutcome | null;
  finishPlace: number | null;
  dqCode: DqReason | null;
  status: PublishStatus | null;
}

export interface SkinsRoundView {
  heatId: string;
  /** Event/session context, so a round can be listed in running order
   * alongside every other heat instead of in a tab of its own. */
  eventId: string;
  eventName: string;
  eventOrder: number;
  sessionNumber: number | null;
  category: AgeGroup;
  gender: Gender;
  round: SkinsRound;
  swimOff: boolean;
  publishState: RoundPublishState;
  /** Every lane has a recorded outcome — the referee considers it complete. */
  complete: boolean;
  lanes: SkinsRoundLane[];
}

export function skinsRoundTitle(view: {
  category: AgeGroup;
  gender: Gender;
  round: SkinsRound;
  swimOff: boolean;
}): string {
  const who = `${AGE_GROUP_LABELS[view.category]} ${view.gender === "male" ? "Men" : "Women"}`;
  return view.swimOff
    ? `${who} — ${roundLabel(view.round)} swim-off`
    : `${who} — ${roundLabel(view.round)}`;
}

interface RawSkinsEvent {
  name: string;
  event_order: number;
  sessions: { session_number: number } | { session_number: number }[] | null;
}

interface RawSkinsLane {
  id: string;
  lane_number: number;
  heats:
    | {
        id: string;
        skins_category: AgeGroup | null;
        skins_round: number | null;
        skins_swim_off: boolean;
        gender: Gender | null;
        event_id: string;
        events: RawSkinsEvent | RawSkinsEvent[] | null;
      }
    | {
        id: string;
        skins_category: AgeGroup | null;
        skins_round: number | null;
        skins_swim_off: boolean;
        gender: Gender | null;
        event_id: string;
        events: RawSkinsEvent | RawSkinsEvent[] | null;
      }[]
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
    | { result_outcome: ResultOutcome | null; finish_place: number | null; dq_code: DqReason | null; status: PublishStatus }
    | { result_outcome: ResultOutcome | null; finish_place: number | null; dq_code: DqReason | null; status: PublishStatus }[]
    | null;
}

/**
 * Every materialised Skins round for an event, with its lanes and state.
 *
 * Drives both the referee's bracket (which round am I on, has this one gone
 * to the admin yet) and the admin's approval queue (what is waiting for me).
 */
export async function fetchSkinsRounds(eventId: string): Promise<FetchResult<SkinsRoundView[]>> {
  const raw = await runQuery<RawSkinsLane[]>(
    "Loading the Skins rounds",
    async () => {
      const supabase = createClient();
      // `heats!inner` so the filters below narrow the LANES rather than just
      // nulling the embed — without it every lane in the meet comes back with
      // heats: null. The cast is needed because the generated types cannot
      // resolve an embed carrying an !inner hint.
      const query = supabase
        .from("heat_lanes")
        .select(
          // athletes has two FKs to users, so the embed must name the one it means.
          "id, lane_number, heats!inner ( id, skins_category, skins_round, skins_swim_off, gender, event_id, events ( name, event_order, sessions ( session_number ) ) ), entries ( athletes ( id, users!athletes_user_id_fkey ( full_name ), teams ( name ) ) ), results ( result_outcome, finish_place, dq_code, status )",
        )
        .eq("heats.event_id", eventId)
        .not("heats.skins_round", "is", null)
        .order("lane_number", { ascending: true });
      return query as unknown as Promise<{ data: RawSkinsLane[] | null; error: { message: string } | null }>;
    },
    { empty: [] },
  );

  if (raw.error) return { ...raw, data: [] };

  const byHeat = new Map<string, SkinsRoundView>();
  const counts = new Map<string, { scored: number; published: number }>();

  for (const lane of raw.data) {
    const heat = firstOf(lane.heats);
    if (!heat || heat.skins_round == null || !heat.skins_category || !heat.gender) continue;
    const athlete = firstOf(firstOf(lane.entries)?.athletes);
    const user = athlete ? firstOf(athlete.users) : null;
    if (!athlete || !user) continue;
    const result = firstOf(lane.results);

    const event = firstOf(heat.events);
    const view = byHeat.get(heat.id) ?? {
      heatId: heat.id,
      eventId: heat.event_id,
      eventName: event?.name ?? "Skins",
      eventOrder: event?.event_order ?? 0,
      sessionNumber: firstOf(event?.sessions)?.session_number ?? null,
      category: heat.skins_category,
      gender: heat.gender,
      round: heat.skins_round as SkinsRound,
      swimOff: heat.skins_swim_off,
      publishState: "unscored" as RoundPublishState,
      complete: true,
      lanes: [],
    };

    view.lanes.push({
      heatLaneId: lane.id,
      laneNumber: lane.lane_number,
      athleteId: athlete.id,
      athleteName: user.full_name,
      teamName: firstOf(athlete.teams)?.name ?? null,
      outcome: result?.result_outcome ?? null,
      finishPlace: result?.finish_place ?? null,
      dqCode: result?.dq_code ?? null,
      status: result?.status ?? null,
    });
    if (!result?.result_outcome) view.complete = false;
    if (result?.result_outcome) {
      const c = counts.get(heat.id) ?? { scored: 0, published: 0 };
      c.scored += 1;
      if (result.status === "published") c.published += 1;
      counts.set(heat.id, c);
    }
    byHeat.set(heat.id, view);
  }

  const rounds = [...byHeat.values()].map((view) => {
    const c = counts.get(view.heatId) ?? { scored: 0, published: 0 };
    const publishState: RoundPublishState =
      c.scored === 0
        ? "unscored"
        : c.published === 0
          ? "draft"
          : c.published === c.scored
            ? "published"
            : "partial";
    return { ...view, publishState, lanes: view.lanes.sort((a, b) => a.laneNumber - b.laneNumber) };
  });

  // Boards together, and within a board the order they are actually swum.
  rounds.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.gender.localeCompare(b.gender) ||
      b.round - a.round ||
      Number(a.swimOff) - Number(b.swimOff),
  );

  return ok(rounds);
}

export interface SkinsLaneEntry {
  heatLaneId: string;
  outcome: ResultOutcome;
  finishPlace: number | null;
  dqCode: DqReason | null;
}

/**
 * Referee submits a round for approval.
 *
 * Written as `draft`, never `published` — an admin approves it, and the
 * database enforces that (enforce_result_publish rejects a publish from
 * anyone but an admin, including the referee who recorded it).
 *
 * Skins is placed by eye and has no times at all, so finish_place IS the
 * result here. recompute_heat_finish_places deliberately skips Skins heats
 * for that reason; ranking them by a null official_time_ms would hand every
 * swimmer first place.
 */
export async function submitSkinsRound(
  lanes: SkinsLaneEntry[],
  fieldSize: number,
): Promise<{ success: boolean; error?: string }> {
  if (lanes.length === 0) return { success: false, error: "Nothing to submit." };

  const rows = lanes.map((lane) => {
    const scored = scoreHeatResult(
      { outcome: lane.outcome, finishPlace: lane.finishPlace, maxPlacementPoints: fieldSize },
      lane.dqCode,
    );
    return {
      heat_lane_id: lane.heatLaneId,
      result_outcome: scored.resultOutcome,
      dq_code: scored.dqCode,
      official_time_ms: scored.officialTimeMs,
      finish_place: scored.finishPlace,
      placement_points: scored.placementPoints,
      improvement_points: scored.improvementPoints,
      status: "draft" as const,
    };
  });

  const supabase = createClient();
  const { error } = await supabase.from("results").upsert(rows, { onConflict: "heat_lane_id" });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Admin approves a round: every scored lane in it flips to published. */
export async function publishSkinsRound(heatId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { data: laneRows, error: laneError } = await supabase
    .from("heat_lanes")
    .select("id")
    .eq("heat_id", heatId);
  if (laneError) return { success: false, error: laneError.message };

  const laneIds = (laneRows ?? []).map((l) => l.id);
  if (laneIds.length === 0) return { success: false, error: "No lanes found for this round." };

  const { error } = await supabase
    .from("results")
    .update({ status: "published" })
    .in("heat_lane_id", laneIds)
    .not("result_outcome", "is", null);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Admin reopens a published round so a mistake can be corrected.
 *
 * Deliberately explicit rather than letting a re-publish overwrite silently:
 * the round drops back to draft, the referee re-enters it, and it goes
 * through approval again. Nothing about a published round changes by
 * accident.
 */
export async function reopenSkinsRound(heatId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { data: laneRows, error: laneError } = await supabase
    .from("heat_lanes")
    .select("id")
    .eq("heat_id", heatId);
  if (laneError) return { success: false, error: laneError.message };

  const laneIds = (laneRows ?? []).map((l) => l.id);
  if (laneIds.length === 0) return { success: false, error: "No lanes found for this round." };

  const { error } = await supabase
    .from("results")
    .update({ status: "draft" })
    .in("heat_lane_id", laneIds);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
