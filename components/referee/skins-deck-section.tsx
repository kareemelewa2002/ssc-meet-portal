"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkinsRoundCard } from "@/components/referee/skins-round-card";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { materialiseSkinsHeat } from "@/lib/skins-qualification";
import { fetchSkinsRounds, skinsRoundTitle, type SkinsRoundView } from "@/lib/skins-rounds";
import { openingLanes, planNextStep, roundLabel, type SkinsRound } from "@/lib/skins-lanes";
import { LANES_PER_HEAT } from "@/lib/seeding";
import { cn } from "@/lib/utils";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

/**
 * The Skins bracket, listed in the referee's deck with every other race.
 *
 * It used to sit behind its own tab, which meant a referee working down the
 * running order had to know to go somewhere else for one event. Skins is a
 * race in Session 3 like any other, so it belongs in the same list — it just
 * scores differently, because it is placed by eye and has no times at all.
 *
 * Each board's opening round is seeded automatically once its qualifiers
 * exist, the same way ordinary heats appear once entries are confirmed.
 */
export function SkinsDeckSection({
  eventId,
  eventName,
  outdoorMode,
  genderFilter,
  unscoredOnly,
}: {
  eventId: string;
  eventName: string;
  outdoorMode: boolean;
  genderFilter?: Gender | null;
  unscoredOnly?: boolean;
}) {
  const { boards, loading, error, refresh } = useSkinsQualifiers(eventId);
  const [rounds, setRounds] = useState<SkinsRoundView[]>([]);
  const [roundsError, setRoundsError] = useState<string | null>(null);
  const [busyBoard, setBusyBoard] = useState<string | null>(null);

  const populated = useMemo(
    () =>
      boards
        .filter((b) => b.active.length > 0)
        .filter((b) => !genderFilter || b.gender === genderFilter),
    [boards, genderFilter],
  );

  const reloadRounds = useCallback(async () => {
    const res = await fetchSkinsRounds(eventId);
    setRounds(res.data);
    setRoundsError(res.error);
  }, [eventId]);

  useEffect(() => {
    void reloadRounds();
  }, [reloadRounds]);

  // One seeding attempt per board. Guarding on a `loading`/`busy` flag that is
  // not also a dependency deadlocks: the effect runs once while qualifiers are
  // still loading, bails, and never runs again.
  const seeded = useRef<Set<string>>(new Set());

  const seedOpeningRounds = useCallback(async () => {
    for (const board of boards.filter((b) => b.active.length > 0)) {
      const key = `${board.category}-${board.gender}`;
      const exists = rounds.some(
        (r) => r.category === board.category && r.gender === board.gender && r.round === 6 && !r.swimOff,
      );
      if (exists || seeded.current.has(key)) continue;
      seeded.current.add(key);
      const field = board.active.slice(0, LANES_PER_HEAT);
      const res = await materialiseSkinsHeat(
        eventId,
        board.category,
        board.gender,
        field.map((q) => q.athleteId),
        openingLanes(field.length),
        6,
        false,
      );
      if (res.error) setRoundsError(res.error);
    }
    await reloadRounds();
  }, [boards, rounds, eventId, reloadRounds]);

  // Keyed on a STABLE description of the boards, never the array itself: an
  // effect that depends on a derived array re-runs on every render, and this
  // one writes to the database and reloads.
  const boardsKey = useMemo(
    () =>
      boards
        .filter((b) => b.active.length > 0)
        .map((b) => `${b.category}-${b.gender}:${b.active.length}`)
        .join("|"),
    [boards],
  );

  useEffect(() => {
    if (loading || boardsKey === "") return;
    void seedOpeningRounds();
    // seedOpeningRounds dedupes per board via the ref above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, boardsKey]);

  const retry = useCallback(() => {
    seeded.current.clear();
    void reloadRounds();
  }, [reloadRounds]);

  const advance = useCallback(
    async (category: AgeGroup, gender: Gender, currentRound: SkinsRound, boardRounds: SkinsRoundView[]) => {
      const key = `${category}-${gender}`;
      setBusyBoard(key);
      try {
        const step = planNextStep(boardRounds, currentRound);
        if (step.kind === "swim-off") {
          const res = await materialiseSkinsHeat(
            eventId, category, gender,
            step.athletes.map((a) => a.athleteId), step.lanes, currentRound, true,
          );
          if (res.error) setRoundsError(res.error);
        } else if (step.kind === "next-round") {
          const res = await materialiseSkinsHeat(
            eventId, category, gender,
            step.field.map((f) => f.athleteId), step.field.map((f) => f.laneNumber), step.round, false,
          );
          if (res.error) setRoundsError(res.error);
        }
        await reloadRounds();
      } finally {
        setBusyBoard(null);
      }
    },
    [eventId, reloadRounds],
  );

  if (loading && rounds.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading the Skins bracket…</p>;
  }

  if (populated.length === 0) return null;

  return (
    <div className="space-y-4">
      <h2
        className={cn(
          "flex flex-wrap items-center gap-2 text-base font-bold",
          outdoorMode && "text-yellow-300",
        )}
      >
        {eventName}
        <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
          Knockout — placed, not timed
        </Badge>
      </h2>

      <DataErrorBanner error={error} subject="Skins qualifiers" onRetry={() => void refresh()} />
      <DataErrorBanner error={roundsError} subject="the Skins rounds" onRetry={retry} />

      {populated.map((board) => {
        const key = `${board.category}-${board.gender}`;
        const boardRounds = rounds
          .filter((r) => r.category === board.category && r.gender === board.gender)
          .filter((r) => !unscoredOnly || r.publishState !== "published");
        const allBoardRounds = rounds.filter(
          (r) => r.category === board.category && r.gender === board.gender,
        );
        if (boardRounds.length === 0) return null;

        const mains = allBoardRounds.filter((r) => !r.swimOff).map((r) => r.round);
        const currentRound: SkinsRound = mains.length > 0 ? (Math.min(...mains) as SkinsRound) : 6;
        const step = planNextStep(allBoardRounds, currentRound);

        return (
          <div key={key} className="space-y-2">
            <p className={cn("text-sm font-bold", outdoorMode && "text-yellow-100/80")}>
              {AGE_GROUP_LABELS[board.category]} {board.gender === "male" ? "Men" : "Women"}
            </p>

            {boardRounds.map((view) => (
              <SkinsRoundCard
                key={view.heatId}
                view={view}
                title={skinsRoundTitle(view)}
                outdoorMode={outdoorMode}
                onSubmitted={reloadRounds}
              />
            ))}

            {step.kind === "swim-off" && (
              <div className="space-y-2 rounded-md border-2 border-black bg-neon-orange/15 px-3 py-2 text-sm">
                <p className="font-bold">Swim-off required to settle {roundLabel(currentRound)}</p>
                <p>
                  {step.athletes.length} swimmers finished level on the last qualifying place,
                  contesting {step.slotsRemaining === 1 ? "one place" : `${step.slotsRemaining} places`}.
                  The round itself stands as swum.
                </p>
                <Button
                  type="button"
                  className="min-h-[48px] gap-2"
                  disabled={busyBoard === key}
                  onClick={() => void advance(board.category, board.gender, currentRound, allBoardRounds)}
                >
                  {busyBoard === key ? <Loader2 className="size-4 animate-spin" /> : <ChevronRight className="size-4" />}
                  Set up the swim-off
                </Button>
              </div>
            )}

            {step.kind === "next-round" && (
              <div className="flex justify-end">
                <Button
                  type="button"
                  className="min-h-[48px] gap-2"
                  disabled={busyBoard === key}
                  onClick={() => void advance(board.category, board.gender, currentRound, allBoardRounds)}
                >
                  {busyBoard === key ? <Loader2 className="size-4 animate-spin" /> : <ChevronRight className="size-4" />}
                  Set up {roundLabel(step.round)}
                </Button>
              </div>
            )}

            {step.kind === "complete" && (
              <div className="flex items-center gap-2 rounded-md border-2 border-black bg-primary/10 px-3 py-2 text-sm font-bold">
                <Trophy className="size-4 shrink-0" />
                {step.winners.length > 1
                  ? `Dead heat — ${step.winners.length} winners share the title.`
                  : "Board complete."}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
