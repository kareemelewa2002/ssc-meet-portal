"use client";

import { TeamLeaderboard } from "@/components/leaderboards/team-leaderboard";
import { AllTimeBoards } from "@/components/leaderboards/all-time-boards";
import { AppHeader } from "@/components/layout/app-header";

/**
 * Standalone All-Time Records page. The boards themselves live in
 * AllTimeBoards so the main Leaderboards page can offer the same three
 * options — this page is now just the framing around them, and exists so
 * existing links keep working.
 */
export function AllTimeClient() {
  return (
    <div className="min-h-screen">
      <AppHeader title="All-Time Records" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
        {/* Back to /leaderboards is AppHeader's job — see lib/nav-hierarchy.ts. */}
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">All-Time SSC Records</h1>
          <p className="text-sm text-muted-foreground">
            Best performers (by swimmer), best performances (by race time), and best performance
            by World Aquatics points — across every volume.
          </p>
        </header>

        <AllTimeBoards />

        <TeamLeaderboard />
      </main>
    </div>
  );
}
