"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { useToast } from "@/hooks/use-toast";
import {
  acceptSafetyAcknowledgement,
  fetchPendingSafetyAcceptances,
  type PendingSafetyAcceptance,
} from "@/lib/safety";

/**
 * The parent's half of the safety & privacy acknowledgement.
 *
 * A U14 cannot accept this for themselves — the registration form refuses,
 * and public.accept_safety_acknowledgement() refuses again at the database,
 * because a client-side check would be bypassable on exactly the population
 * the rule exists to protect. This screen is the only place that acceptance
 * can legitimately happen, and it is scoped by RLS to the swimmers linked to
 * the signed-in parent.
 */
export function SafetyAcceptances({ className }: { className?: string }) {
  const toast = useToast();
  const [pending, setPending] = useState<PendingSafetyAcceptance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  const load = useCallback(async () => {
    const res = await fetchPendingSafetyAcceptances();
    setPending(res.data);
    setError(res.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accept = async (row: PendingSafetyAcceptance) => {
    setBusyId(row.athleteId);
    try {
      const res = await acceptSafetyAcknowledgement(row.athleteId);
      if (!res.success) {
        toast.error("Couldn't record the acknowledgement", res.error);
        return;
      }
      setPending((prev) => (prev ?? []).filter((p) => p.athleteId !== row.athleteId));
      setAccepted(true);
      toast.success("Acknowledgement recorded", `${row.fullName} can now register for meets.`);
    } finally {
      setBusyId(null);
    }
  };

  // Nothing outstanding and nothing just actioned — stay out of the way.
  if (!error && pending !== null && pending.length === 0 && !accepted) return null;

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4 text-neon-orange" />
          Safety & privacy acknowledgement
        </CardTitle>
        <CardDescription>
          Swimmers under 15 cannot accept this themselves. As their parent or guardian you must
          accept it before they can register for a meet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <DataErrorBanner error={error} subject="safety acknowledgements" onRetry={() => void load()} />

        {pending === null ? (
          <SkeletonRow />
        ) : pending.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All of your swimmers are acknowledged. Nothing outstanding.
          </p>
        ) : (
          <>
            <div className="rounded-xl border-2 border-black bg-muted/40 p-3 text-sm">
              I confirm that my child is <strong>fully responsible for their own safety and for
              their personal belongings</strong> on event days, and that SSC accepts no liability
              for loss, damage or injury at the venue. I also agree that their name, age group,
              team and race results are shown publicly.
            </div>

            {pending.map((row) => (
              <div
                key={row.athleteId}
                className="flex flex-col gap-2 rounded-xl border-2 border-black p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="truncate font-bold">{row.fullName}</p>
                  <p className="text-xs text-muted-foreground">{row.ageGroup} · awaiting your acceptance</p>
                </div>
                <Button
                  type="button"
                  className="min-h-[48px] gap-2"
                  disabled={busyId === row.athleteId}
                  onClick={() => void accept(row)}
                >
                  {busyId === row.athleteId ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  Accept for {row.fullName.split(" ")[0]}
                </Button>
              </div>
            ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
