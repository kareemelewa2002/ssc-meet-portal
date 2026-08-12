"use client";

import { useEffect, useState } from "react";
import { Loader2, Mail, Phone, Users } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { fetchTeamDetail, type TeamDetail } from "@/lib/teams";
import { createClient } from "@/lib/supabase/client";
import type { AgeGroup } from "@/lib/supabase/types";

/**
 * The athlete-facing mirror of /captain/roster — same roster + contact-info
 * data (fetchTeamDetail), read-only, reached once a join request or invite
 * has been accepted. No captain actions here (no join-request queue, no
 * invite management) since this athlete is a member, not the captain.
 */
export default function DashboardTeamPage() {
  const [teamName, setTeamName] = useState<string | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) setLoading(false);
        return;
      }
      const { data: athlete, error } = await supabase
        .from("athletes")
        .select("team_id, teams ( name )")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setDataError(error.message);
        setLoading(false);
        return;
      }
      const teamId = (athlete as { team_id: string | null } | null)?.team_id ?? null;
      const teams = (athlete as { teams: { name: string } | { name: string }[] | null } | null)
        ?.teams;
      const name = Array.isArray(teams) ? (teams[0]?.name ?? null) : (teams?.name ?? null);
      setTeamName(name);
      if (teamId) {
        const result = await fetchTeamDetail(teamId);
        if (!cancelled) {
          setDetail(result.data);
          if (result.error) setDataError(result.error);
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const roster = detail?.roster ?? [];

  return (
    <div className="min-h-screen">
      <AppHeader title="My Team" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        {/* Back to /dashboard is AppHeader's job — see lib/nav-hierarchy.ts. */}

        <DataErrorBanner error={dataError} subject="your team" />

        {loading ? (
          <Card>
            <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading your team…
            </CardContent>
          </Card>
        ) : !teamName ? (
          <Card>
            <CardHeader>
              <CardTitle>My Team</CardTitle>
              <CardDescription>
                You&rsquo;re not on a team yet. Request to join one, or accept an invitation, from
                the Dashboard or the Teams page.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>{teamName}</CardTitle>
              <CardDescription>
                {roster.length} {roster.length === 1 ? "swimmer" : "swimmers"} on the roster. Tap a
                name for their full entry &amp; results history.
              </CardDescription>
              {detail?.captain && (
                <p className="text-xs text-muted-foreground">Captain: {detail.captain.fullName}</p>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              {roster.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Users className="size-4" />
                  No swimmers currently listed under this team.
                </p>
              ) : (
                roster.map((member) => (
                  <div key={member.athleteId} className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <AthleteLink
                        athleteId={member.athleteId}
                        name={member.fullName}
                        className="truncate"
                      />
                      <div className="flex shrink-0 gap-1.5">
                        <Badge variant="outline">{AGE_GROUP_LABELS[member.ageGroup as AgeGroup]}</Badge>
                        <Badge variant="outline" className="capitalize">
                          {member.gender}
                        </Badge>
                      </div>
                    </div>
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
        )}
      </main>
    </div>
  );
}
