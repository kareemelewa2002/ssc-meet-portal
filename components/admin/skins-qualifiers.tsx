"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, RotateCcw, Swords, UserCheck, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { useToast } from "@/hooks/use-toast";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import { materialiseSkinsHeat, resolveSkinsEventId } from "@/lib/skins-qualification";
import { centredLanes } from "@/lib/skins-lanes";
import { formatTimeMs } from "@/lib/format";
import { getErrorMessage } from "@/lib/utils";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

const CATEGORY_LABELS: Record<AgeGroup, string> = {
  U14: "14 & Under",
  U17: "17 & Under",
  Open: "Open",
};

function responseLabel(response: "pending" | "accepted" | "declined"): string {
  if (response === "accepted") return "Present";
  if (response === "declined") return "Withdrawn";
  return "Awaiting roll-call";
}

/**
 * Admin control over who actually swims Skins.
 *
 * Skins invitations are settled IN PERSON at the venue — there is no
 * athlete-facing accept/decline any more. Withdraw a swimmer who turns the
 * slot down and the next-ranked qualifier is promoted automatically.
 * Mark Present to lock the field for the opening round.
 */
export function SkinsQualifiers({ className }: { className?: string }) {
  const toast = useToast();
  const router = useRouter();
  const [eventId, setEventId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [creatingSwimOff, setCreatingSwimOff] = useState<string | null>(null);

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
        next === "declined" ? "Swimmer withdrawn" : "Marked present",
        next === "declined"
          ? `${athleteName} is out of the ${CATEGORY_LABELS[category]} board — the next ranked swimmer moves up.`
          : `${athleteName} is confirmed present for ${CATEGORY_LABELS[category]} Skins.`,
      );
    } catch (err) {
      toast.error("Couldn't update the slot", getErrorMessage(err, "Unknown error"));
    } finally {
      setBusyKey(null);
    }
  }

  async function createQualifyingSwimOff(
    category: AgeGroup,
    gender: Gender,
    athleteIds: string[],
  ) {
    if (!eventId) return;
    const key = `${category}-${gender}`;
    setCreatingSwimOff(key);
    try {
      const lanes = centredLanes(athleteIds.length);
      const res = await materialiseSkinsHeat(
        eventId,
        category,
        gender,
        athleteIds,
        lanes,
        6,
        true,
      );
      if (res.error) {
        toast.error("Couldn't create the swim-off", res.error);
        return;
      }
      toast.success(
        "Swim-off heat ready",
        "Opening the referee deck for time entry.",
      );
      router.push("/referee");
    } catch (err) {
      toast.error("Couldn't create the swim-off", getErrorMessage(err, "Unknown error"));
    } finally {
      setCreatingSwimOff(null);
    }
  }

  const withdrawn = candidates.filter((c) => c.response === "declined");
  const boardsNeedingSwimOff = boards.filter((b) => b.swimOff != null);

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>Skins qualification slots</CardTitle>
        <CardDescription>
          Top 6 fastest published times per board. Roll-call at the venue — mark Present or
          Withdrawn; withdrawing promotes the next ranked qualifier automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataErrorBanner error={resolveError ?? error} subject="Skins qualifiers" />

        {boardsNeedingSwimOff.length > 0 && (
          <div className="space-y-3">
            {boardsNeedingSwimOff.map((board) => {
              const swimOff = board.swimOff!;
              const key = `${board.category}-${board.gender}`;
              return (
                <div
                  key={key}
                  className="space-y-2 rounded-lg border-2 border-border-strong bg-neon-orange/15 p-3"
                >
                  <p className="flex items-center gap-2 text-sm font-bold">
                    <Swords className="size-4 shrink-0" />
                    Swim-Off Required
                  </p>
                  <p className="text-sm">
                    {CATEGORY_LABELS[board.category]} ·{" "}
                    {board.gender === "male" ? "Men" : "Women"} —{" "}
                    {swimOff.athletes.map((a) => a.athleteName).join(" and ")} are level on{" "}
                    {formatTimeMs(swimOff.contestedTimeMs)}, contesting{" "}
                    {swimOff.slotsRemaining === 1
                      ? "the last qualifying slot"
                      : `${swimOff.slotsRemaining} qualifying slots`}
                    .
                  </p>
                  <Button
                    type="button"
                    className="min-h-[48px] gap-2"
                    disabled={creatingSwimOff === key}
                    onClick={() =>
                      void createQualifyingSwimOff(
                        board.category,
                        board.gender,
                        swimOff.athletes.map((a) => a.athleteId),
                      )
                    }
                  >
                    {creatingSwimOff === key ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Swords className="size-4" />
                    )}
                    Create Swim-Off Heat
                  </Button>
                </div>
              );
            })}
          </div>
        )}

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
                  const present = q.response === "accepted";
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
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Badge variant="outline">{responseLabel(q.response)}</Badge>
                        {!present && (
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
                              <UserCheck className="size-3.5" />
                            )}
                            Present
                          </Button>
                        )}
                        {present && (
                          <span className="inline-flex items-center gap-1 text-xs text-neon-lime">
                            <Check className="size-3.5" />
                            Present
                          </span>
                        )}
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
                          Withdrawn
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          ))
        )}

        {withdrawn.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Withdrawn / Declined
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
