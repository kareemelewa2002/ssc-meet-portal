import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import { compareByCategory } from "@/lib/category-order";
import { seedEvent, type DraftHeat, type SeedableEntry } from "@/lib/seeding";
import type { AgeGroup, Gender, HeatGroup } from "@/lib/supabase/types";

export type SeedingStatus = "unseeded" | "draft_heats" | "published";

export interface SessionEventSeedingInfo {
  eventId: string;
  eventName: string;
  stroke: string;
  distanceM: number;
  isSkins: boolean;
  isRelay: boolean;
  status: SeedingStatus;
  entryCount: number;
}

// ---------------------------------------------------------------------------
// Pure fetch -> transform -> seedEvent -> write-payload pipeline. Kept
// separate from any Supabase I/O so the seeding engine's *integration* with
// real entry rows (not just lib/seeding.ts's own unit tests) is independently
// testable.
// ---------------------------------------------------------------------------

export interface RawSeedableEntryRow {
  id: string;
  athlete_id: string;
  age_group_at_entry: AgeGroup | null;
  seed_time_ms: number | null;
  is_nt: boolean;
  /** Supplied by callers that can compute it; the database seeder
   * (public.generate_heats_for_event) derives it itself. */
  wa_points?: number | null;
  athletes:
    | { age: number; age_group: AgeGroup; gender: Gender }
    | { age: number; age_group: AgeGroup; gender: Gender }[]
    | null;
}

export function mapEntryRowsToSeedableEntries(rows: RawSeedableEntryRow[]): SeedableEntry[] {
  return rows
    .map((row): SeedableEntry | null => {
      const athlete = firstOf(row.athletes);
      // age_group_at_entry (frozen at registration time) is authoritative;
      // athletes.age_group is only a fallback for legacy rows predating it.
      const ageGroup = row.age_group_at_entry ?? athlete?.age_group;
      if (!ageGroup) return null;
      // Gender decides which heat an entry belongs to, so an entry without
      // one cannot be seeded at all — dropping it is correct and visible
      // (the swimmer simply won't appear), where defaulting it would quietly
      // put someone in the wrong race.
      if (!athlete?.gender) return null;
      return {
        entryId: row.id,
        athleteId: row.athlete_id,
        ageGroup,
        gender: athlete.gender,
        age: athlete?.age ?? 0,
        waPoints: row.wa_points ?? null,
        seedTimeMs: row.seed_time_ms,
        isNt: row.is_nt,
      };
    })
    .filter((e): e is SeedableEntry => e !== null);
}

export interface HeatInsertPayload {
  event_id: string;
  heat_group: HeatGroup;
  gender: Gender;
  heat_number: number;
  heat_order: number;
  status: "draft";
  lanes: { lane_number: number; entry_id: string }[];
}

export interface PreparedSeedingWrite {
  eventId: string;
  heats: HeatInsertPayload[];
}

/** The seeding engine's "trigger execution" pipeline: given raw entry rows
 * as fetched from Supabase, transform them into SeedableEntry[], run
 * lib/seeding.ts's seedEvent(), and shape the result into insert-ready
 * heats/heat_lanes payloads. Pure — no network calls. */
export function prepareEventSeeding(
  eventId: string,
  rawEntries: RawSeedableEntryRow[],
): PreparedSeedingWrite {
  const seedable = mapEntryRowsToSeedableEntries(rawEntries);
  const draftHeats: DraftHeat[] = seedEvent(seedable);
  return {
    eventId,
    heats: draftHeats.map((h) => ({
      event_id: eventId,
      heat_group: h.heatGroup,
      gender: h.gender,
      heat_number: h.heatNumber,
      heat_order: h.heatOrder,
      status: "draft",
      lanes: h.lanes.map((l) => ({ lane_number: l.laneNumber, entry_id: l.entryId })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Supabase-facing orchestration.
// ---------------------------------------------------------------------------

export async function fetchSessionSeedingOverview(sessionId: string): Promise<SessionEventSeedingInfo[]> {
  const supabase = createClient();
  const { data: events, error } = await supabase
    .from("events")
    .select("id, name, stroke, distance_m, is_skins, is_relay")
    .eq("session_id", sessionId)
    .order("event_order", { ascending: true });
  if (error || !events?.length) return [];

  const eventIds = events.map((e) => e.id);
  const [{ data: heats }, { data: entries }] = await Promise.all([
    supabase.from("heats").select("event_id, status").in("event_id", eventIds),
    supabase.from("entries").select("event_id").in("event_id", eventIds),
  ]);

  return events.map((ev) => {
    const evHeats = (heats ?? []).filter((h) => h.event_id === ev.id);
    const status: SeedingStatus =
      evHeats.length === 0
        ? "unseeded"
        : evHeats.some((h) => h.status === "published")
          ? "published"
          : "draft_heats";
    const entryCount = (entries ?? []).filter((e) => e.event_id === ev.id).length;
    return {
      eventId: ev.id,
      eventName: ev.name,
      stroke: ev.stroke,
      distanceM: ev.distance_m,
      isSkins: ev.is_skins,
      isRelay: ev.is_relay,
      status,
      entryCount,
    };
  });
}

export interface SeedEventResult {
  success: boolean;
  error?: string;
  heatsCreated?: number;
}

/** Fetches unassigned, confirmed entries for one event, runs the seeding
 * engine, and writes the resulting heats/heat_lanes as drafts. */
export async function seedEventAndWrite(eventId: string): Promise<SeedEventResult> {
  const supabase = createClient();

  const { data: existingHeats } = await supabase.from("heats").select("id").eq("event_id", eventId);
  const heatIds = (existingHeats ?? []).map((h) => h.id);

  let assignedEntryIds = new Set<string>();
  if (heatIds.length > 0) {
    const { data: lanes } = await supabase.from("heat_lanes").select("entry_id").in("heat_id", heatIds);
    assignedEntryIds = new Set((lanes ?? []).map((l) => l.entry_id).filter((id): id is string => !!id));
  }

  const { data: entryRows, error } = await supabase
    .from("entries")
    .select("id, athlete_id, age_group_at_entry, seed_time_ms, is_nt, athletes ( age, age_group, gender )")
    .eq("event_id", eventId)
    .eq("status", "confirmed");
  if (error) return { success: false, error: error.message };

  const unassigned = (entryRows ?? []).filter((e) => !assignedEntryIds.has(e.id));
  if (unassigned.length === 0) {
    return { success: false, error: "No unassigned, confirmed entries to seed for this event." };
  }

  const prepared = prepareEventSeeding(eventId, unassigned as unknown as RawSeedableEntryRow[]);
  const heatNumberOffset = heatIds.length;

  let heatsCreated = 0;
  for (const heat of prepared.heats) {
    const { data: heatRow, error: heatError } = await supabase
      .from("heats")
      .insert({
        event_id: heat.event_id,
        heat_group: heat.heat_group,
        gender: heat.gender,
        heat_number: heat.heat_number + heatNumberOffset,
        heat_order: heat.heat_order + heatNumberOffset,
        status: "draft",
      })
      .select("id")
      .single();
    if (heatError || !heatRow) {
      return { success: false, error: heatError?.message ?? "Failed to create heat." };
    }

    const laneRows = heat.lanes.map((l) => ({
      heat_id: heatRow.id,
      lane_number: l.lane_number,
      entry_id: l.entry_id,
    }));
    const { error: laneError } = await supabase.from("heat_lanes").insert(laneRows);
    if (laneError) return { success: false, error: laneError.message };
    heatsCreated += 1;
  }

  return { success: true, heatsCreated };
}

/** "Seed Entire Session" — runs seedEventAndWrite for every non-Skins,
 * non-relay event in the session. Skins slots are assigned automatically
 * from results (see enforce_no_direct_skins_entry); relay events have no
 * relay-team-of-4 entry model at all (see events.is_relay), so neither ever
 * has individual entries to seed. */
export async function seedEntireSession(
  sessionId: string,
): Promise<{ eventId: string; result: SeedEventResult }[]> {
  const overview = await fetchSessionSeedingOverview(sessionId);
  const results: { eventId: string; result: SeedEventResult }[] = [];
  for (const ev of overview.filter((e) => !e.isSkins && !e.isRelay && e.status === "unseeded")) {
    results.push({ eventId: ev.eventId, result: await seedEventAndWrite(ev.eventId) });
  }
  return results;
}

export async function publishEventHeats(eventId: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.from("heats").update({ status: "published" }).eq("event_id", eventId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export interface PreviewLane {
  heatLaneId: string;
  laneNumber: number;
  entryId: string | null;
  athleteId: string | null;
  athleteName: string;
  seedTimeMs: number | null;
  isNt: boolean;
}

export interface PreviewHeat {
  heatId: string;
  heatNumber: number;
  heatGroup: HeatGroup;
  /** null only for legacy heats seeded before male/female were split. */
  gender: Gender | null;
  status: "draft" | "published";
  lanes: PreviewLane[];
}

interface RawPreviewHeat {
  id: string;
  heat_number: number;
  heat_group: HeatGroup;
  gender: Gender | null;
  status: "draft" | "published";
  heat_lanes: Array<{
    id: string;
    lane_number: number;
    entry_id: string | null;
    entries:
      | {
          seed_time_ms: number | null;
          is_nt: boolean;
          athletes: { id: string; users: { full_name: string } | { full_name: string }[] | null } | { id: string; users: { full_name: string } | { full_name: string }[] | null }[] | null;
        }
      | {
          seed_time_ms: number | null;
          is_nt: boolean;
          athletes: { id: string; users: { full_name: string } | { full_name: string }[] | null } | { id: string; users: { full_name: string } | { full_name: string }[] | null }[] | null;
        }[]
      | null;
  }> | null;
}

export async function fetchHeatPreview(eventId: string): Promise<PreviewHeat[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("heats")
    .select(
      // Qualify the FK — athletes has two (user_id and parent_id), so a
      // bare "users(...)" embed is ambiguous to PostgREST (PGRST201) and
      // was silently emptying the entire heat sheet preview.
      "id, heat_number, heat_group, gender, status, heat_lanes ( id, lane_number, entry_id, entries ( seed_time_ms, is_nt, athletes ( id, users!athletes_user_id_fkey ( full_name ) ) ) )",
    )
    .eq("event_id", eventId)
    .order("heat_number", { ascending: true });
  if (error || !data) return [];

  // heat_number alone is not the running order — it restarts per (heat group,
  // gender), so ordering by it interleaves the boards. Sort by the category
  // running order instead, the same order /referee and the spectator heat
  // sheets use, so a printed sheet matches what is called on deck.
  return (data as unknown as RawPreviewHeat[]).map((heat) => ({
    heatId: heat.id,
    heatNumber: heat.heat_number,
    heatGroup: heat.heat_group,
    gender: heat.gender ?? null,
    status: heat.status,
    lanes: (heat.heat_lanes ?? [])
      .map((lane) => {
        const entry = firstOf(lane.entries);
        const athlete = entry ? firstOf(entry.athletes) : null;
        const user = athlete ? firstOf(athlete.users) : null;
        return {
          heatLaneId: lane.id,
          laneNumber: lane.lane_number,
          entryId: lane.entry_id,
          athleteId: athlete?.id ?? null,
          athleteName: user?.full_name ?? "—",
          seedTimeMs: entry?.seed_time_ms ?? null,
          isNt: entry?.is_nt ?? false,
        };
      })
      .sort((a, b) => a.laneNumber - b.laneNumber),
  })).sort(compareByCategory);
}

/** Swaps which entry occupies two lanes (within the same or different heats)
 * — the "reassign lanes if needed" step of the preview workflow. */
export async function swapHeatLanes(
  laneAId: string,
  laneBId: string,
  laneAEntryId: string | null,
  laneBEntryId: string | null,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();

  // heat_lanes has a unique(heat_id, entry_id) constraint. Swapping via two
  // independent parallel updates can transiently give both lanes the same
  // entry_id when they share a heat, violating it. Clearing lane A first
  // guarantees no instant where two rows in the same heat hold one entry.
  const { error: clearError } = await supabase
    .from("heat_lanes")
    .update({ entry_id: null })
    .eq("id", laneAId);
  if (clearError) return { success: false, error: clearError.message };

  const { error: errB } = await supabase
    .from("heat_lanes")
    .update({ entry_id: laneAEntryId })
    .eq("id", laneBId);
  if (errB) return { success: false, error: errB.message };

  const { error: errA } = await supabase
    .from("heat_lanes")
    .update({ entry_id: laneBEntryId })
    .eq("id", laneAId);
  if (errA) return { success: false, error: errA.message };

  return { success: true };
}
