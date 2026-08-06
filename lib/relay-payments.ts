import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { firstOf } from "@/lib/live-heats";
import type { AgeGroup, EntryStatus } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// Relay squad payments.
//
// A relay squad is ONE payable unit, billed to the team captain, never split
// across the four swimmers on it. This is a genuine behavior change from an
// earlier version of this schema, where each swimmer paid their own leg fee
// as part of their individual entry quote — see quote_athlete_entries() in
// schema.sql, which no longer includes a relay line at all.
//
// A squad row is ALWAYS complete (4/4 legs) by the time it exists in the
// database — public.validate_relay_squad(), a deferred constraint trigger
// that predates this feature, refuses to let any transaction commit while a
// squad has fewer than 4 legs. There is therefore no "incomplete squad"
// state to represent here; every squad this file fetches is payable in that
// sense already. What varies is whether it HAS been paid.
//
// Payment confirmation is ADMIN-ONLY, deliberately — see
// confirm_relay_squad_payment()'s comment in schema.sql. The captain is who
// owes, not who may mark the debt settled; every other payment in this app
// works the same way (cash changes hands physically, an admin confirms it).
// ---------------------------------------------------------------------------

export interface RelaySquadPayment {
  squadId: string;
  eventId: string;
  eventName: string;
  teamId: string;
  teamName: string;
  captainName: string | null;
  squadLetter: string;
  ageGroup: AgeGroup;
  status: EntryStatus;
  legsFilled: number;
  /** The amount actually paid, once paid — from relay_squad_payments, not
   * recomputed. Null until paid. */
  paidAmountEgp: number | null;
  paidAt: string | null;
  collectedByName: string | null;
  /** The amount an unpaid squad would cost right now, from
   * quote_relay_squad_egp() — the LIVE price, since relay_swimmer_price_egp
   * can change and this is not tiered like individual entries. Null once paid
   * (paidAmountEgp is the number that matters then). */
  currentQuoteEgp: number | null;
  holdExpiresAt: string | null;
}

type RawSquadRow = {
  id: string;
  event_id: string;
  team_id: string;
  age_group: AgeGroup;
  squad_letter: string;
  status: EntryStatus;
  hold_expires_at: string | null;
  events: { name: string } | { name: string }[] | null;
  teams: { name: string; captain_id: string | null } | { name: string; captain_id: string | null }[] | null;
  relay_legs: { athlete_id: string }[] | null;
};

async function attachQuotesAndPayments(
  rows: RawSquadRow[],
): Promise<RelaySquadPayment[]> {
  const supabase = createClient();

  // Captain names, batched — a squad's `teams` embed gives captain_id but not
  // the name, and there is no FK from teams straight to a display name.
  const captainIds = [
    ...new Set(rows.map((r) => firstOf(r.teams)?.captain_id).filter((v): v is string => !!v)),
  ];
  const captainNames = new Map<string, string>();
  if (captainIds.length > 0) {
    const { data } = await supabase.from("users").select("id, full_name").in("id", captainIds);
    (data ?? []).forEach((u) => captainNames.set(u.id, u.full_name));
  }

  return Promise.all(
    rows.map(async (row): Promise<RelaySquadPayment> => {
      const event = firstOf(row.events);
      const team = firstOf(row.teams);
      const legsFilled = row.relay_legs?.length ?? 0;

      let paidAmountEgp: number | null = null;
      let paidAt: string | null = null;
      let collectedByName: string | null = null;
      let currentQuoteEgp: number | null = null;

      if (row.status === "confirmed") {
        const { data: paymentRaw } = await supabase
          .from("relay_squad_payments")
          .select("amount_egp, collected_at, users:collected_by ( full_name )")
          .eq("squad_id", row.id)
          .maybeSingle();
        // Cast for the same reason as the relay_squads embeds above: no
        // declared FK relationship metadata for this hand-maintained type.
        const payment = paymentRaw as unknown as {
          amount_egp: number;
          collected_at: string;
          users: { full_name: string } | { full_name: string }[] | null;
        } | null;
        if (payment) {
          paidAmountEgp = payment.amount_egp;
          paidAt = payment.collected_at;
          collectedByName = firstOf(payment.users)?.full_name ?? null;
        }
      } else {
        const { data: quote } = await supabase.rpc("quote_relay_squad_egp", {
          p_squad_id: row.id,
        });
        const q = Array.isArray(quote) ? quote[0] : null;
        currentQuoteEgp = q?.amount_egp ?? null;
      }

      return {
        squadId: row.id,
        eventId: row.event_id,
        eventName: event?.name ?? "Relay",
        teamId: row.team_id,
        teamName: team?.name ?? "Unknown team",
        captainName: team?.captain_id ? captainNames.get(team.captain_id) ?? null : null,
        squadLetter: row.squad_letter,
        ageGroup: row.age_group,
        status: row.status,
        legsFilled,
        paidAmountEgp,
        paidAt,
        collectedByName,
        currentQuoteEgp,
        holdExpiresAt: row.hold_expires_at,
      };
    }),
  );
}

/** Every relay squad a team has entered, with fill and payment status —
 * what the Captain Dashboard's "Relay payments" section renders. */
export async function fetchTeamRelaySquadPayments(
  teamId: string,
): Promise<FetchResult<RelaySquadPayment[]>> {
  const result = await runQuery<RawSquadRow[]>(
    "Loading your team's relay payments",
    async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("relay_squads")
        .select(
          "id, event_id, team_id, age_group, squad_letter, status, hold_expires_at, events ( name ), teams ( name, captain_id ), relay_legs ( athlete_id )",
        )
        .eq("team_id", teamId)
        .order("squad_letter", { ascending: true });
      // Cast, not a fight with the type-checker: this hand-maintained
      // Database type has no declared FK relationship metadata for
      // relay_squads -> events/teams, so PostgREST's embed inference cannot
      // resolve it — same limitation, same fix, as fetchTeamSquads() in
      // lib/relays.ts.
      return { data: data as unknown as RawSquadRow[] | null, error };
    },
    { empty: [] },
  );

  if (result.error) return { ...result, data: [] };
  return { ...result, data: await attachQuotesAndPayments(result.data) };
}

/** Every UNPAID relay squad across every team — the admin cash desk's relay
 * section. Every row here is complete (4/4) by construction; see the module
 * comment for why there is no "incomplete" state to filter out. */
export async function fetchPendingRelaySquadPayments(): Promise<
  FetchResult<RelaySquadPayment[]>
> {
  const result = await runQuery<RawSquadRow[]>(
    "Loading pending relay payments",
    async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("relay_squads")
        .select(
          "id, event_id, team_id, age_group, squad_letter, status, hold_expires_at, events ( name ), teams ( name, captain_id ), relay_legs ( athlete_id )",
        )
        .eq("status", "pending_payment")
        .order("squad_letter", { ascending: true });
      return { data: data as unknown as RawSquadRow[] | null, error };
    },
    { empty: [] },
  );

  if (result.error) return { ...result, data: [] };
  return { ...result, data: await attachQuotesAndPayments(result.data) };
}

/** Confirms a relay squad's payment — the admin cash desk's write path.
 * Admin-only at the RLS/function layer; see confirm_relay_squad_payment()'s
 * comment in schema.sql for why a captain cannot do this themselves. */
export async function confirmRelaySquadPayment(input: {
  squadId: string;
  collectedBy: string;
  note?: string;
}): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase.rpc("confirm_relay_squad_payment", {
    p_squad_id: input.squadId,
    p_collected_by: input.collectedBy,
    p_note: input.note ?? undefined,
  });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/** Re-acquires a hold on a relay squad whose payment window lapsed —
 * captain-initiated (reclaim_entry_slot() is the individual-entry,
 * swimmer-initiated equivalent). False when the relay event is now full. */
export async function reclaimRelaySquadHold(
  squadId: string,
): Promise<{ success: boolean; error?: string; full?: boolean }> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("reclaim_relay_squad_hold", {
    p_squad_id: squadId,
  });
  if (error) return { success: false, error: error.message };
  if (data === false) {
    return {
      success: false,
      full: true,
      error: "This relay event is now full. Ask an admin about the waitlist.",
    };
  }
  return { success: true };
}
