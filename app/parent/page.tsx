"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard, Trophy } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { SafetyAcceptances } from "@/components/parent/safety-acceptances";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { fetchMyLinkedChildren, type LinkedChildCard } from "@/lib/parents";
import { MyRaces } from "@/components/dashboard/my-races";
import { fetchActiveVolume } from "@/lib/volumes";
import { useCurrentUser } from "@/hooks/use-current-user";
import { fetchMyEntryPaymentStatus, type AthletePaymentStatus } from "@/lib/payments";
import { formatEgp } from "@/lib/pricing";
import type { AgeGroup } from "@/lib/supabase/types";

/**
 * The parent dashboard — the one thing that never existed before: an index
 * of every linked child (athletes.parent_id), since a parent can have more
 * than one competing (e2e fixtures already assume up to 4). Each child's
 * full results/PBs/leaderboard placements already live at their real
 * /athletes/[id] profile — this page links out to that rather than
 * duplicating it per child, exactly like the athlete's own "My results"
 * link on /dashboard does for themselves.
 */
export default function ParentDashboardPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [children, setChildren] = useState<LinkedChildCard[] | null>(null);
  const [payments, setPayments] = useState<Map<string, AthletePaymentStatus[]>>(new Map());
  const [volume, setVolume] = useState<{ id: string; name: string } | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    if (userLoading) return;
    let cancelled = false;
    (async () => {
      const [result, activeVolume] = await Promise.all([
        fetchMyLinkedChildren(user?.id),
        fetchActiveVolume(),
      ]);
      if (cancelled) return;
      setChildren(result.data);
      setDataError(result.error);
      if (activeVolume.data) {
        setVolume({ id: activeVolume.data.id, name: activeVolume.data.name });
      }

      const entries = await Promise.all(
        result.data.map(async (child) => [child.athleteId, (await fetchMyEntryPaymentStatus(child.athleteId)).data] as const),
      );
      if (!cancelled) setPayments(new Map(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userLoading]);

  return (
    <div className="min-h-screen">
      <AppHeader title="Parent Dashboard" />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Parent Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Every child linked to your account — their races and heat assignments, results, and
            payment status.
          </p>
        </header>

        {/* Renders nothing when there are no outstanding U14 acknowledgements. */}
        <SafetyAcceptances />

        <DataErrorBanner error={dataError} subject="your linked children" />

        {children === null ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : children.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No children are linked to your account yet. A swimmer under 15 links to you by naming
            your email at sign-up.
          </p>
        ) : (
          children.map((child) => {
            const childPayments = payments.get(child.athleteId) ?? [];
            return (
              <Card key={child.athleteId}>
                <CardHeader className="flex-row items-center gap-3 space-y-0">
                  <Avatar className="size-12">
                    <AvatarFallback>{child.fullName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate">{child.fullName}</CardTitle>
                    <CardDescription>
                      {AGE_GROUP_LABELS[child.ageGroup as AgeGroup]} · {child.teamName ?? "Unattached"}
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Link
                    href={`/athletes/${child.athleteId}`}
                    className="flex min-h-[44px] items-center gap-2 rounded-lg border-2 border-border-strong px-3 text-sm font-bold hover:bg-muted"
                  >
                    <Trophy className="size-4" />
                    Results, PBs &amp; leaderboard placements
                  </Link>

                  {/* Per child, not aggregated: a parent with several
                      swimmers needs to know which of THEM is in heat 3, and
                      one merged list would not answer that. */}
                  {volume && (
                    <MyRaces
                      athleteId={child.athleteId}
                      meetVolumeId={volume.id}
                      volumeName={volume.name}
                      title={`${child.fullName.split(" ")[0]}'s races`}
                    />
                  )}

                  {childPayments.length > 0 && (
                    <div className="space-y-2">
                      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        <CreditCard className="size-3.5" />
                        Payment status
                      </p>
                      {childPayments.map((p) => (
                        <div
                          key={p.meetVolumeId}
                          className="flex items-center justify-between gap-2 rounded-lg border p-2.5"
                        >
                          <p className="text-sm font-semibold">{p.volumeName}</p>
                          <div className="text-right">
                            <p className="font-mono text-sm font-bold">{formatEgp(p.totalEgp)}</p>
                            <Badge variant={p.confirmed ? "default" : "outline"}>
                              {p.confirmed ? "Confirmed" : "Pending"}
                            </Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })
        )}
      </main>
    </div>
  );
}
