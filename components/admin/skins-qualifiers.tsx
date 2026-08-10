"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCcw, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { useToast } from "@/hooks/use-toast";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import { resolveSkinsEventId } from "@/lib/skins-qualification";
import { formatTimeMs } from "@/lib/format";
import { getErrorMessage } from "@/lib/utils";
import type { AgeGroup } from "@/lib/supabase/types";

const CATEGORY_LABELS: Record<AgeGroup, string> = {
  U14: "14 & Under",
  U17: "17 & Under",
  Open: "Open",
};

/**
 * Admin control over who actually swims Skins.
 *
 * Skins invitations are settled IN PERSON at the venue now — there is no
 * athlete-facing accept/decline any more (the dashboard card and its modal
 * were removed, and the athlete_respond_own_skins_qualification RLS policy
 * with them). So a swimmer who turns their slot down on the day has to be
 * withdrawn by whoever is running the desk, which is what this is for.
 *
 * Withdrawing writes response = 'declined', which is exactly what the
 * athlete-initiated path used to write — so the existing rollover applies
 * untouched and the next-ranked swimmer moves into the freed slot. It is not
 * a delete: the qualification row is the record that this athlete DID rank
 * into a slot, and deleting it would lose that and let the rank recompute
 * them straight back in.
 */
export function SkinsQualifiers({ className }: { className?: string }) {
  const toast = useToast();
  const [eventId, setEventId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await resolveSkinsEventId();
      if (cancelled) return;
      setEventId(result.data);
      setResolveError(result.error);
      setResolving(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const { boards, candidates, loading, error, respond } = useSkinsQualifiers(eventId);

  async function setResponse(
    athleteId: string,
    category: AgeGroup,
    next: "declined" | "accepted",
    athleteName: string,
  ) {
    const key = `${athleteId}-${category}`;
    setBusyKey(key);
    try {
      await respond(athleteId, category, next);
      toast.success(
        next === "declined" ? "Swimmer withdrawn" : "Swimmer reinstated",
        next === "declined"
          ? `${athleteName} is out of the ${CATEGORY_LABELS[category]} board — the next ranked swimmer moves up.`
          : `${athleteName} is back on the ${CATEGORY_LABELS[category]} board.`,
      );
    } catch (err) {
      toast.error("Couldn't update the slot", getErrorMessage(err, "Unknown error"));
    } finally {
      setBusyKey(null);
    }
  }

  const withdrawn = candidates.filter((c) => c.response === "declined");

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Skins qualification slots</CardTitle>
        <CardDescription>
          Slots are ranked from published results. Invitations are accepted or declined in person
          at the venue — withdraw a swimmer here if they turn theirs down, and the next ranked
          swimmer takes the slot automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataErrorBanner error={resolveError ?? error} subject="Skins qualifiers" />

        {resolving || loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : !eventId ? (
          <p className="text-sm text-muted-foreground">
            No Skins event in this meet, so there are no qualification slots to manage.
          </p>
        ) : boards.every((b) => b.active.length === 0) ? (
          <p className="text-sm text-muted-foreground">
            No qualifiers yet — slots are ranked from published results, so score and publish the
            qualifying races first.
          </p>
        ) : (
          boards.map((board) => (
            <div key={`${board.category}-${board.gender}`} className="space-y-2">
              <p className="text-sm font-bold">
                {CATEGORY_LABELS[board.category]} · {board.gender === "male" ? "Men" : "Women"}
              </p>
              {board.active.length === 0 ? (
                <p className="text-xs text-muted-foreground">No active qualifiers.</p>
              ) : (
                board.active.map((q) => {
                  const key = `${q.athleteId}-${q.category}`;
                  return (
                    <div
                      key={key}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">
                          #{q.slotNumber}{" "}
                          <AthleteLink athleteId={q.athleteId} name={q.athleteName} />
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Ranked #{q.sourceRank} · {formatTimeMs(q.bestTimeMs)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant="outline">{q.response}</Badge>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="min-h-[44px] gap-1.5"
                          disabled={busyKey === key}
                          onClick={() =>
                            void setResponse(q.athleteId, q.category, "declined", q.athleteName)
                          }
                        >
                          {busyKey === key ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <UserMinus className="size-3.5" />
                          )}
                          Withdraw
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ))
        )}

        {/* Withdrawing is reversible — someone who declines and then changes
            their mind before the round is built should not need a database
            edit to get back in. */}
        {withdrawn.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Withdrawn
            </p>
            {withdrawn.map((q) => {
              const key = `${q.athleteId}-${q.category}`;
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5"
                >
                  <p className="truncate text-sm">
                    {q.athleteName}{" "}
                    <span className="text-xs text-muted-foreground">
                      · {CATEGORY_LABELS[q.category]}
                    </span>
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-[44px] gap-1.5"
                    disabled={busyKey === key}
                    onClick={() =>
                      void setResponse(q.athleteId, q.category, "accepted", q.athleteName)
                    }
                  >
                    {busyKey === key ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="size-3.5" />
                    )}
                    Reinstate
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
