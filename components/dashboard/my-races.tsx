"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Waves } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  PaymentStatusBadge,
  paymentStateForEntry,
} from "@/components/ui/payment-status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { formatTimeMs } from "@/lib/format";
import {
  heatAssignmentVisibility,
  PENDING_SEEDING_LABEL,
} from "@/lib/heat-assignment-visibility";
import { fetchMyMeetEntries, type MyMeetEntry } from "@/lib/my-meet";

/**
 * An athlete's races for one volume, with heat and lane once seeded.
 *
 * Shared rather than duplicated: this renders on /dashboard (the swimmer's
 * own), on /captain (a captain is an athlete and competes too — the whole
 * point of consolidating that page), and once per child on /parent. Three
 * copies of this logic would drift, and the heat/lane rules below are
 * precisely the part that must not.
 */
export function MyRaces({
  athleteId,
  meetVolumeId,
  volumeName,
  title = "My races",
  className,
}: {
  athleteId: string;
  meetVolumeId: string;
  volumeName?: string;
  title?: string;
  className?: string;
}) {
  const [entries, setEntries] = useState<MyMeetEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchMyMeetEntries(athleteId, meetVolumeId);
      if (cancelled) return;
      setEntries(result.data);
      setError(result.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [athleteId, meetVolumeId]);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Waves className="size-4" />
          {title}
        </CardTitle>
        <CardDescription>
          {volumeName ? `${volumeName} — ` : ""}every race entered, with heat and lane once the
          sheet is published.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <DataErrorBanner error={error} subject="your races" />

        {entries === null ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No races entered for this meet yet.
          </p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.entryId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{entry.eventName}</p>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {entry.sessionNumber != null && (
                    <>
                      <CalendarDays className="size-3.5" />
                      Session {entry.sessionNumber} ·{" "}
                    </>
                  )}
                  Seed {entry.isNt ? "NT" : formatTimeMs(entry.seedTimeMs)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {/* Heat · Lane only when payment is confirmed AND the sheet
                    is published. Draft seeding is invisible by RLS too; the
                    pending-seeding badge is the athlete-facing explanation
                    when cash is settled but the admin has not published. */}
                {(() => {
                  const visibility = heatAssignmentVisibility(
                    entry.status,
                    entry.heat?.published ?? false,
                    entry.heat != null,
                  );
                  if (visibility.kind === "assigned" && entry.heat) {
                    return (
                      <Badge variant="default">
                        Heat {entry.heat.heatNumber} · Lane {entry.heat.laneNumber}
                      </Badge>
                    );
                  }
                  if (visibility.kind === "pending_seeding") {
                    return (
                      <Badge variant="outline" className="max-w-[16rem] whitespace-normal text-left">
                        {PENDING_SEEDING_LABEL}
                      </Badge>
                    );
                  }
                  // pending_payment / unavailable: the payment badge below
                  // already carries the desk-payment state.
                  return null;
                })()}
                {/* Per race, from entries.status — which IS the per-entry
                    payment truth: confirming a cash collection is what flips
                    an entry to confirmed. entry_payments cannot answer this
                    per race, being one row per (athlete, volume). */}
                <PaymentStatusBadge {...paymentStateForEntry(entry.status)} />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
