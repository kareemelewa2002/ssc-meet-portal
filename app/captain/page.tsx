"use client";

import { useEffect, useState } from "react";
import { AppHeader } from "@/components/layout/app-header";
import { TeamRoster } from "@/components/dashboard/team-roster";
import { RelayBuilder } from "@/components/captain/relay-builder";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { fetchCaptainedTeams } from "@/lib/relays";

/**
 * Team captain dashboard.
 *
 * Captaincy is a RELATIONSHIP (teams.captain_id), not a role — the 'coach'
 * role was retired precisely because a role said someone could captain in the
 * abstract while the team pointer said who actually did. So this page gates on
 * "does any team point at me", which is exactly what the RLS policies check.
 */
export default function CaptainPage() {
  const [teams, setTeams] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchCaptainedTeams();
      if (cancelled) return;
      setTeams(res.data);
      setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen">
      <AppHeader title="Captain Dashboard" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Captain Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Your team roster and relay squads. Tap any swimmer for their full PB ledger.
          </p>
        </header>

        <DataErrorBanner error={error} subject="your teams" />

        {teams === null ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This dashboard is for team captains. No team currently lists you as its captain — ask
            an admin to set you as one.
          </p>
        ) : (
          <>
            <RelayBuilder teams={teams} />
            <TeamRoster />
          </>
        )}
      </main>
    </div>
  );
}
