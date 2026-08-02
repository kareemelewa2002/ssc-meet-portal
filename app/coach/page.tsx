"use client";

import { AppHeader } from "@/components/layout/app-header";
import { CoachRoster } from "@/components/dashboard/coach-roster";
import { useCurrentUser } from "@/hooks/use-current-user";
import { SkeletonRow } from "@/components/ui/skeleton";

export default function CoachPage() {
  const { user, loading } = useCurrentUser();
  const isCoach = user?.role === "coach";

  return (
    <div className="min-h-screen">
      <AppHeader title="Coach Dashboard" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Coach Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Your team roster, contact details, and entries — tap any swimmer for their full PB ledger.
          </p>
        </header>

        {loading ? (
          <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<SkeletonRow key={i} />))}</div>
        ) : isCoach ? (
          <CoachRoster />
        ) : (
          <p className="text-sm text-muted-foreground">
            This dashboard is only available to Coach accounts. Ask an admin to grant you the Coach
            role if you manage a team.
          </p>
        )}
      </main>
    </div>
  );
}
