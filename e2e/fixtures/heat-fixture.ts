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

/** Signs in and returns a client for the given seeded account. */
async function as(email: string): Promise<SupabaseClient | null> {
  const supabase = client();
  const { error } = await supabase.auth.signInWithPassword({ email, password: SEED_PASSWORD });
  return error ? null : supabase;
}

export interface Fixture {
  cleanup: () => Promise<void>;
}

/**
 * A team awaiting admin approval.
 *
 * Restored rather than assumed: the seeded "Sunburst Aquatics" is approved by
 * the very test that looks for it, so from the second run onward the fixture
 * no longer exists and the spec skipped.
 */
export async function createPendingTeamFixture(
  name = "Sunburst Aquatics",
): Promise<(Fixture & { name: string }) | null> {
  const supabase = await as(CREDENTIALS.admin);
  if (!supabase) return null;

  // Idempotent: reuse the seeded row if it is still there, just un-approved.
  const { data: existing } = await supabase
    .from("teams")
    .select("id")
    .eq("name", name)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("teams")
      .update({ approved_by_admin: false })
      .eq("id", existing.id);
    if (error) return null;
    // Left as it was found: an approved team is the normal resting state.
    return {
      name,
      cleanup: async () => {
        await supabase.from("teams").update({ approved_by_admin: true }).eq("id", existing.id);
      },
    };
  }

  const { data: created, error } = await supabase
    .from("teams")
    .insert({ name, abbreviation: "SBA", approved_by_admin: false })
    .select("id")
    .single();
  if (error || !created) return null;
  return {
    name,
    cleanup: async () => {
      await supabase.from("teams").delete().eq("id", created.id);
    },
  };
}

/**
 * A complete heat card sitting in the admin review queue.
 *
 * Every lane carries a draft result, which is what makes the card read
 * "Draft Heat Card — Ready" and offer Publish. Built by the referee, exactly
 * as one arrives on the deck.
 */
export async function createSubmittedHeatCardFixture(): Promise<
  (Fixture & { heatNumber: number; heatId: string }) | null
> {
  const heat = await createRefereeHeatFixture(2);
  if (!heat) return null;

  const supabase = await as(CREDENTIALS.referee1);
  if (!supabase) {
    await heat.cleanup();
    return null;
  }

  const { error } = await supabase.from("results").upsert(
    heat.laneIds.map((laneId, i) => ({
      heat_lane_id: laneId,
      result_outcome: "valid" as const,
      official_time_ms: 30000 + i * 500,
      status: "draft" as const,
    })),
    { onConflict: "heat_lane_id" },
  );
  if (error) {
    await heat.cleanup();
    return null;
  }

  return { heatId: heat.heatId, heatNumber: heat.heatNumber, cleanup: heat.cleanup };
}

/**
 * An entry awaiting cash confirmation on the desk.
 *
 * The seeded one is confirmed by the test that finds it, so it has to be put
 * back rather than relied upon.
 */
export async function createPendingPaymentFixture(): Promise<Fixture | null> {
  const supabase = await as(CREDENTIALS.admin);
  if (!supabase) return null;

  const { data: entry } = await supabase
    .from("entries")
    .select("id, status, events!inner ( is_skins, is_relay )")
    .eq("events.is_skins", false)
    .eq("events.is_relay", false)
    .order("id")
    .limit(1)
    .maybeSingle();
  if (!entry) return null;

  const previous = (entry as { status: "pending_payment" | "confirmed" }).status;
  const { error } = await supabase
    .from("entries")
    .update({ status: "pending_payment" })
    .eq("id", entry.id);
  if (error) return null;

  return {
    cleanup: async () => {
      await supabase.from("entries").update({ status: previous }).eq("id", entry.id);
    },
  };
}

/**
 * Frees registration capacity for an athlete, then cleans up after the test.
 *
 * The registration specs create an entry every run and never removed it, so
 * the athlete drifted into the 4-event cap and the specs skipped from then on.
 * Two things fix that: reclaim the entries earlier runs abandoned, and delete
 * whatever this run adds.
 *
 * Safe by construction: an entry is reclaimed only when NOTHING has been
 * recorded against it — no lane at all, or lanes that carry no result. A
 * single result, draft or published, and the entry is left alone, because
 * deleting it would cascade that result away. The fixture frees less rather
 * than destroying a swim.
 */
export async function freeRegistrationSlots(email: string): Promise<Fixture | null> {
  const supabase = await as(email);
  if (!supabase) return null;

  const { data: user } = await supabase.auth.getUser();
  if (!user?.user) return null;
  const { data: athletes } = await supabase
    .from("athletes")
    .select("id")
    .eq("user_id", user.user.id);
  const athleteId = athletes?.[0]?.id;
  if (!athleteId) return null;

  const { data: entries } = await supabase
    .from("entries")
    .select("id, events!inner ( is_skins, is_relay ), heat_lanes ( id, results ( id ) )")
    .eq("athlete_id", athleteId)
    .eq("events.is_skins", false)
    .eq("events.is_relay", false);

  type LaneWithResults = { id: string; results?: unknown[] };
  const abandoned = (entries ?? [])
    .filter((e) => {
      const lanes = ((e as { heat_lanes?: LaneWithResults[] }).heat_lanes ?? []);
      return lanes.every((lane) => (lane.results ?? []).length === 0);
    })
    .map((e) => (e as { id: string }).id);
  if (abandoned.length > 0) {
    await supabase.from("entries").delete().in("id", abandoned);
  }

  const { data: remaining } = await supabase
    .from("entries")
    .select("id")
    .eq("athlete_id", athleteId);
  const before = new Set((remaining ?? []).map((e) => e.id));

  return {
    cleanup: async () => {
      const { data: after } = await supabase
        .from("entries")
        .select("id, heat_lanes ( id )")
        .eq("athlete_id", athleteId);
      // Only what this run added, and only if it never reached a heat.
      const added = (after ?? [])
        .filter((e) => !before.has(e.id))
        .filter((e) => ((e as { heat_lanes?: unknown[] }).heat_lanes ?? []).length === 0)
        .map((e) => e.id);
      if (added.length > 0) await supabase.from("entries").delete().in("id", added);
    },
  };
}

/**
 * Clears both legal gates on a U14 swimmer: the safety acknowledgement AND
 * parent/guardian linkage.
 *
 * canSubmitEntries() (lib/register.ts) blocks entry on either one, and this
 * fixture used to restore only the first. A U14 picked by
 * findAthleteWithCapacity() whose parent_link_status was still 'pending'
 * therefore reached the registration form, priced the 2-race package
 * correctly, and then sat on a permanently disabled Submit button — the
 * failure read as a pricing bug when the price on screen was right all along.
 *
 * Both values are restored afterwards, so the "outstanding acknowledgement"
 * and "awaiting parent authorization" paths stay testable elsewhere.
 */
export async function acceptSafetyFixture(email: string): Promise<Fixture | null> {
  const admin = await as(CREDENTIALS.admin);
  const athlete = await as(email);
  if (!admin || !athlete) return null;

  const { data: user } = await athlete.auth.getUser();
  if (!user?.user) return null;
  const { data: rows } = await admin
    .from("athletes")
    .select("id, safety_accepted_at, safety_accepted_by, parent_link_status")
    .eq("user_id", user.user.id);
  const row = rows?.[0];
  if (!row) return null;

  const previous = {
    safety_accepted_at: row.safety_accepted_at as string | null,
    safety_accepted_by: row.safety_accepted_by as string | null,
    parent_link_status: row.parent_link_status as "none" | "pending" | "verified",
  };
  // 'pending' is the only blocking value — 'none' (no parent required) and
  // 'verified' both pass, so neither needs touching.
  const needsParent = previous.parent_link_status === "pending";
  if (previous.safety_accepted_at && !needsParent) return { cleanup: async () => {} };

  const { data: adminUser } = await admin.auth.getUser();
  const { error } = await admin
    .from("athletes")
    .update({
      safety_accepted_at: previous.safety_accepted_at ?? new Date().toISOString(),
      safety_accepted_by: previous.safety_accepted_by ?? adminUser?.user?.id ?? null,
      ...(needsParent ? { parent_link_status: "verified" as const } : {}),
    })
    .eq("id", row.id);
  if (error) return null;

  return {
    cleanup: async () => {
      await admin.from("athletes").update(previous).eq("id", row.id);
    },
  };
}

/** An athlete who already has a published career result, for the profile
 * ledger specs — "the first card in the directory" may have none. */
export async function findAthleteWithPublishedResult(): Promise<string | null> {
  const supabase = await as(CREDENTIALS.admin);
  if (!supabase) return null;
  const { data } = await supabase
    .from("results")
    .select("heat_lanes!inner ( entries!inner ( athlete_id ) )")
    .eq("status", "published")
    .eq("result_outcome", "valid")
    .not("official_time_ms", "is", null)
    .limit(1);
  const lane = (data ?? [])[0] as
    | { heat_lanes?: { entries?: { athlete_id?: string } } }
    | undefined;
  return lane?.heat_lanes?.entries?.athlete_id ?? null;
}

/**
 * A seeded demo swimmer of the given age group with room to enter races.
 *
 * The registration specs named one account, and once that swimmer's four
 * slots were used by real published swims there was no non-destructive way to
 * free them — the spec could only skip. What is under test is the RULE (a U14
 * can enter two races and owes 600 EGP), not the identity of the swimmer, so
 * the account is chosen rather than assumed. Only @ssc-demo.test accounts are
 * considered, and they all share SEED_PASSWORD.
 */
export async function findAthleteWithCapacity(
  ageGroup: "U14" | "U17" | "Open",
  freeSlots = 2,
): Promise<{ email: string; athleteId: string } | null> {
  const supabase = await as(CREDENTIALS.admin);
  if (!supabase) return null;

  const { data: athletes } = await supabase
    .from("athletes")
    .select("id, age_group, users!athletes_user_id_fkey ( email )")
    .eq("age_group", ageGroup);
  if (!athletes?.length) return null;

  for (const athlete of athletes) {
    const email = (athlete as { users?: { email?: string } }).users?.email;
    if (!email || !email.endsWith("@ssc-demo.test")) continue;

    // Count LOCKED slots only — entries with any result cannot be reclaimed by
    // freeRegistrationSlots(). After seed-played-meet confirms payments and
    // scores Freestyle, most swimmers sit at 2–4 entries but only one is
    // locked; counting raw rows would skip every usable U14 fixture.
    const { data: entries } = await supabase
      .from("entries")
      .select("id, events!inner ( is_skins, is_relay ), heat_lanes ( id, results ( id ) )")
      .eq("athlete_id", athlete.id)
      .eq("events.is_skins", false)
      .eq("events.is_relay", false);

    type LaneWithResults = { id: string; results?: unknown[] };
    const locked = (entries ?? []).filter((e) => {
      const lanes = ((e as { heat_lanes?: LaneWithResults[] }).heat_lanes ?? []);
      return lanes.some((lane) => (lane.results ?? []).length > 0);
    }).length;

    if (4 - locked >= freeSlots) {
      return { email, athleteId: athlete.id as string };
    }
  }
  return null;
}

/**
 * Puts a Skins Round of 6 back into the referee's hands.
 *
 * The scoring spec publishes the round it scores, so after the first run
 * every board is published and there is nothing left to score. Reopening one
 * (the same action an admin takes to correct a mistake) restores work to do,
 * and the round is re-published on cleanup so the board is left as found.
 */
export async function reopenSkinsRoundFixture(): Promise<Fixture | null> {
  const supabase = await as(CREDENTIALS.admin);
  if (!supabase) return null;

  const { data: heats } = await supabase
    .from("heats")
    .select("id, skins_round, skins_swim_off, heat_lanes ( id, results ( id, status ) )")
    .eq("skins_round", 6)
    .eq("skins_swim_off", false);

  type Lane = { id: string; results?: { id: string; status: string }[] };
  const published = (heats ?? []).find((h) => {
    const lanes = ((h as { heat_lanes?: Lane[] }).heat_lanes ?? []);
    const results = lanes.flatMap((l) => l.results ?? []);
    return results.length > 0 && results.every((r) => r.status === "published");
  });
  // Nothing published means there is already an unscored or draft round to
  // work on — the spec can proceed untouched.
  if (!published) return { cleanup: async () => {} };

  const laneIds = ((published as { heat_lanes?: Lane[] }).heat_lanes ?? []).map((l) => l.id);
  const { error } = await supabase
    .from("results")
    .update({ status: "draft" })
    .in("heat_lane_id", laneIds);
  if (error) return null;

  return {
    cleanup: async () => {
      await supabase
        .from("results")
        .update({ status: "published" })
        .in("heat_lane_id", laneIds)
        .not("result_outcome", "is", null);
    },
  };
}

/**
 * Restores the "Set up Round of 4" affordance on a Skins board.
 *
 * The advance spec creates the next round, so on later runs every board
 * already has one and the button is gone. Only an UNSCORED Round of 4 is
 * removed — one carrying results is a real round that was swum, and deleting
 * it would cascade those results away.
 */
export async function clearSkinsNextRoundFixture(): Promise<Fixture | null> {
  const supabase = await as(CREDENTIALS.admin);
  if (!supabase) return null;

  const { data: heats } = await supabase
    .from("heats")
    .select("id, heat_lanes ( id, results ( id ) )")
    .eq("skins_round", 4)
    .eq("skins_swim_off", false);

  type Lane = { id: string; results?: unknown[] };
  const unscored = (heats ?? []).filter((h) => {
    const lanes = ((h as { heat_lanes?: Lane[] }).heat_lanes ?? []);
    return lanes.every((l) => (l.results ?? []).length === 0);
  });
  if (unscored.length > 0) {
    await supabase.from("heats").delete().in("id", unscored.map((h) => h.id as string));
  }
  // The bracket rebuilds the round on demand, so there is nothing to restore.
  return { cleanup: async () => {} };
}
