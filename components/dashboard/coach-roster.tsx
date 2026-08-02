"use client";

import { useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { fetchMyManagedTeam, fetchTeamDetail, type TeamDetail } from "@/lib/teams";
import type { AgeGroup, TeamRow } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";

/**
 * Coach-facing club roster — "manage club roster, view team members, track
 * athlete entries and results" (AGENTS scope lock, role #3). Rather than
 * duplicate entries/results aggregation, each roster member links straight
 * to their existing public athlete profile (/athletes/[id]), which already
 * renders the full career ledger.
 */
export function CoachRoster({ className }: { className?: string }) {
  const [team, setTeam] = useState<TeamRow | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const myTeam = await fetchMyManagedTeam();
      if (cancelled) return;
      setTeam(myTeam);
      if (myTeam) {
        const d = await fetchTeamDetail(myTeam.id);
        if (!cancelled) setDetail(d);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <Card className={className}>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading your club roster…
        </CardContent>
      </Card>
    );
  }

  if (!team) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Club roster</CardTitle>
          <CardDescription>
            You&rsquo;re not currently registered as a club captain — ask an admin to assign you to a
            club&rsquo;s captain_id, or create a new club from the Teams page.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const roster = detail?.roster ?? [];

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle>{team.name}</CardTitle>
            <CardDescription>
              {roster.length} {roster.length === 1 ? "swimmer" : "swimmers"} on your roster. Tap a name for
              their full entry & results history.
            </CardDescription>
          </div>
          <Badge variant={team.approved_by_admin ? "default" : "outline"}>
            {team.approved_by_admin ? "Approved Club" : "Pending Admin Approval"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {roster.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="size-4" />
            No swimmers currently listed under this club.
          </p>
        ) : (
          roster.map((member) => (
            <div
              key={member.athleteId}
              className="flex min-h-[48px] items-center justify-between gap-3 rounded-lg border p-3"
            >
              <AthleteLink athleteId={member.athleteId} name={member.fullName} className="truncate" />
              <div className="flex shrink-0 gap-1.5">
                <Badge variant="outline">{AGE_GROUP_LABELS[member.ageGroup as AgeGroup]}</Badge>
                <Badge variant="outline" className="capitalize">
                  {member.gender}
                </Badge>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
