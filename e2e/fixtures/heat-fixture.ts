import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { CREDENTIALS, SEED_PASSWORD } from "../helpers";

/**
 * A scratch heat that a test owns outright.
 *
 * These specs run against a SHARED database, so anything that reaches for
 * "the first heat in the deck" is really asserting on whatever the last run
 * happened to leave behind — a card another test already submitted or
 * published renders a different set of buttons, and the test fails for
 * reasons that have nothing to do with the code under test.
 *
 * Each test therefore builds the heat it needs, works only on that heat, and
 * deletes it afterwards. Referees own heats and heat_lanes end to end
 * (admins_referees_full_access_heats), so no elevated key is needed.
 */
export interface HeatFixture {
  heatId: string;
  heatNumber: number;
  laneIds: string[];
  eventName: string;
  cleanup: () => Promise<void>;
}

function client(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY must be set (playwright.config.ts loads .env.local).",
    );
  }
  return createClient(url, key);
}

/**
 * Creates a heat with `laneCount` lanes on a real timed event.
 *
 * Returns null when the database has no usable event/entries, so the caller
 * can skip with an actionable message rather than fail obscurely.
 */
export async function createRefereeHeatFixture(laneCount = 2): Promise<HeatFixture | null> {
  const supabase = client();
  const { error: authError } = await supabase.auth.signInWithPassword({
    email: CREDENTIALS.referee1,
    password: SEED_PASSWORD,
  });
  if (authError) return null;

  // A timed individual event — Skins is placed by eye and relays are scored
  // as a squad, so neither exercises the time-entry card.
  const { data: event } = await supabase
    .from("events")
    .select("id, name")
    .eq("is_skins", false)
    .eq("is_relay", false)
    .order("id")
    .limit(1)
    .maybeSingle();
  if (!event) return null;

  const { data: entries } = await supabase
    .from("entries")
    .select("id")
    .eq("event_id", event.id)
    .order("id")
    .limit(laneCount);
  if (!entries || entries.length < laneCount) return null;

  // High, random heat number: unique within the event's bucket and obviously
  // not part of the real programme if a cleanup is ever missed.
  const heatNumber = 800 + Math.floor(Math.random() * 199);
  const { data: heat, error: heatError } = await supabase
    .from("heats")
    .insert({
      event_id: event.id,
      heat_group: "U17_OPEN",
      gender: "male",
      heat_number: heatNumber,
      heat_order: heatNumber,
      status: "published",
    })
    .select("id")
    .single();
  if (heatError || !heat) return null;

  const { data: lanes, error: laneError } = await supabase
    .from("heat_lanes")
    .insert(
      entries.map((entry, i) => ({
        heat_id: heat.id,
        lane_number: i + 1,
        entry_id: entry.id,
      })),
    )
    .select("id");
  if (laneError || !lanes) {
    await supabase.from("heats").delete().eq("id", heat.id);
    return null;
  }

  return {
    heatId: heat.id,
    heatNumber,
    laneIds: lanes.map((l) => l.id),
    eventName: event.name,
    // heat_lanes and results cascade from heats, so one delete is enough.
    cleanup: async () => {
      await supabase.from("heats").delete().eq("id", heat.id);
    },
  };
}
