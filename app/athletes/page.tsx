"use client";

import Link from "next/link";
import { Trophy } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { AthleteDirectory } from "@/components/athletes/athlete-directory";

export default function AthletesDirectoryPage() {
  return (
    <div className="min-h-screen">
      <AppHeader title="Athlete Directory" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-2xl font-bold tracking-tight">All athletes</h1>
            <Link
              href="/leaderboards/all-time"
              className="inline-flex min-h-[48px] items-center justify-center rounded-lg border-2 border-black px-3 text-sm font-medium hover:bg-muted"
            >
              <Trophy className="mr-2 size-4" />
              All-Time Records
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            Search the SSC roster by name or team. Tap a card for the full public profile.
          </p>
        </header>

        <AthleteDirectory />
      </main>
    </div>
  );
}
