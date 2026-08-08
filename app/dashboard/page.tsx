"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkinsQualificationModal } from "@/components/dashboard/skins-qualification-modal";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { AppHeader } from "@/components/layout/app-header";
import { AthleteOverview } from "@/components/dashboard/athlete-overview";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import type { SkinsCandidate } from "@/lib/skins-qualification";
import { formatTimeMs } from "@/lib/format";
import type { AgeGroup } from "@/lib/supabase/types";

const CATEGORY_LABELS: Record<AgeGroup, string> = {
  U14: "14 & Under",
  U17: "17 & Under",
  Open: "Open",
};

/** Demo invitation used when Supabase is not configured / RPC returns empty. */
const DEMO_INVITE: SkinsCandidate = {
  athleteId: "demo-athlete",
  athleteName: "Leo Fontaine",
  teamName: "Tidal Wave",
  category: "Open",
  gender: "male",
  sourceRank: 4,
  bestTimeMs: 28500,
  response: "pending",
};

export default function DashboardPage() {
  const skinsEventId = process.env.NEXT_PUBLIC_SKINS_EVENT_ID ?? null;
  const { boards, candidates, loading, error, respond } = useSkinsQualifiers(skinsEventId);
  const [modalOpen, setModalOpen] = useState(false);

  const myInvite = useMemo(() => {
    const pending = candidates.find((c) => c.response === "pending");
    return pending ?? candidates[0] ?? DEMO_INVITE;
  }, [candidates]);


  return (
    <div className="min-h-screen">
      <AppHeader title="Dashboard" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <header className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Athlete Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Your team, races, heat assignments and payments — plus Skins, which is assigned from
            official meet results rather than via event registration.
          </p>
        </div>
        <Button
          variant="outline"
          nativeButton={false}
          className="min-h-[48px] gap-2"
          render={<Link href="/dashboard/teams" />}
        >
          <Users className="size-4" />
          My Teams
        </Button>
      </header>

      <AthleteOverview />

      <Card>
        <CardHeader>
          <CardTitle>Session 3 Skins invite</CardTitle>
          <CardDescription>
            Accept to confirm your heat-sheet slot, or decline to roll the invitation to the next
            fastest swimmer in your category.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading && <p className="text-sm text-muted-foreground">Loading qualifiers…</p>}
          {error && (
            <p className="text-sm text-muted-foreground">
              Live qualifiers unavailable ({error}). Showing demo invite for UI review.
            </p>
          )}

          <div className="rounded-lg border p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold">{myInvite.athleteName}</p>
                {myInvite.teamName && (
                  <p className="text-sm text-muted-foreground">{myInvite.teamName}</p>
                )}
              </div>
              <Badge variant="secondary">{CATEGORY_LABELS[myInvite.category]}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Rank #{myInvite.sourceRank} · {(myInvite.bestTimeMs / 1000).toFixed(2)}s ·{" "}
              {myInvite.response}
            </p>
          </div>

          <Button
            type="button"
            className="min-h-[48px] w-full sm:w-auto"
            onClick={() => setModalOpen(true)}
          >
            Accept or decline Skins slot
          </Button>

          <SkinsQualificationModal
            invitation={myInvite}
            open={modalOpen}
            onOpenChange={setModalOpen}
            onRespond={async (athleteId, category, response) => {
              if (!skinsEventId || myInvite.athleteId === "demo-athlete") {
                // Local demo path — mutate is handled by closing after "success".
                return;
              }
              await respond(athleteId, category, response);
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Qualifier boards</CardTitle>
          <CardDescription>
            Active slots after decline / rollover — up to 6 per category, and men and women fill
            their own separately.
          </CardDescription>
        </CardHeader>
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
