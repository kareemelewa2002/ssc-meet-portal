"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard, Trophy, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PaymentStatusBadge } from "@/components/ui/payment-status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { MyRaces } from "@/components/dashboard/my-races";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fetchMyJoinRequest, cancelJoinRequest, type MyJoinRequest } from "@/lib/team-memberships";
import {
  fetchMyIncomingInvitation,
  respondToInvitation,
  type MyIncomingInvitation,
} from "@/lib/team-invites";
import { fetchMyEntryPaymentStatus, type AthletePaymentStatus } from "@/lib/payments";
import { fetchActiveVolume } from "@/lib/volumes";
import { formatEgp, priceLineKindLabel } from "@/lib/pricing";
import { PRICING_TIER_LABELS } from "@/lib/meet-settings";

/**
 * Everything the signed-in ATHLETE needs, as one block: their team standing
 * (current team, an outgoing join request, an incoming invitation), their
 * races and heat/lane assignments, their entry payment status, and the way
 * through to their results and leaderboard placements.
 *
 * Extracted from /dashboard so /captain can render the same thing. A captain
 * IS an athlete — captaincy is teams.captain_id, not a role — so they enter
 * races, get seeded into heats and owe entry fees exactly like anyone else.
 * Before this, none of that was reachable from the captain's own dashboard;
 * they had to know to go somewhere else for the half of the meet that is
 * about them rather than their team.
 *
 * `hideTeamLink` exists because the captain dashboard reaches the same roster
 * by its own route, and offering both side by side is the same destination
 * under two labels.
 */
export function AthleteOverview({ hideTeamLink }: { hideTeamLink?: boolean } = {}) {
  const { user, loading: userLoading } = useCurrentUser();

  const [myAthleteId, setMyAthleteId] = useState<string | null>(null);
  const [onTeam, setOnTeam] = useState(false);
  const [joinRequest, setJoinRequest] = useState<MyJoinRequest | null>(null);
  const [incomingInvite, setIncomingInvite] = useState<MyIncomingInvitation | null>(null);
  const [cancellingRequest, setCancellingRequest] = useState(false);
  const [respondingToInvite, setRespondingToInvite] = useState(false);
  const [payments, setPayments] = useState<AthletePaymentStatus[] | null>(null);
  const [volume, setVolume] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (userLoading) return;
    let cancelled = false;
    (async () => {
      if (!user) {
        setLoading(false);
        return;
      }
      const supabase = createClient();
      const { data: athlete } = await supabase
        .from("athletes")
        .select("id, team_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      const athleteId = (athlete as { id: string } | null)?.id ?? null;
      const teamId = (athlete as { team_id: string | null } | null)?.team_id ?? null;
      setMyAthleteId(athleteId);
      setOnTeam(!!teamId);

      const [request, invite, paymentStatus, activeVolume] = await Promise.all([
        teamId ? Promise.resolve(null) : fetchMyJoinRequest(user.id),
        teamId ? Promise.resolve(null) : fetchMyIncomingInvitation(user.id),
        athleteId ? fetchMyEntryPaymentStatus(athleteId) : Promise.resolve(null),
        fetchActiveVolume(),
      ]);
      if (cancelled) return;
      setJoinRequest(request);
      setIncomingInvite(invite);
      if (paymentStatus) setPayments(paymentStatus.data);
      if (activeVolume.data) {
        setVolume({ id: activeVolume.data.id, name: activeVolume.data.name });
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

  async function handleCancelRequest() {
    if (!joinRequest) return;
    setCancellingRequest(true);
    await cancelJoinRequest(joinRequest.id);
    setJoinRequest(null);
    setCancellingRequest(false);
  }

  async function handleInviteResponse(decision: "accept" | "decline") {
    if (!incomingInvite) return;
    setRespondingToInvite(true);
    const result = await respondToInvitation(incomingInvite.id, decision);
    setRespondingToInvite(false);
    if (result.success) {
      setIncomingInvite(null);
      if (decision === "accept") setOnTeam(true);
    }
  }

  return (
    <>
      {myAthleteId && (
        <Button
          variant="outline"
          nativeButton={false}
          className="min-h-[48px] w-full justify-start gap-2"
          render={<Link href={`/athletes/${myAthleteId}`} />}
        >
          <Trophy className="size-4" />
          My results, PBs &amp; leaderboard placements
        </Button>
      )}

      {loading ? (
        <SkeletonRow />
      ) : (
        <>
          {/* Suppressed on /captain: /dashboard/team is documented as "the
              athlete-facing mirror of /captain/roster — same roster +
              contact-info data", so on the captain dashboard this is a third
              route to a roster that page already links to. */}
          {onTeam && !hideTeamLink && (
            <Button
              variant="outline"
              nativeButton={false}
              className="min-h-[48px] w-full justify-start gap-2"
              render={<Link href="/dashboard/team" />}
            >
              <Users className="size-4" />
              My team — roster &amp; contacts
            </Button>
          )}

          {!onTeam && joinRequest && (
            <Card>
              <CardHeader>
                <CardTitle>Your join request</CardTitle>
                <CardDescription>
                  Waiting on {joinRequest.teamName}&rsquo;s captain to respond.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button
                  type="button"
                  variant="outline"
                  disabled={cancellingRequest}
                  onClick={handleCancelRequest}
                >
                  Cancel Request
                </Button>
              </CardContent>
            </Card>
          )}

          {!onTeam && incomingInvite && (
            <Card>
              <CardHeader>
                <CardTitle>Team invitation</CardTitle>
                <CardDescription>
                  {incomingInvite.teamName} invited you to join their roster.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex gap-2">
                <Button
                  type="button"
                  disabled={respondingToInvite}
                  onClick={() => handleInviteResponse("accept")}
                >
                  Accept
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={respondingToInvite}
                  onClick={() => handleInviteResponse("decline")}
                >
                  Decline
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {myAthleteId && volume && (
        <MyRaces athleteId={myAthleteId} meetVolumeId={volume.id} volumeName={volume.name} />
      )}

      {payments && payments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="size-4" />
              Payment status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {payments.map((p) => (
              <div key={p.meetVolumeId} className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{p.volumeName}</p>
                    {p.tier && (
                      <p className="text-xs text-muted-foreground">
                        {PRICING_TIER_LABELS[p.tier]} rate
                      </p>
                    )}
                  </div>
                  <div className="space-y-1 text-right">
                    <p className="font-mono text-sm font-bold">{formatEgp(p.totalEgp)}</p>
                    <PaymentStatusBadge
                      state={p.confirmed ? "paid" : "pending"}
                      label={p.confirmed ? "Paid" : "Pending — cash at desk"}
                    />
                  </div>
                </div>

                {/* What the money is for, in BOTH states — a live quote while
                    pending, the receipt as written at the desk once paid.
                    A swimmer who has already handed over cash is the one most
                    likely to want to check what it covered. */}
                {p.lines && p.lines.length > 0 && (
                  <ul className="space-y-0.5 border-t pt-2">
                    {p.lines.map((line, i) => (
                      <li
                        key={`${line.kind}-${line.entryId ?? i}`}
                        className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                      >
                        <span className="truncate">
                          {priceLineKindLabel(line.kind)} — {line.label}
                        </span>
                        <span className="shrink-0 font-mono">{formatEgp(line.amountEgp)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Who took the money and when, once it has been taken. */}
                {p.confirmed && (p.collectedByName || p.collectedAt) && (
                  <p className="border-t pt-2 text-xs text-muted-foreground">
                    {p.collectedByName ? `Collected by ${p.collectedByName}` : "Collected"}
                    {/* collected_at is a timestamptz — a real instant — so the
                        viewer's local zone is the right rendering. */}
                    {p.collectedAt && ` · ${new Date(p.collectedAt).toLocaleDateString()}`}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </>
  );
}
