"use client";

import { useEffect, useState } from "react";
import { Loader2, Users } from "lucide-react";
import { PaymentStatusBadge } from "@/components/ui/payment-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkeletonRow } from "@/components/ui/skeleton";
import { getErrorMessage } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  fetchTeamRelaySquadPayments,
  reclaimRelaySquadHold,
  type RelaySquadPayment,
} from "@/lib/relay-payments";
import { formatEgp } from "@/lib/pricing";

/**
 * The captain-facing half of relay billing: what each squad costs, and
 * whether it has been paid — the "Relay payments" section of the Captain
 * Dashboard.
 *
 * Every squad shown here is complete (4/4 legs) — a squad cannot be saved
 * to the database at all until it is, so there is no "in progress, missing
 * a swimmer" state to surface. What a captain needs to see instead is
 * exactly this: which of the team's finished squads are paid, which are
 * still owed, and — for anything sitting on a lapsing hold — how long is
 * left before the slot releases.
 *
 * Confirming payment itself is admin-only (see confirm_relay_squad_payment()
 * in schema.sql) — this view is read-only plus the one captain-side action
 * that IS theirs: reclaiming a slot after a hold has expired.
 */
export function RelayPayments({ teams }: { teams: { id: string; name: string }[] }) {
  const toast = useToast();
  const [teamId, setTeamId] = useState<string>(teams[0]?.id ?? "");
  const [squads, setSquads] = useState<RelaySquadPayment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busySquadId, setBusySquadId] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    let cancelled = false;
    setSquads(null);
    (async () => {
      const result = await fetchTeamRelaySquadPayments(teamId);
      if (cancelled) return;
      setSquads(result.data);
      setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const reload = async () => {
    setSquads(null);
    const result = await fetchTeamRelaySquadPayments(teamId);
    setSquads(result.data);
    setError(result.error);
  };

  const reclaim = async (squad: RelaySquadPayment) => {
    setBusySquadId(squad.squadId);
    try {
      const res = await reclaimRelaySquadHold(squad.squadId);
      if (!res.success) throw new Error(res.error ?? "Could not reclaim this slot.");
      toast.success(
        "Slot reclaimed",
        `${squad.eventName} — Squad ${squad.squadLetter} is held again. Pay at the desk to confirm it.`,
      );
      await reload();
    } catch (err) {
      const message = getErrorMessage(err, "Could not reclaim this slot.");
      toast.error(`Could not reclaim ${squad.eventName} Squad ${squad.squadLetter}`, message);
    } finally {
      setBusySquadId(null);
    }
  };

  if (teams.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-4" />
          Relay payments
        </CardTitle>
        <CardDescription>
          Each relay squad is billed to you, once, as a whole squad — not split across
          the four swimmers on it. Pay at the meet desk; an admin confirms it there.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {teams.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {teams.map((t) => (
              <Button
                key={t.id}
                type="button"
                size="sm"
                variant={t.id === teamId ? "default" : "outline"}
                onClick={() => setTeamId(t.id)}
              >
                {t.name}
              </Button>
            ))}
          </div>
        )}

        <DataErrorBanner error={error} subject="relay payments" />

        {squads === null ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : squads.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No relay squads entered for this team yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {squads.map((squad) => (
              <li
                key={squad.squadId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0">
                  <p className="font-medium">
                    {squad.eventName} — {squad.ageGroup} Squad {squad.squadLetter}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {squad.legsFilled}/4 swimmers assigned
                  </p>
                  {/* Settlement detail, once settled: what was actually
                      collected, by whom, and when. paidAmountEgp is the
                      figure taken at the desk, not a re-quote — the relay
                      price is not tiered and can move. */}
                  {squad.status === "confirmed" && (
                    <p className="text-xs text-muted-foreground">
                      {squad.paidAmountEgp != null ? formatEgp(squad.paidAmountEgp) : "Paid"}
                      {squad.collectedByName ? ` · collected by ${squad.collectedByName}` : ""}
                      {squad.paidAt
                        ? ` · ${new Date(squad.paidAt).toLocaleDateString()}`
                        : ""}
                    </p>
                  )}
                </div>

                {squad.status === "confirmed" ? (
                  <PaymentStatusBadge state="paid" label="Paid" />
                ) : squad.status === "hold_expired" ? (
                  <div className="flex items-center gap-2">
                    <PaymentStatusBadge state="unpaid" label="Slot released — unpaid too long" />
                    <Button
                      type="button"
                      size="sm"
                      className="min-h-[44px] gap-2"
                      disabled={busySquadId === squad.squadId}
                      onClick={() => void reclaim(squad)}
                    >
                      {busySquadId === squad.squadId && (
                        <Loader2 className="size-3.5 animate-spin" />
                      )}
                      Reclaim slot
                    </Button>
                  </div>
                ) : (
                  <PaymentStatusBadge
                    state="pending"
                    label={
                      squad.currentQuoteEgp != null
                        ? `${formatEgp(squad.currentQuoteEgp)} due — pay at the desk`
                        : "Price unavailable"
                    }
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
