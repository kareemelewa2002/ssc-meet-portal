import { createClient } from "@/lib/supabase/client";

export interface MeetSummaryStats {
  athleteCount: number;
  teamCount: number;
  eventCount: number;
}

/** Home page stat badges — three cheap head:true count queries (no row data
 * transferred), each independently null-safe so one failing table never
 * blanks the other two. */
export async function fetchMeetSummaryStats(): Promise<MeetSummaryStats> {
  const supabase = createClient();
  const [athletes, teams, events] = await Promise.all([
    supabase.from("athletes").select("*", { count: "exact", head: true }).eq("approved_by_admin", true),
    supabase.from("teams").select("*", { count: "exact", head: true }).eq("approved_by_admin", true),
    supabase.from("events").select("*", { count: "exact", head: true }),
  ]);
  return {
    athleteCount: athletes.count ?? 0,
    teamCount: teams.count ?? 0,
    eventCount: events.count ?? 0,
  };
}
