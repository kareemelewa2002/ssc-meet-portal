"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Loader2, Pause, Play, RotateCcw, Sun, Trophy } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkinsRoundCard } from "@/components/referee/skins-round-card";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { materialiseSkinsHeat } from "@/lib/skins-qualification";
import { fetchSkinsRounds, skinsRoundTitle, type SkinsRoundView } from "@/lib/skins-rounds";
import {
  openingLanes,
  planNextStep,
  roundLabel,
  type SkinsRound,
} from "@/lib/skins-lanes";
import { LANES_PER_HEAT } from "@/lib/seeding";
import { formatTimeMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

const REST_SECONDS = 3 * 60;

function formatClock(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = Math.floor(totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * Runs one Skins board, round by round, from the referee's dashboard.
 *
 * Each round is materialised as its own heat before it can be scored, so a
 * round is submitted and approved on its own and the round before it is never
 * overwritten. The referee is never blocked waiting for an admin: approval
 * governs when results go public, not when the next round can be swum.
 */
export function SkinsBoardRunner({ eventId, eventName }: { eventId: string; eventName?: string }) {
  const { boards, candidates, loading, error, refresh } = useSkinsQualifiers(eventId);
  const [selected, setSelected] = useState<`${AgeGroup}-${Gender}` | null>(null);
  const [rounds, setRounds] = useState<SkinsRoundView[]>([]);
  const [roundsError, setRoundsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outdoorMode, setOutdoorMode] = useState(false);
  const [restSeconds, setRestSeconds] = useState(REST_SECONDS);
  const [timerRunning, setTimerRunning] = useState(false);

  useEffect(() => {
    if (!timerRunning || restSeconds <= 0) return;
    const id = setInterval(() => setRestSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [timerRunning, restSeconds]);

  const populated = useMemo(() => boards.filter((b) => b.active.length > 0), [boards]);

  const activeBoard = useMemo(() => {
    if (populated.length === 0) return null;
    const key = selected ?? (`${populated[0].category}-${populated[0].gender}` as const);
    return populated.find((b) => `${b.category}-${b.gender}` === key) ?? populated[0];
  }, [populated, selected]);

  const reloadRounds = useCallback(async () => {
    const res = await fetchSkinsRounds(eventId);
    setRounds(res.data);
    setRoundsError(res.error);
  }, [eventId]);

  useEffect(() => {
    void reloadRounds();
  }, [reloadRounds]);

  const boardRounds = useMemo(
    () =>
      activeBoard
        ? rounds.filter((r) => r.category === activeBoard.category && r.gender === activeBoard.gender)
        : [],
    [rounds, activeBoard],
  );

  // The round the board is actually on: the deepest one materialised so far.
  const currentRound: SkinsRound = useMemo(() => {
    const mains = boardRounds.filter((r) => !r.swimOff).map((r) => r.round);
    return mains.length > 0 ? (Math.min(...mains) as SkinsRound) : 6;
  }, [boardRounds]);

  const step = useMemo(() => planNextStep(boardRounds, currentRound), [boardRounds, currentRound]);

  // Open the board by putting its qualifiers on the blocks. Seeded fastest to
  // lane 4 — only the FIRST round is seeded by rank; later rounds keep lane
  // order (see planNextStep).
  const openBoard = useCallback(async () => {
    if (!activeBoard || activeBoard.active.length === 0) return;
    setBusy(true);
    try {
      const field = activeBoard.active.slice(0, LANES_PER_HEAT);
      const res = await materialiseSkinsHeat(
        eventId,
        activeBoard.category,
        activeBoard.gender,
        field.map((q) => q.athleteId),
        openingLanes(field.length),
        6,
        false,
      );
      setRoundsError(res.error);
      await reloadRounds();
    } finally {
      setBusy(false);
    }
  }, [activeBoard, eventId, reloadRounds]);

  const hasOpeningRound = boardRounds.some((r) => r.round === 6 && !r.swimOff);

  // One attempt per board. Guarding on `busy`/`loading` instead looked
  // equivalent but deadlocked: neither was a dependency, so the effect ran
  // once while qualifiers were still loading, bailed, and never re-ran — the
  // board picker rendered and no lanes ever appeared.
  const openAttempted = useRef<string | null>(null);

  useEffect(() => {
    if (!activeBoard || hasOpeningRound) return;
    const key = `${activeBoard.category}-${activeBoard.gender}`;
    if (openAttempted.current === key) return;
    openAttempted.current = key;
    void openBoard();
  }, [activeBoard, hasOpeningRound, openBoard]);

  /** Retry after a failure — the ref above otherwise allows only one attempt. */
  const retryOpen = useCallback(() => {
    openAttempted.current = null;
    void reloadRounds();
  }, [reloadRounds]);

  const advance = useCallback(async () => {
    if (!activeBoard) return;
    setBusy(true);
    try {
      if (step.kind === "swim-off") {
        const res = await materialiseSkinsHeat(
          eventId,
          activeBoard.category,
          activeBoard.gender,
          step.athletes.map((a) => a.athleteId),
          step.lanes,
          currentRound,
          true,
        );
        setRoundsError(res.error);
      } else if (step.kind === "next-round") {
        const res = await materialiseSkinsHeat(
          eventId,
          activeBoard.category,
          activeBoard.gender,
          step.field.map((f) => f.athleteId),
          step.field.map((f) => f.laneNumber),
          step.round,
          false,
        );
        setRoundsError(res.error);
      }
      await reloadRounds();
      setRestSeconds(REST_SECONDS);
      setTimerRunning(true);
    } finally {
      setBusy(false);
    }
  }, [activeBoard, currentRound, eventId, reloadRounds, step]);

  if (loading && candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading Skins qualifiers…</p>;
  }

  if (populated.length === 0) {
    return (
      <div className="space-y-4">
        <DataErrorBanner error={error} subject="Skins qualifiers" onRetry={() => void refresh()} />
        <Card>
          <CardHeader>
            <CardTitle>{eventName ?? "Skins"}</CardTitle>
            <CardDescription>Nobody has qualified yet.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Qualification is drawn from published results of the matching non-Skins event — the
              same stroke and distance as this Skins event, whatever that is for this volume.
              Publish that event&apos;s heat cards and the boards fill in automatically.
            </p>
            {candidates.length > 0 && (
              <p>
                {candidates.length} swimmer{candidates.length === 1 ? " has" : "s have"} a qualifying
                time, but none currently hold an active slot.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "space-y-4 rounded-xl p-3 sm:p-4",
        outdoorMode ? "bg-black text-yellow-300" : "bg-background text-foreground",
      )}
    >
      <DataErrorBanner error={error} subject="Skins qualifiers" onRetry={() => void refresh()} />
      <DataErrorBanner error={roundsError} subject="the Skins rounds" onRetry={retryOpen} />

      <div className="flex items-center justify-between gap-2">
        <h2 className={cn("text-lg font-bold sm:text-xl", outdoorMode && "text-yellow-300")}>
          {eventName ?? "Skins"}
        </h2>
        <Button
          type="button"
          variant={outdoorMode ? "secondary" : "outline"}
          size="icon"
          className="size-11 min-h-[48px] min-w-[48px]"
          aria-pressed={outdoorMode}
          aria-label="Toggle high-contrast outdoor mode"
          onClick={() => setOutdoorMode((v) => !v)}
        >
          <Sun className="size-5" />
        </Button>
      </div>

      <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
        <CardHeader>
          <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
            Which board are you running?
          </CardTitle>
          <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
            Men and women race separately in every age group, so each board runs its own bracket.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {populated.map((b) => {
            const key = `${b.category}-${b.gender}` as const;
            const isActive = activeBoard
              ? `${activeBoard.category}-${activeBoard.gender}` === key
              : false;
            return (
              <Button
                key={key}
                type="button"
                variant={isActive ? "default" : "outline"}
                className="min-h-[48px] gap-2"
                onClick={() => setSelected(key)}
              >
                {AGE_GROUP_LABELS[b.category]} {b.gender === "male" ? "Men" : "Women"}
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {b.active.length}
                </Badge>
              </Button>
            );
          })}
        </CardContent>
      </Card>

      {activeBoard?.swimOff && (
        <div className="rounded-md border-2 border-black bg-neon-orange/15 p-3 text-sm">
          <p className="font-bold">Swim-off required before this board can run.</p>
          <p>
            {activeBoard.swimOff.athletes.map((a) => a.athleteName).join(" and ")} are level on{" "}
            {formatTimeMs(activeBoard.swimOff.contestedTimeMs)}, contesting{" "}
            {activeBoard.swimOff.slotsRemaining === 1
              ? "the last slot"
              : `${activeBoard.swimOff.slotsRemaining} slots`}
            .
          </p>
        </div>
      )}

      <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
        <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "font-mono text-3xl font-bold tabular-nums sm:text-4xl",
                outdoorMode && "text-yellow-300",
              )}
            >
              {formatClock(restSeconds)}
            </span>
            <span className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
              rest before next round
            </span>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-2 w-32 overflow-hidden rounded-full bg-muted sm:w-40">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${((REST_SECONDS - restSeconds) / REST_SECONDS) * 100}%` }}
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-11 min-h-[48px] min-w-[48px]"
              aria-label={timerRunning ? "Pause rest timer" : "Start rest timer"}
              onClick={() => setTimerRunning((v) => !v)}
            >
              {timerRunning ? <Pause className="size-5" /> : <Play className="size-5" />}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-11 min-h-[48px] min-w-[48px]"
              aria-label="Reset rest timer"
              onClick={() => {
                setRestSeconds(REST_SECONDS);
                setTimerRunning(false);
              }}
            >
              <RotateCcw className="size-5" />
            </Button>
          </div>
        </CardContent>
      </Card>

      {busy && boardRounds.length === 0 && (
        <p className="text-sm text-muted-foreground">Setting up the lanes…</p>
      )}

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
            {step.athletes.map((a) => a.athleteId).length} swimmers finished level on the last
            qualifying place, contesting{" "}
            {step.slotsRemaining === 1 ? "one place" : `${step.slotsRemaining} places`}. They race
            again — the round itself stands as swum.
          </p>
          <Button type="button" className="min-h-[48px] gap-2" disabled={busy} onClick={() => void advance()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ChevronRight className="size-4" />}
            Set up the swim-off
          </Button>
        </div>
      )}

      {step.kind === "next-round" && (
        <div className="flex justify-end">
          <Button type="button" className="min-h-[48px] gap-2" disabled={busy} onClick={() => void advance()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ChevronRight className="size-4" />}
            Set up {roundLabel(step.round)}
          </Button>
        </div>
      )}

      {step.kind === "complete" && (
        <div className="flex items-center gap-2 rounded-md border-2 border-black bg-primary/10 px-3 py-3 text-sm font-bold">
          <Trophy className="size-5 shrink-0" />
          {step.winners.length > 1
            ? `Dead heat — ${step.winners.length} winners share the title.`
            : "Board complete."}
        </div>
      )}
    </div>
  );
}
