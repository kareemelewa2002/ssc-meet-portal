import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";

// ---------------------------------------------------------------------------
// Race capacity, holds and the waitlist.
//
// A race has a cap. Registering takes a slot immediately, but an unpaid entry
// only HOLDS that slot for meet_settings.hold_window_hours; after that the
// slot is released and the entry becomes 'hold_expired' — it is never deleted,
// so the athlete can still see it and reclaim it if the race has room.
//
// The numbers come from public.event_capacity(), which compares hold_expires_at
// against now() rather than reading the entry's status. The scheduled sweep is
// what materialises the expiry and fires the notification, but it runs every 15
// minutes and could fail or be paused. Deriving capacity live means a race can
// never read as full because a background job did not run.
// ---------------------------------------------------------------------------

export type EventAvailability = "available" | "selling_out_soon" | "full";

export interface EventCapacity {
  eventId: string;
  capacityCap: number;
  paidCount: number;
  heldCount: number;
  freeCount: number;
  availability: EventAvailability;
}

export const AVAILABILITY_LABELS: Record<EventAvailability, string> = {
  available: "Available",
  selling_out_soon: "Selling out soon",
  full: "Full",
};

/**
 * How the availability badge should read.
 *
 * `destructive` for full is deliberate: a swimmer scanning a list of twenty
 * races needs "you cannot have this one" to be the loudest thing on the row.
 */
export function availabilityVariant(
  availability: EventAvailability,
): "default" | "secondary" | "destructive" {
  switch (availability) {
    case "available":
      return "secondary";
    case "selling_out_soon":
      return "default";
    case "full":
      return "destructive";
  }
}

export function describeAvailability(capacity: EventCapacity): string {
  switch (capacity.availability) {
    case "full":
      return "No places left";
    case "selling_out_soon":
      return `Only ${capacity.freeCount} of ${capacity.capacityCap} places left`;
    case "available":
      return `${capacity.freeCount} of ${capacity.capacityCap} places left`;
  }
}

export type WaitlistStatus = "waiting" | "offered" | "claimed" | "expired" | "withdrawn";

export interface WaitlistEntry {
  id: string;
  eventId: string;
  athleteId: string;
  status: WaitlistStatus;
  requestedAt: string;
  offeredAt: string | null;
  offerExpiresAt: string | null;
  position: number | null;
}

/** True when this athlete is being offered a slot right now and the clock is live. */
export function hasLiveOffer(entry: WaitlistEntry, now: Date = new Date()): boolean {
  return (
    entry.status === "offered" &&
    entry.offerExpiresAt != null &&
    new Date(entry.offerExpiresAt) > now
  );
}

export function hoursUntil(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / 3_600_000);
}

// ---------------------------------------------------------------------------
// Data access.
// ---------------------------------------------------------------------------

/**
 * Capacity for a set of races, in ONE round trip.
 *
 * Calling public.event_capacity() per race would be one request per row on a
 * twenty-race registration form. public.events_capacity_bulk() takes the whole
 * list; the shapes match so the per-race function stays the single definition
 * of what the numbers mean.
 */
export async function fetchEventCapacities(
  eventIds: string[],
): Promise<FetchResult<Map<string, EventCapacity>>> {
  if (eventIds.length === 0) {
    return { data: new Map(), error: null, usedFallback: false };
  }

  const result = await runQuery<
    {
      event_id: string;
      capacity_cap: number;
      paid_count: number;
      held_count: number;
      free_count: number;
      availability: EventAvailability;
    }[]
  >(
    "Loading race capacity",
    async () => {
      const supabase = createClient();
      return supabase.rpc("events_capacity_bulk", { p_event_ids: eventIds });
    },
    { empty: [] },
  );

  const map = new Map<string, EventCapacity>();
  result.data.forEach((row) => {
    map.set(row.event_id, {
      eventId: row.event_id,
      capacityCap: row.capacity_cap,
      paidCount: row.paid_count,
      heldCount: row.held_count,
      freeCount: row.free_count,
      availability: row.availability,
    });
  });

  return { ...result, data: map };
}

export async function fetchAthleteWaitlist(
  athleteId: string,
): Promise<FetchResult<WaitlistEntry[]>> {
  const result = await runQuery<
    {
      id: string;
      event_id: string;
      athlete_id: string;
      status: WaitlistStatus;
      requested_at: string;
      offered_at: string | null;
      offer_expires_at: string | null;
    }[]
  >(
    "Loading waitlist",
    async () => {
      const supabase = createClient();
      return supabase
        .from("event_waitlist")
        .select("id, event_id, athlete_id, status, requested_at, offered_at, offer_expires_at")
        .eq("athlete_id", athleteId)
        .in("status", ["waiting", "offered"]);
    },
    { empty: [] },
  );

  return {
    ...result,
    data: result.data.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      athleteId: r.athlete_id,
      status: r.status,
      requestedAt: r.requested_at,
      offeredAt: r.offered_at,
      offerExpiresAt: r.offer_expires_at,
      position: null,
    })),
  };
}

export async function fetchWaitlistPosition(
  eventId: string,
  athleteId: string,
): Promise<number | null> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("waitlist_position", {
    p_event_id: eventId,
    p_athlete_id: athleteId,
  });
  if (error) return null;
  return typeof data === "number" ? data : null;
}

export async function joinWaitlist(
  eventId: string,
  athleteId: string,
): Promise<{ success: boolean; error?: string; position?: number }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("event_waitlist")
    .upsert(
      { event_id: eventId, athlete_id: athleteId, status: "waiting", requested_at: new Date().toISOString() },
      { onConflict: "event_id,athlete_id" },
    );
  if (error) return { success: false, error: error.message };

  const position = await fetchWaitlistPosition(eventId, athleteId);
  return { success: true, position: position ?? undefined };
}

export async function leaveWaitlist(
  eventId: string,
  athleteId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("event_waitlist")
    .update({ status: "withdrawn", resolved_at: new Date().toISOString() })
    .eq("event_id", eventId)
    .eq("athlete_id", athleteId);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Reclaim an expired hold, or claim a waitlist offer.
 *
 * Capacity is re-checked SERVER-side by public.reclaim_entry_slot() rather
 * than here. Checking in the browser and then writing would be a race: two
 * athletes reclaiming the last slot would both see room and both succeed.
 */
export async function reclaimSlot(
  entryId: string,
): Promise<{ success: boolean; error?: string; full?: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("reclaim_entry_slot", { p_entry_id: entryId });
  if (error) return { success: false, error: error.message };
  if (data === false) {
    return {
      success: false,
      full: true,
      error: "This event is now full. You can join the waitlist or select a different event.",
    };
  }
  return { success: true };
}
