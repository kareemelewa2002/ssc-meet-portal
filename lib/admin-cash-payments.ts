import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";

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
  /** False when at least one of this swimmer's races is in a session with no
   * configured price, so `totalEgp` is short of what they actually owe. The
   * desk must not read the figure as final. */
  pricingComplete: boolean;
}

type EventEmbed = {
  name: string;
  event_order: number;
  sessions: { session_number: number } | { session_number: number }[] | null;
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

/** Every athlete with at least one "pending_payment" entry — grouped so an
 * admin can verify one cash handoff at the meet desk and clear every race
 * that swimmer entered in a single tap, rather than confirming per-race.
 *
 * `priceBySession` maps session_number -> individual race price, from
 * meet_settings (see /admin/control-unit). A MAP rather than a single price
 * because pricing is per session: a swimmer entered in sessions 1 and 3 owes
 * each session's rate, and one scalar would silently charge them twice at the
 * wrong one. Nothing is defaulted — a race whose session has no configured
 * price is counted but left unpriced, and the row is flagged
 * `pricingComplete: false` so the desk sees an incomplete total instead of a
 * confident wrong one. */
export async function fetchPendingCashPayments(
  priceBySession: ReadonlyMap<number, number>,
): Promise<PendingPaymentAthlete[]> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("entries")
      .select(
        // Qualify the FK — athletes has two (user_id and parent_id), so a
        // bare "users(...)" embed is ambiguous to PostgREST (PGRST201).
        "id, athlete_id, events ( name, event_order, sessions ( session_number ) ), athletes ( team_id, users!athletes_user_id_fkey ( full_name ), teams ( name ) )",
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
        pricingComplete: true,
      };
      existing.entryIds.push(row.id);
      const event = firstOf(row.events);
      if (event?.name) existing.raceNames.push(event.name);
      existing.raceCount += 1;

      const sessionNumber = event ? firstOf(event.sessions)?.session_number : undefined;
      const price = sessionNumber == null ? undefined : priceBySession.get(sessionNumber);
      if (price == null) {
        // Counted, deliberately not priced. Adding a zero would read as a free
        // race; adding some other session's price would read as an authorised
        // charge. Neither is true, so the shortfall is flagged instead.
        existing.pricingComplete = false;
      } else {
        existing.totalEgp += price;
      }
      byAthlete.set(row.athlete_id, existing);
    }

    for (const row of byAthlete.values()) row.raceNames.sort();
    return [...byAthlete.values()].sort((a, b) => a.athleteName.localeCompare(b.athleteName));
  } catch {
    return [];
  }
}

/**
 * Confirms a swimmer's cash payment — the single admin decision point.
 *
 * Account approval no longer exists: paying the entry fee is the seriousness
 * signal. Confirming here flips the entries to 'confirmed', which fires
 * generate_heats_on_confirm and seeds the heats for every event they entered.
 */
export async function confirmCashPayment(
  entryIds: string[],
): Promise<{ success: boolean; error?: string }> {
  if (entryIds.length === 0) return { success: false, error: "No entries to confirm." };
  const supabase = createClient();

  const { error } = await supabase
    .from("entries")
    .update({ status: "confirmed" })
    .in("id", entryIds);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
