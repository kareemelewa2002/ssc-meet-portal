"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Mail, Users } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { TeamJoinRequests } from "@/components/teams/team-join-requests";
import { RelayBuilder } from "@/components/captain/relay-builder";
import { RelayPayments } from "@/components/captain/relay-payments";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { fetchCaptainedTeams } from "@/lib/relays";
import { AthleteOverview } from "@/components/dashboard/athlete-overview";
import { useCurrentUser } from "@/hooks/use-current-user";

/**
 * Team captain dashboard.
 *
 * Captaincy is a RELATIONSHIP (teams.captain_id), not a role — the 'coach'
 * role was retired precisely because a role said someone could captain in the
 * abstract while the team pointer said who actually did. So this page gates on
 * "does any team point at me", which is exactly what the RLS policies check.
 */
export default function CaptainPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [teams, setTeams] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (userLoading) return;
    let cancelled = false;
    (async () => {
      const res = await fetchCaptainedTeams(user?.id);
      if (cancelled) return;
      setTeams(res.data);
      setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

  return (
    <div className="min-h-screen">
      <AppHeader title="Captain Dashboard" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Captain Dashboard</h1>
          {/* Which team this dashboard is ABOUT. It used to be visible only
              as a side effect of the inline <TeamRoster /> card; removing
              that duplicate roster took the team's name off the page
              entirely, leaving a captain no on-screen confirmation of which
              roster they were acting on. RelayPayments does render team
              names, but only behind a teams.length > 1 picker — and a
              captain captains exactly one team, so it never showed. */}
          {teams && teams.length > 0 && (
            <p className="text-base font-bold">{teams.map((t) => t.name).join(" · ")}</p>
          )}
          <p className="text-sm text-muted-foreground">
            Your own races and payments, plus your team&rsquo;s roster, invitations and relay
            squads. Tap any swimmer for their full PB ledger.
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
            <div className="grid grid-cols-2 gap-3">
              <Link
                href="/captain/roster"
                className="flex min-h-[64px] items-center gap-3 rounded-2xl border-brutal bg-card p-3 shadow-brutal-sm transition-colors hover:bg-muted/50"
              >
                <Users className="size-5 shrink-0" />
                <span className="text-sm font-bold">Roster &amp; Contacts</span>
              </Link>
              <Link
                href="/captain/invitations"
                className="flex min-h-[64px] items-center gap-3 rounded-2xl border-brutal bg-card p-3 shadow-brutal-sm transition-colors hover:bg-muted/50"
              >
                <Mail className="size-5 shrink-0" />
                <span className="text-sm font-bold">Invite Athletes</span>
              </Link>
            </div>
            {/* Join requests only, not the whole <TeamRoster />. That
                component IS /captain/roster (linked directly above), so
                rendering it here too put the same roster on screen twice —
                once inline and once a tap away. The approve/reject queue is
                the part that genuinely belongs on the dashboard. */}
            {teams.map((team) => (
              <TeamJoinRequests key={team.id} teamId={team.id} />
            ))}
            {/* A captain competes too — captaincy is teams.captain_id, not a
                role — so their own entries, heat assignments and entry fees
                belong here rather than only on /dashboard. Same component
                the athlete dashboard renders, not a second copy.
                hideTeamLink: its /dashboard/team button is the athlete-facing
                mirror of /captain/roster, already linked at the top of this
                page. */}
            <AthleteOverview hideTeamLink />
            {/* Payments above the builder: what a captain owes, and who
                collected it, is the thing they come here to check before the
                meet — building a squad is a once-per-cycle task. */}
            <RelayPayments teams={teams} />
            <RelayBuilder teams={teams} />
          </>
        )}
      </main>
    </div>
  );
}
