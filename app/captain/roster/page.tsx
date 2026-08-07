"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { TeamRoster } from "@/components/dashboard/team-roster";

/**
 * The captain's dedicated roster + contact-info page — split out from the
 * main /captain dashboard (which keeps join requests, relay squads and
 * relay payments) so "who's on my team, how do I reach them" has its own
 * reachable place, per the standing request. Join requests are hidden here
 * (they already have a home on the main dashboard) so the same queue isn't
 * rendered twice.
 */
export default function CaptainRosterPage() {
  return (
    <div className="min-h-screen">
      <AppHeader title="Team Roster" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <Link
          href="/captain"
          className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Captain Dashboard
        </Link>
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Roster &amp; Contacts</h1>
          <p className="text-sm text-muted-foreground">
            Every swimmer currently on your team, with contact info where you&rsquo;re permitted to see
            it.
          </p>
        </header>
        <TeamRoster hideJoinRequests />
      </main>
    </div>
  );
}
