"use client";

import { AppHeader } from "@/components/layout/app-header";
import { AthleteDirectory } from "@/components/athletes/athlete-directory";

export default function AthletesDirectoryPage() {
  return (
    <div className="min-h-screen">
      <AppHeader title="Athlete Directory" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">All athletes</h1>
          <p className="text-sm text-muted-foreground">
            Search the SSC roster by name or team. Tap a card for the full public profile.
          </p>
        </header>

        <AthleteDirectory />
      </main>
    </div>
  );
}
