"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Mail, Phone, UserMinus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import {
  fetchMyManagedTeam,
  fetchTeamDetail,
  removeTeamMember,
  type TeamDetail,
  type TeamRosterMember,
} from "@/lib/teams";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
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
export function TeamRoster({
  className,
  hideJoinRequests,
}: {
  className?: string;
  /** /captain/roster reuses this component for the roster+contacts view
   * only — join requests already have their own place on the main captain
   * dashboard, so showing them again here would just be the same queue
   * rendered twice. */
  hideJoinRequests?: boolean;
}) {
  const toast = useToast();
  const [team, setTeam] = useState<TeamRow | null>(null);
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  // The member awaiting confirmation. Holding the whole row rather than an id
  // lets the dialog name them without looking the row up again.
  const [pendingRemoval, setPendingRemoval] = useState<TeamRosterMember | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    const myTeam = await fetchMyManagedTeam();
    setTeam(myTeam.data);
    setDataError(myTeam.error);
    if (myTeam.data) {
      const d = await fetchTeamDetail(myTeam.data.id);
      setDetail(d.data);
      if (d.error) setDataError(d.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmRemoval = async () => {
    if (!pendingRemoval || !team) return;
    setRemoving(true);
    try {
      const res = await removeTeamMember(pendingRemoval.athleteId);
      if (!res.success) {
        // Surfaced verbatim: captain_remove_team_member() raises specific,
        // actionable messages — notably "still in N relay squads", which tells
        // the captain exactly what to do next.
        toast.error("Could not remove swimmer", res.error);
        return;
      }
      toast.success(
        "Swimmer removed",
        `${pendingRemoval.fullName} is no longer on ${team.name}.`,
      );
      setPendingRemoval(null);
      // Re-read rather than splicing the row out locally: removal also clears
      // their membership record, and a refetch is the only thing that can
      // show the true post-removal state.
      await load();
    } finally {
      setRemoving(false);
    }
  };

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
        {!hideJoinRequests && <TeamJoinRequests teamId={team.id} />}
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
                <div className="flex shrink-0 items-center gap-1.5">
                  <Badge variant="outline">{AGE_GROUP_LABELS[member.ageGroup as AgeGroup]}</Badge>
                  <Badge variant="outline" className="capitalize">
                    {member.gender}
                  </Badge>
                  {/* Never on the captain's own row — a captain dropping
                      themselves would leave the team with a captain_id
                      pointing at someone no longer on it. The database
                      refuses this too (captain_remove_team_member); hiding it
                      here means the captain is never offered an action that
                      cannot succeed. */}
                  {member.userId && member.userId !== detail?.captainUserId && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-9 min-h-[44px] min-w-[44px] text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${member.fullName} from ${team.name}`}
                      onClick={() => setPendingRemoval(member)}
                    >
                      <UserMinus className="size-4" />
                    </Button>
                  )}
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

      <Dialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => !open && !removing && setPendingRemoval(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {pendingRemoval?.fullName}?</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove {pendingRemoval?.fullName} from {team.name}? This
              revokes their team membership — they will no longer appear on your roster and can
              request to join another team.
            </DialogDescription>
          </DialogHeader>
          {/* Said plainly, because it is the question a captain will actually
              have. Removal clears the CURRENT roster only; per-volume
              affiliations are kept, so past results still show the team they
              were swum for. */}
          <p className="text-sm text-muted-foreground">
            Races they have already swum keep the team they swam for — this does not rewrite meet
            history.
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingRemoval(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={confirmRemoval}
              disabled={removing}
              className="gap-2"
            >
              {removing && <Loader2 className="size-4 animate-spin" />}
              Remove from team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
