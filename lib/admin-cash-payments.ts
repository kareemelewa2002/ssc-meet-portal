import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import type { PriceLine, PriceLineKind } from "@/lib/pricing";
import type { PricingTier } from "@/lib/meet-settings";

export interface PendingPaymentAthlete {
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  entryIds: string[];
  /** The actual races entered — an admin at the desk needs to see WHAT the
   * swimmer is paying for, not just how many. */
  raceNames: string[];
  raceCount: number;
  totalEgp: number;
  /** The full derivation of totalEgp: package, additional races, surcharges
   * and relay legs. Shown at the desk so a swimmer asking "why this much?"
   * gets an answer, rather than the admin having to recompute it. */
  lines: PriceLine[];
  tier: PricingTier | null;
  /** False when the quote could not be produced, so `totalEgp` is not a figure
   * to collect against. The desk must never read an incomplete total as final. */
  pricingComplete: boolean;
}

type EventEmbed = {
  name: string;
  event_order: number;
};

interface RawEntryRow {
  id: string;
  athlete_id: string;
  events: EventEmbed | EventEmbed[] | null;
  athletes:
    | {
        team_id: string | null;
        users: { full_name: string } | { full_name: string }[] | null;
        teams: { name: string } | { name: string }[] | null;
      }
    | {
        team_id: string | null;
        users: { full_name: string } | { full_name: string }[] | null;
        teams: { name: string } | { name: string }[] | null;
      }[]
    | null;
}

/**
 * Every athlete with at least one unpaid entry, grouped so an admin can verify
 * one cash handoff at the desk and clear every race that swimmer entered in a
 * single tap.
 *
 * The AMOUNT comes from public.quote_athlete_entries(), one call per athlete —
 * not from anything computed here. Two reasons this matters:
 *
 *   1. Under package pricing there is no per-race price to multiply by. The
 *      package depends on how many races the swimmer entered in total, so the
 *      figure cannot be assembled entry by entry.
 *   2. Price settles at PAYMENT time. The desk must quote what the database
 *      says right now, not what a client running yesterday's code believes.
 *
 * An athlete whose quote fails is returned with pricingComplete: false rather
 * than a zero or a guess.
 */
export async function fetchPendingCashPayments(
  meetVolumeId: string,
): Promise<PendingPaymentAthlete[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("entries")
      .select(
        // Qualify the FK — athletes has two (user_id and parent_id), so a
        // bare "users(...)" embed is ambiguous to PostgREST (PGRST201).
        "id, athlete_id, events ( name, event_order ), athletes ( team_id, users!athletes_user_id_fkey ( full_name ), teams ( name ) )",
      )
      .eq("status", "pending_payment");
    if (error || !data) return [];

    const byAthlete = new Map<string, PendingPaymentAthlete>();
    for (const row of data as unknown as RawEntryRow[]) {
      const athlete = firstOf(row.athletes);
      const user = athlete ? firstOf(athlete.users) : null;
      const team = athlete ? firstOf(athlete.teams) : null;
      if (!user) continue;

      const existing = byAthlete.get(row.athlete_id) ?? {
        athleteId: row.athlete_id,
        athleteName: user.full_name,
        teamName: team?.name ?? null,
        entryIds: [],
        raceNames: [],
        raceCount: 0,
        totalEgp: 0,
        lines: [],
        tier: null,
        pricingComplete: true,
      };
      existing.entryIds.push(row.id);
      const event = firstOf(row.events);
      if (event?.name) existing.raceNames.push(event.name);
      existing.raceCount += 1;
      byAthlete.set(row.athlete_id, existing);
    }

    const athletes = [...byAthlete.values()];

    // One quote per athlete. Parallel rather than sequential: a busy desk has
    // dozens of swimmers queued and serialising the round trips is what makes
    // the page feel broken.
    await Promise.all(
      athletes.map(async (entry) => {
        const { data: quote, error: quoteError } = await supabase.rpc(
          "quote_athlete_entries",
          {
            p_athlete_id: entry.athleteId,
            p_meet_volume_id: meetVolumeId,
            p_include_statuses: ["pending_payment"],
          },
        );

        if (quoteError || !Array.isArray(quote) || quote.length === 0) {
          // Deliberately not zero. A zero reads as "this swimmer owes
          // nothing", which an admin would act on by waving them through.
          entry.pricingComplete = false;
          return;
        }

        entry.lines = quote.map((line) => ({
          kind: line.kind as PriceLineKind,
          label: line.label,
          entryId: line.entry_id,
          amountEgp: line.amount_egp,
          tier: line.tier as PricingTier,
        }));
        entry.totalEgp = entry.lines.reduce((sum, l) => sum + l.amountEgp, 0);
        entry.tier = entry.lines[0]?.tier ?? null;
      }),
    );

    for (const row of athletes) row.raceNames.sort();
    return athletes.sort((a, b) => a.athleteName.localeCompare(b.athleteName));
  } catch {
    return [];
  }
}

/**
 * Confirms a swimmer's cash payment — the single admin decision point.
 *
 * Two things happen, and the order matters. The payment RECORD is written
 * first, then the entries are confirmed. Nothing else in this schema stores a
 * price: prices are recomputed live and the tier moves on, so if the record
 * were skipped the meet would end with no way to say what anyone paid. Writing
 * it first means a failure leaves entries unpaid and re-collectable, rather
 * than confirmed with no receipt.
 *
 * `lines` is the quote the admin was looking at when they took the cash. It is
 * stored verbatim rather than recomputed, so the receipt says what was actually
 * agreed even after the tier changes.
 */
export async function confirmCashPayment(input: {
  athleteId: string;
  meetVolumeId: string;
  entryIds: string[];
  amountEgp: number;
  tier: PricingTier;
  lines: PriceLine[];
  // No collectedBy: public.enforce_collected_by() derives the collector from
  // auth.uid() on insert, so a value passed from here would be overwritten.
  // Dropped rather than left in place, because a field that looks like it
  // sets the audit collector but silently cannot is worse than no field.
  note?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (input.entryIds.length === 0) {
    return { success: false, error: "No entries to confirm." };
  }
  const supabase = createClient();

  const { data: payment, error: paymentError } = await supabase
    .from("entry_payments")
    .insert({
      athlete_id: input.athleteId,
      meet_volume_id: input.meetVolumeId,
      tier: input.tier,
      amount_egp: input.amountEgp,
      method: "cash",
      note: input.note ?? null,
    })
    .select("id")
    .single();

  if (paymentError || !payment) {
    return {
      success: false,
      error: paymentError?.message ?? "Could not record the payment.",
    };
  }

  if (input.lines.length > 0) {
    const { error: itemsError } = await supabase.from("entry_payment_items").insert(
      input.lines.map((line) => ({
        payment_id: payment.id,
        entry_id: line.entryId,
        kind: line.kind,
        label: line.label,
        amount_egp: line.amountEgp,
      })),
    );
    // The header carries the amount, so a failed item write loses the
    // itemisation but not the fact of payment. Reported, not swallowed.
    if (itemsError) {
      return {
        success: false,
        error: `Payment recorded, but its breakdown was not: ${itemsError.message}`,
      };
    }
  }

  // Flips the entries to 'confirmed', which fires generate_heats_on_confirm
  // and seeds the heats for every event they entered.
  const { error } = await supabase
    .from("entries")
    .update({ status: "confirmed" })
    .in("id", input.entryIds);
  if (error) return { success: false, error: error.message };

  return { success: true };
}

export interface PaymentReceipt {
  id: string;
  amountEgp: number;
  tier: PricingTier;
  collectedAt: string;
  collectedByName: string | null;
  method: string;
  lines: { kind: PriceLineKind; label: string; amountEgp: number }[];
}

/** What this swimmer has actually paid — the financial record, read back. */
export async function fetchPaymentHistory(
  athleteId: string,
  meetVolumeId: string,
): Promise<PaymentReceipt[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("entry_payments")
      .select(
        "id, amount_egp, tier, collected_at, method, users:collected_by ( full_name ), entry_payment_items ( kind, label, amount_egp )",
      )
      .eq("athlete_id", athleteId)
      .eq("meet_volume_id", meetVolumeId)
      .order("collected_at", { ascending: false });

    if (error || !data) return [];

    type Row = {
      id: string;
      amount_egp: number;
      tier: PricingTier;
      collected_at: string;
      method: string;
      users: { full_name: string } | { full_name: string }[] | null;
      entry_payment_items:
        | { kind: PriceLineKind; label: string; amount_egp: number }[]
        | null;
    };

    return (data as unknown as Row[]).map((row) => ({
      id: row.id,
      amountEgp: row.amount_egp,
      tier: row.tier,
      collectedAt: row.collected_at,
      collectedByName: firstOf(row.users)?.full_name ?? null,
      method: row.method,
      lines: (row.entry_payment_items ?? []).map((i) => ({
        kind: i.kind,
        label: i.label,
        amountEgp: i.amount_egp,
      })),
    }));
  } catch {
    return [];
  }
}

/**
 * Entries that exist but cannot be collected against, by status.
 *
 * The cash desk lists only `pending_payment`, which is correct — a confirmed
 * entry is already paid, and a `hold_expired` one gave its slot back, so
 * taking money for it would be selling a place that may have gone to the
 * waitlist. But "correctly empty" and "nothing registered" look identical on
 * screen, and they are not the same problem. A production database was found
 * with all 141 of its entries sitting in `hold_expired`: the desk was right
 * to show nothing, and the screen gave no way to tell that from an empty
 * meet.
 */
export async function fetchNonCollectableEntryCounts(): Promise<Record<string, number>> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.from("entries").select("status").neq("status", "pending_payment");
    if (error || !data) return {};
    const counts: Record<string, number> = {};
    for (const row of data as { status: string }[]) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
    return counts;
  } catch {
    return {};
  }
}
