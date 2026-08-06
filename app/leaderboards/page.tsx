import Link from "next/link";
import { Trophy, Medal, Waves } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Card, CardContent } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

/**
 * The Leaderboards index.
 *
 * Two kinds of board exist and they answer different questions, so this page
 * offers both rather than picking one:
 *
 *   - A MEET's standings are scored from that meet's races alone.
 *   - The ALL-TIME boards rank across every volume.
 *
 * This used to redirect straight to the current meet, which left the all-time
 * boards reachable only through a link on the Athletes page.
 */
export default async function LeaderboardsPage() {
  let volumes: { volume_number: number; name: string; status: string }[] = [];

  try {
    // No status/is_public filter applied here. public.meet_volumes' RLS
    // policy already returns exactly the right set for whoever is signed
    // in — public, non-planned volumes for anyone else, everything for an
    // admin. This runs through the SERVER client specifically because it is
    // a Server Component: that client carries the real request cookies, so
    // an admin's own session is what RLS's is_admin() actually sees. Filtering
    // status here too would just be a second, weaker copy of the rule the
    // database already enforces exactly.
    const supabase = await createClient();
    const { data } = await supabase
      .from("meet_volumes")
      .select("volume_number, name, status")
      .order("volume_number", { ascending: false });
    volumes = data ?? [];
  } catch {
    // The all-time boards need no volume at all, so they stay reachable.
  }

  return (
    <div className="min-h-screen">
      <AppHeader title="Leaderboards" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Trophy className="size-6" />
            Leaderboards
          </h1>
          <p className="text-sm text-muted-foreground">
            Standings for a single meet, and records across every volume.
          </p>
        </header>

        <Link href="/leaderboards/all-time" className="block">
          <Card className="transition-colors hover:bg-muted/50">
            <CardContent className="flex items-center gap-3 p-4">
              <Medal className="size-5 shrink-0" />
              <div className="min-w-0">
                <p className="font-bold">All-Time Records</p>
                <p className="text-sm text-muted-foreground">
                  Best performers, best performances in each event, and best performance by World
                  Aquatics points — across every volume.
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>

        {volumes.map((v) => (
          <Link
            key={v.volume_number}
            href={`/events/${v.volume_number}/leaderboard`}
            className="block"
          >
            <Card className="transition-colors hover:bg-muted/50">
              <CardContent className="flex items-center gap-3 p-4">
                <Waves className="size-5 shrink-0" />
                <div className="min-w-0">
                  <p className="font-bold">{v.name}</p>
                  <p className="text-sm text-muted-foreground">
                    Champions, progress and team standings for this meet only.
                  </p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </main>
    </div>
  );
}
