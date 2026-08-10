"use client";

import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { AppHeader } from "@/components/layout/app-header";
import { AthleteOverview } from "@/components/dashboard/athlete-overview";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import { formatTimeMs } from "@/lib/format";
import type { AgeGroup } from "@/lib/supabase/types";

const CATEGORY_LABELS: Record<AgeGroup, string> = {
  U14: "14 & Under",
  U17: "17 & Under",
  Open: "Open",
};

export default function DashboardPage() {
  const skinsEventId = process.env.NEXT_PUBLIC_SKINS_EVENT_ID ?? null;
  const { boards, loading, error } = useSkinsQualifiers(skinsEventId);


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

      <Card>
        <CardHeader>
          <CardTitle>Qualifier boards</CardTitle>
          <CardDescription>
            Active slots after decline / rollover — up to 6 per category, and men and women fill
            their own separately. Slots are accepted or declined in person at the venue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* The invite card used to carry these; it is gone, so the boards
              own their own loading and error states now rather than failing
              silently to an empty grid. */}
          <DataErrorBanner error={error} subject="Skins qualifiers" />
          {loading && <SkeletonRow />}
        </CardContent>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          {boards.map((board) => (
            <div key={`${board.category}-${board.gender}`} className="rounded-lg border p-3">
              <p className="mb-2 text-sm font-semibold">
                {CATEGORY_LABELS[board.category]} · {board.gender === "male" ? "Men" : "Women"}
              </p>
              <ul className="space-y-1 text-sm">
                {board.active.length === 0 && (
                  <li className="text-muted-foreground">No active qualifiers yet</li>
                )}
                {board.active.map((q) => (
                  <li key={`${q.athleteId}-${q.category}`} className="truncate">
                    #{q.slotNumber} <AthleteLink athleteId={q.athleteId} name={q.athleteName} />{" "}
                    <span className="text-muted-foreground">({q.response})</span>
                  </li>
                ))}
              </ul>
              {board.swimOff && (
                // The last qualifying place is tied. Nobody is listed as
                // holding it until they have raced for it.
                <p className="mt-2 rounded-md border-2 border-border-strong bg-neon-orange/15 p-2 text-xs">
                  <span className="font-bold">Swim-off required.</span>{" "}
                  {board.swimOff.athletes.map((a) => a.athleteName).join(" and ")} are level on{" "}
                  {formatTimeMs(board.swimOff.contestedTimeMs)}, contesting{" "}
                  {board.swimOff.slotsRemaining === 1
                    ? "the last slot"
                    : `${board.swimOff.slotsRemaining} slots`}
                  .
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
      </main>
    </div>
  );
}
