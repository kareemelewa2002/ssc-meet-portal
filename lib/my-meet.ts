import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { isHeatSheetVisible } from "@/lib/heat-assignment-visibility";
import { firstOf } from "@/lib/live-heats";
import type { EntryStatus, Gender, HeatGroup } from "@/lib/supabase/types";

/**
 * "What am I swimming, and where do I stand on the blocks?" — the one thing
 * an entered swimmer could not see anywhere in the app.
 *
 * The data always existed: entries drives the registration form's
 * already-entered greying-out, and heat_lanes is read in full by the referee
 * deck. Neither was ever surfaced back to the swimmer, so a registered
 * athlete had no way to check which races they were in, let alone their heat
 * and lane, without reading the public heat sheet and hunting for their name.
 *
 * READ-ONLY BY CONSTRUCTION. There is no write path here and none is
 * implied: entering a race stays on /events/[volId]/register, and payment is
 * still collected and confirmed at the desk by an admin.
 */

export interface MyHeatAssignment {
  heatId: string;
  heatNumber: number;
  laneNumber: number;
  heatGroup: HeatGroup;
  gender: Gender | null;
  /** Heats are only visible once the sheet is published — an unpublished
   * seeding is a draft the swimmer must not plan their warm-up around. */
  published: boolean;
}

export interface MyMeetEntry {
  entryId: string;
  eventId: string;
  eventName: string;
  stroke: string;
  distanceM: number;
  sessionNumber: number | null;
  status: EntryStatus;
  seedTimeMs: number | null;
  isNt: boolean;
  /** Null until an admin confirms payment (which is what seeds heats) and
   * the sheet is published. */
  heat: MyHeatAssignment | null;
}

type RawRow = {
  id: string;
  event_id: string;
  status: EntryStatus;
  seed_time_ms: number | null;
  is_nt: boolean;
  events:
    | { name: string; stroke: string; distance_m: number; sessions: unknown }
    | { name: string; stroke: string; distance_m: number; sessions: unknown }[]
    | null;
  heat_lanes: {
    lane_number: number;
    heats:
      | { id: string; heat_number: number; heat_group: HeatGroup; gender: Gender | null; status: string }
      | { id: string; heat_number: number; heat_group: HeatGroup; gender: Gender | null; status: string }[]
      | null;
  }[] | null;
};

/**
 * Every race this athlete is entered in for the given volume, with their heat
 * and lane where one has been seeded.
 *
 * One round trip, not one per race: a swimmer with four entries would
 * otherwise cost four heat lookups, and this renders on three dashboards.
 *
 * Volume scoping is done in JS rather than as an embedded filter on
 * events.sessions.meet_volume_id — the hand-maintained Database type in
 * lib/supabase/types.ts carries no FK relationship metadata, and a filter on
 * an embedded table silently nulls the WHOLE embed on every row rather than
 * filtering it (confirmed against this project's PostgREST endpoint; see
 * lib/team-invites.ts's searchUnattachedAthletes for the same trap).
 */
export async function fetchMyMeetEntries(
  athleteId: string,
  meetVolumeId: string,
): Promise<FetchResult<MyMeetEntry[]>> {
  const supabase = createClient();
  return runQuery<MyMeetEntry[]>(
    "Loading your races",
    async () => {
      const { data, error } = await supabase
        .from("entries")
        .select(
          "id, event_id, status, seed_time_ms, is_nt, " +
            "events ( name, stroke, distance_m, event_order, sessions ( session_number, meet_volume_id ) ), " +
            "heat_lanes ( lane_number, heats ( id, heat_number, heat_group, gender, status ) )",
        )
        .eq("athlete_id", athleteId);
      if (error) return { data: null, error };

      const rows = (data as unknown as RawRow[]) ?? [];
      const mapped: MyMeetEntry[] = [];
      for (const row of rows) {
        const event = firstOf(row.events);
        if (!event) continue;
        const session = firstOf(
          event.sessions as { session_number: number; meet_volume_id: string } | null,
        );
        if (session?.meet_volume_id !== meetVolumeId) continue;

        const lane = (row.heat_lanes ?? [])[0];
        const heatRow = lane ? firstOf(lane.heats) : null;

        mapped.push({
          entryId: row.id,
          eventId: row.event_id,
          eventName: event.name,
          stroke: event.stroke,
          distanceM: event.distance_m,
          sessionNumber: session?.session_number ?? null,
          status: row.status,
          seedTimeMs: row.seed_time_ms,
          isNt: row.is_nt,
          heat:
            lane && heatRow
              ? {
                  heatId: heatRow.id,
                  heatNumber: heatRow.heat_number,
                  laneNumber: lane.lane_number,
                  heatGroup: heatRow.heat_group,
                  gender: heatRow.gender,
                  published: isHeatSheetVisible(heatRow.status),
                }
              : null,
        });
      }

      mapped.sort(
        (a, b) =>
          (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0) ||
          a.eventName.localeCompare(b.eventName),
      );
      return { data: mapped, error: null };
    },
    { empty: [] },
  );
}
