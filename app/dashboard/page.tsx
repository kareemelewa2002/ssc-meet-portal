"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppHeader } from "@/components/layout/app-header";
import { AthleteOverview } from "@/components/dashboard/athlete-overview";
import { MySkinsSlot } from "@/components/dashboard/my-skins-slot";
import { useMyPortals } from "@/hooks/use-my-portals";

export default function DashboardPage() {
  // Resolved once per user and shared with AppHeader, rather than this page
  // making its own auth round-trip — see hooks/use-my-portals.ts.
  const { athleteId } = useMyPortals();

  return (
    <div className="min-h-screen">
      <AppHeader title="Dashboard" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">Athlete Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Your team, races, heat assignments and payments. Skins slots are assigned from
              official meet results, and accepted or declined in person at the venue.
            </p>
          </div>
          <Button
            variant="outline"
            nativeButton={false}
            className="min-h-[48px] gap-2"
            render={<Link href="/dashboard/teams" />}
          >
            <Users className="size-4" />
            Team History
          </Button>
        </header>

        <AthleteOverview />

        {/* Was a six-board grid of every qualifier in the meet. A personal
            dashboard shows this swimmer's own slot, or nothing — the full
            boards are a deck document and live on /admin/seeding and the
            referee deck, where the roll call is actually run. */}
        <MySkinsSlot athleteId={athleteId} />
      </main>
    </div>
  );
}
