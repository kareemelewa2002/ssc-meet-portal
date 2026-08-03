import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/**
 * Canonical /leaderboards entry point.
 *
 * The nav used to compute this destination itself and fall back to the
 * all-time page when no volume was live, which meant "Leaderboards" could
 * land on two different screens depending on meet state. Resolving it here
 * keeps the link stable, and sends people to the meet standings — where the
 * all-time boards now sit as a tab — whenever there is a meet to show.
 */
export default async function LeaderboardsPage() {
  let volumeNumber: number | null = null;

  try {
    const supabase = await createClient();
    const { data } = await supabase
      .from("meet_volumes")
      .select("volume_number, status")
      .order("volume_number", { ascending: false });

    const volumes = data ?? [];
    // Newest first, so: the meet most recently swum, then the next one on the
    // calendar, then whatever exists.
    const target =
      volumes.find((v) => v.status === "completed") ??
      volumes.find((v) => v.status === "scheduled") ??
      volumes[0];
    volumeNumber = target?.volume_number ?? null;
  } catch {
    // Fall through to the all-time boards: they need no volume at all, so
    // they are the honest destination when one cannot be resolved.
  }

  // redirect() MUST be outside the try. It signals by THROWING a special
  // NEXT_REDIRECT error, so a catch wrapped around it swallows the redirect
  // and silently sends everyone to the fallback instead.
  if (volumeNumber != null) redirect(`/events/${volumeNumber}/leaderboard`);
  redirect("/leaderboards/all-time");
}
