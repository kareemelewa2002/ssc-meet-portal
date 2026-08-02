import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import { RACE_PRICE_EGP } from "@/lib/event-registration";

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
}

interface RawEntryRow {
  id: string;
  athlete_id: string;
  events: { name: string; event_order: number } | { name: string; event_order: number }[] | null;
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
 * that swimmer entered in a single tap, rather than confirming per-race. */
export async function fetchPendingCashPayments(): Promise<PendingPaymentAthlete[]> {
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
      };
      existing.entryIds.push(row.id);
      const event = firstOf(row.events);
      if (event?.name) existing.raceNames.push(event.name);
      existing.raceCount += 1;
      existing.totalEgp += RACE_PRICE_EGP;
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
