import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import { RACE_PRICE_EGP } from "@/lib/event-registration";

export interface PendingPaymentAthlete {
  athleteId: string;
  athleteName: string;
  teamName: string | null;
  entryIds: string[];
  raceCount: number;
  totalEgp: number;
}

interface RawEntryRow {
  id: string;
  athlete_id: string;
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
        "id, athlete_id, athletes ( team_id, users!athletes_user_id_fkey ( full_name ), teams ( name ) )",
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
        raceCount: 0,
        totalEgp: 0,
      };
      existing.entryIds.push(row.id);
      existing.raceCount += 1;
      existing.totalEgp += RACE_PRICE_EGP;
      byAthlete.set(row.athlete_id, existing);
    }

    return [...byAthlete.values()].sort((a, b) => a.athleteName.localeCompare(b.athleteName));
  } catch {
    return [];
  }
}

/**
 * Approves the swimmer AND confirms their cash in one admin action.
 *
 * These used to be two separate queues: an athlete was approved at signup
 * time, and payment was confirmed later. Registration no longer waits on
 * approval, so the admin's single decision point is now "this swimmer turned
 * up and paid" — approving them and confirming the entries together. Doing
 * them as one call keeps the two from drifting apart (an approved swimmer
 * with unpaid entries, or paid entries for an unapproved swimmer).
 */
export async function approveAndConfirmPayment(
  athleteId: string,
  entryIds: string[],
): Promise<{ success: boolean; error?: string }> {
  if (entryIds.length === 0) return { success: false, error: "No entries to confirm." };
  const supabase = createClient();

  const { error: approveError } = await supabase
    .from("athletes")
    .update({ approved_by_admin: true })
    .eq("id", athleteId);
  if (approveError) return { success: false, error: approveError.message };

  const { error } = await supabase
    .from("entries")
    .update({ status: "confirmed" })
    .in("id", entryIds);
  if (error) return { success: false, error: error.message };
  return { success: true };
}
