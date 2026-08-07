import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import { fetchEntryQuote, tierLabel, type PriceLine } from "@/lib/pricing";
import type { PricingTier } from "@/lib/meet-settings";
import { firstOf } from "@/lib/live-heats";

// ---------------------------------------------------------------------------
// One athlete's individual-entry payment status, grouped by meet volume —
// entry_payments is one row per (athlete, volume): an admin confirms every
// pending entry for a volume in a single cash collection, never per race.
// This is the persistent view that gap was missing: registration itself
// already shows the itemized total at submit time
// (components/events/event-registration-client.tsx), but nothing showed it
// again afterward. Relay squad payments are deliberately NOT included here —
// those stay captain-scoped (components/captain/relay-payments.tsx), a
// separate payment the squad owes as a unit, not this athlete individually.
// ---------------------------------------------------------------------------

export interface AthletePaymentStatus {
  meetVolumeId: string;
  volumeName: string;
  volumeNumber: number;
  /** true once an admin has recorded entry_payments for this volume — the
   * athlete's pending_payment entries are what drove the quote below before
   * that happened, and are irrelevant once it has (the confirmed amount is
   * what was actually collected, not a re-quote). */
  confirmed: boolean;
  totalEgp: number;
  tier: PricingTier | null;
  /** Only meaningful when NOT confirmed — the itemized quote for whatever is
   * still pending_payment. null once confirmed, since entry_payments does
   * not retain a line-item breakdown, only the settled total. */
  lines: PriceLine[] | null;
  collectedAt: string | null;
  /** Full name of the admin who took the payment, or null before/if unknown
   * (e.g. a future non-cash gateway with no human collector). */
  collectedByName: string | null;
}

type RawVolumeEmbed = { id: string; volume_number: number; name: string };
type RawSessionEmbed = {
  meet_volumes: RawVolumeEmbed | RawVolumeEmbed[] | null;
};
type RawEventEmbed = {
  sessions: RawSessionEmbed | RawSessionEmbed[] | null;
};
interface EntryVolumeRow {
  events: RawEventEmbed | RawEventEmbed[] | null;
}

type RawCollectorEmbed = { full_name: string };
interface PaymentRow {
  meet_volume_id: string;
  amount_egp: number;
  tier: PricingTier;
  collected_at: string;
  collected_by: RawCollectorEmbed | RawCollectorEmbed[] | null;
}

/** Every meet volume this athlete has entries in, individual-entry payment
 * status for each — confirmed (with the collector and settled amount) or
 * still pending (with a live itemized quote). Ordered newest volume first. */
export async function fetchMyEntryPaymentStatus(
  athleteId: string,
): Promise<FetchResult<AthletePaymentStatus[]>> {
  const supabase = createClient();

  const volumesResult = await runQuery<
    { id: string; volume_number: number; name: string }[]
  >(
    "Loading this athlete's entered meets",
    async () => {
      const { data, error } = await supabase
        .from("entries")
        .select("events ( sessions ( meet_volumes ( id, volume_number, name ) ) )")
        .eq("athlete_id", athleteId);
      if (error) return { data: null, error };
      const volumes = new Map<string, RawVolumeEmbed>();
      for (const row of (data as unknown as EntryVolumeRow[] | null) ?? []) {
        const event = firstOf(row.events);
        const session = event ? firstOf(event.sessions) : null;
        const volume = session ? firstOf(session.meet_volumes) : null;
        if (volume) volumes.set(volume.id, volume);
      }
      return { data: [...volumes.values()], error: null };
    },
    { empty: [] },
  );
  if (volumesResult.error) return { ...volumesResult, data: [] };

  const paymentsResult = await runQuery<PaymentRow[]>(
    "Loading this athlete's payment records",
    async () => {
      const { data, error } = await supabase
        .from("entry_payments")
        .select("meet_volume_id, amount_egp, tier, collected_at, collected_by ( full_name )")
        .eq("athlete_id", athleteId);
      return { data: data as unknown as PaymentRow[] | null, error };
    },
    { empty: [] },
  );

  const paymentByVolume = new Map<string, PaymentRow>(
    paymentsResult.data.map((p) => [p.meet_volume_id, p]),
  );

  const statuses: AthletePaymentStatus[] = [];
  for (const volume of volumesResult.data) {
    const payment = paymentByVolume.get(volume.id);
    if (payment) {
      const collector = firstOf(payment.collected_by);
      statuses.push({
        meetVolumeId: volume.id,
        volumeName: volume.name,
        volumeNumber: volume.volume_number,
        confirmed: true,
        totalEgp: payment.amount_egp,
        tier: payment.tier,
        lines: null,
        collectedAt: payment.collected_at,
        collectedByName: collector?.full_name ?? null,
      });
      continue;
    }

    const quote = await fetchEntryQuote(athleteId, volume.id);
    if (!quote.data) continue; // nothing pending_payment in this volume — e.g. all NS/withdrawn
    statuses.push({
      meetVolumeId: volume.id,
      volumeName: volume.name,
      volumeNumber: volume.volume_number,
      confirmed: false,
      totalEgp: quote.data.totalEgp,
      tier: quote.data.tier,
      lines: quote.data.lines,
      collectedAt: null,
      collectedByName: null,
    });
  }

  return { ...volumesResult, data: statuses.sort((a, b) => b.volumeNumber - a.volumeNumber) };
}

export { tierLabel };
