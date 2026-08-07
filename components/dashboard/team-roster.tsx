"use client";

import { useEffect, useState } from "react";
import { Loader2, Mail, Phone, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { fetchMyManagedTeam, fetchTeamDetail, type TeamDetail } from "@/lib/teams";
import type { AgeGroup, TeamRow } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { TeamJoinRequests } from "@/components/teams/team-join-requests";
import { DataErrorBanner } from "@/components/ui/data-error-banner";

/**
 * Coach-facing team roster — manage the team roster, view members' contact
 * details, and track entries/results. Rather than duplicate entries/results
 * aggregation, each roster member links straight to their existing public
 * athlete profile (/athletes/[id]), which already renders the full career
 * ledger (PBs and every entry).
 */
export function TeamRoster({ className }: { className?: string }) {
  const [team, setTeam] = useState<TeamRow | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const myTeam = await fetchMyManagedTeam();
      if (cancelled) return;
      setTeam(myTeam.data);
      setDataError(myTeam.error);
      if (myTeam.data) {
        const d = await fetchTeamDetail(myTeam.data.id);
        if (!cancelled) {
          setDetail(d.data);
          if (d.error) setDataError(d.error);
        }
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
          Loading your team roster…
        </CardContent>
      </Card>
    );
  }

  if (!team) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Team roster</CardTitle>
          {!dataError && (
            <CardDescription>
              You&rsquo;re not currently registered as a team captain — ask an admin to assign you to a
              team&rsquo;s captain_id, or create a new team from the Teams page.
            </CardDescription>
          )}
        </CardHeader>
        {dataError && (
          <CardContent>
            <DataErrorBanner error={dataError} subject="your team roster" />
          </CardContent>
        )}
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
            {team.approved_by_admin ? "Approved Team" : "Pending Admin Approval"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataErrorBanner error={dataError} subject="your team roster" />
        <TeamJoinRequests teamId={team.id} />
        {roster.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="size-4" />
            No swimmers currently listed under this team.
          </p>
        ) : (
          roster.map((member) => (
            <div key={member.athleteId} className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <AthleteLink athleteId={member.athleteId} name={member.fullName} className="truncate" />
                <div className="flex shrink-0 gap-1.5">
                  <Badge variant="outline">{AGE_GROUP_LABELS[member.ageGroup as AgeGroup]}</Badge>
                  <Badge variant="outline" className="capitalize">
                    {member.gender}
                  </Badge>
                </div>
              </div>
              {/* Contact chips render only for viewers public.visible_contacts()
                  cleared — same team, or a pending join-request counterparty. */}
              {(member.email || member.phone) && (
                <div className="flex flex-wrap gap-x-2 gap-y-1.5">
                  {member.email && (
                    <a
                      href={`mailto:${member.email}`}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border-2 border-border-strong bg-background px-2.5 text-xs font-semibold shadow-brutal-sm transition-all hover:bg-muted active:translate-y-[2px] active:shadow-none"
                    >
                      <Mail className="size-3.5" />
                      {member.email}
                    </a>
                  )}
                  {member.phone && (
                    <a
                      href={`tel:${member.phone}`}
                      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border-2 border-border-strong bg-background px-2.5 text-xs font-semibold shadow-brutal-sm transition-all hover:bg-muted active:translate-y-[2px] active:shadow-none"
                    >
                      <Phone className="size-3.5" />
                      {member.phone}
                    </a>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
