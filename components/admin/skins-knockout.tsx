"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Sun,
  Trophy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn, getErrorMessage, isValidUuid } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { LANE_SEQUENCE } from "@/lib/seeding";
import { DQ_REASON_LABELS, scoreHeatResult } from "@/lib/results";
import { AthleteLink } from "@/components/athletes/athlete-link";
import type { DqReason, ResultOutcome } from "@/lib/supabase/types";

export type SkinsRound = 6 | 4 | 2;

export interface SkinsSwimmer {
  entryId: string;
  athleteId: string;
  athleteName: string;
  teamName?: string;
  laneNumber: number;
  outcome: ResultOutcome | null;
  dqCode?: DqReason;
  finishPlace: number | null;
}

export interface SkinsKnockoutProps {
  eventId: string;
  eventName?: string;
  initialSwimmers?: SkinsSwimmer[];
  onRoundPublished?: (round: SkinsRound, advancing: SkinsSwimmer[]) => void;
  className?: string;
}

const ROUND_SEQUENCE: SkinsRound[] = [6, 4, 2];
const REST_SECONDS = 3 * 60;
const DQ_CODES = Object.keys(DQ_REASON_LABELS) as DqReason[];

const DEMO_SWIMMERS: SkinsSwimmer[] = [
  { entryId: "demo-1", athleteId: "a1", athleteName: "Mia Reyes", teamName: "Blue Marlins", laneNumber: 1, outcome: null, finishPlace: null },
  { entryId: "demo-2", athleteId: "a2", athleteName: "Noah Alvi", teamName: "Riptide", laneNumber: 2, outcome: null, finishPlace: null },
  { entryId: "demo-3", athleteId: "a3", athleteName: "Zara Khan", teamName: "Blue Marlins", laneNumber: 3, outcome: null, finishPlace: null },
  { entryId: "demo-4", athleteId: "a4", athleteName: "Leo Fontaine", teamName: "Tidal Wave", laneNumber: 4, outcome: null, finishPlace: null },
  { entryId: "demo-5", athleteId: "a5", athleteName: "Ava Thompson", teamName: "Riptide", laneNumber: 5, outcome: null, finishPlace: null },
  { entryId: "demo-6", athleteId: "a6", athleteName: "Kian Osei", teamName: "Tidal Wave", laneNumber: 6, outcome: null, finishPlace: null },
];

function nextRound(round: SkinsRound): SkinsRound | null {
  const idx = ROUND_SEQUENCE.indexOf(round);
  return idx >= 0 && idx < ROUND_SEQUENCE.length - 1 ? ROUND_SEQUENCE[idx + 1] : null;
}

function advanceCount(round: SkinsRound): number {
  if (round === 6) return 4;
  if (round === 4) return 2;
  return 0;
}

function roundLabel(round: SkinsRound): string {
  if (round === 2) return "Final 2";
  return `Round of ${round}`;
}

function formatClock(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${m}:${s}`;
}

function isEliminated(swimmer: SkinsSwimmer) {
  return swimmer.outcome === "dq" || swimmer.outcome === "no_show";
}

export function SkinsKnockout({
  eventId,
  eventName = "Session 3 — Skins",
  initialSwimmers,
  onRoundPublished,
  className,
}: SkinsKnockoutProps) {
  const [round, setRound] = useState<SkinsRound>(6);
  const [swimmers, setSwimmers] = useState<SkinsSwimmer[]>(initialSwimmers ?? DEMO_SWIMMERS);
  const [bracket, setBracket] = useState<Partial<Record<SkinsRound, SkinsSwimmer[]>>>({
    6: initialSwimmers ?? DEMO_SWIMMERS,
  });
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [roundPublished, setRoundPublished] = useState(false);
  const [restSeconds, setRestSeconds] = useState(REST_SECONDS);
  const [timerRunning, setTimerRunning] = useState(false);
  const [outdoorMode, setOutdoorMode] = useState(false);
  const [mobileIndex, setMobileIndex] = useState(0);

  useEffect(() => {
    if (!timerRunning || restSeconds <= 0) return;
    const id = setInterval(() => setRestSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [timerRunning, restSeconds]);

  useEffect(() => {
    if (timerRunning && restSeconds === 0) setTimerRunning(false);
  }, [timerRunning, restSeconds]);

  const rankedSwimmers = useMemo(() => {
    return [...swimmers].sort((a, b) => {
      const aOut = isEliminated(a);
      const bOut = isEliminated(b);
      if (aOut !== bOut) return aOut ? 1 : -1;
      if (a.finishPlace === null && b.finishPlace === null) return a.laneNumber - b.laneNumber;
      if (a.finishPlace === null) return 1;
      if (b.finishPlace === null) return -1;
      return a.finishPlace - b.finishPlace;
    });
  }, [swimmers]);

  const allDecided = swimmers.every(
    (s) =>
      s.outcome === "no_show" ||
      (s.outcome === "dq" && s.dqCode) ||
      (s.outcome === "valid" && s.finishPlace !== null),
  );
  const usedPlaces = new Set<number>(
    swimmers
      .filter((s) => s.outcome === "valid" && s.finishPlace !== null)
      .map((s) => s.finishPlace as number),
  );

  const setOutcome = useCallback((athleteId: string, outcome: ResultOutcome) => {
    setSwimmers((prev) =>
      prev.map((s) => {
        if (s.athleteId !== athleteId) return s;
        if (outcome === "dq") {
          return { ...s, outcome, finishPlace: null, dqCode: s.dqCode ?? "false_start" };
        }
        if (outcome === "no_show") {
          return { ...s, outcome, finishPlace: null, dqCode: undefined };
        }
        return { ...s, outcome, dqCode: undefined };
      }),
    );
  }, []);

  const setDqCode = useCallback((athleteId: string, dqCode: DqReason) => {
    setSwimmers((prev) =>
      prev.map((s) =>
        s.athleteId === athleteId ? { ...s, outcome: "dq", dqCode, finishPlace: null } : s,
      ),
    );
  }, []);

  const setFinishPlace = useCallback((athleteId: string, place: number) => {
    setSwimmers((prev) =>
      prev.map((s) => {
        if (s.athleteId === athleteId) {
          return { ...s, finishPlace: place, outcome: "valid", dqCode: undefined };
        }
        if (s.finishPlace === place) return { ...s, finishPlace: null };
        return s;
      }),
    );
  }, []);

  const handlePublish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const supabase = createClient();

      for (const swimmer of swimmers) {
        if (!swimmer.outcome) continue;
        // A demo/placeholder swimmer (no real Skins field wired up yet —
        // see eventId prop) has no matching heat_lanes row, and
        // heat_lanes.entry_id is a uuid column: querying it with a
        // non-UUID string like "demo-1" 400s outright rather than just
        // returning no match. Skip it — there's nothing real to publish.
        if (!isValidUuid(swimmer.entryId)) continue;
        const { data: lane, error: laneError } = await supabase
          .from("heat_lanes")
          .select("id")
          .eq("entry_id", swimmer.entryId)
          .maybeSingle();
        if (laneError || !lane) continue;

        const scored = scoreHeatResult(
          {
            outcome: swimmer.outcome,
            finishPlace: swimmer.finishPlace,
            maxPlacementPoints: swimmers.length,
          },
          swimmer.dqCode ?? null,
        );

        await supabase.from("results").upsert(
          {
            heat_lane_id: lane.id,
            result_outcome: scored.resultOutcome,
            dq_code: scored.dqCode,
            official_time_ms: scored.officialTimeMs,
            finish_place: scored.finishPlace,
            placement_points: scored.placementPoints,
            improvement_points: scored.improvementPoints,
            status: "published",
          },
          { onConflict: "heat_lane_id" },
        );
      }

      const cutoff = advanceCount(round);
      const advancing = rankedSwimmers
        .filter((s) => s.outcome === "valid")
        .slice(0, cutoff || rankedSwimmers.length);

      setBracket((prev) => ({ ...prev, [round]: rankedSwimmers }));
      setRoundPublished(true);
      setTimerRunning(true);
      setRestSeconds(REST_SECONDS);
      onRoundPublished?.(round, advancing);
    } catch (err) {
      setPublishError(getErrorMessage(err, "Failed to publish round results."));
    } finally {
      setPublishing(false);
    }
  };

  const handleAdvanceRound = () => {
    const upcoming = nextRound(round);
    if (!upcoming) return;
    const cutoff = advanceCount(round);
    const advancing = rankedSwimmers
      .filter((s) => s.outcome === "valid")
      .slice(0, cutoff);
    const seeded = advancing.map((s, idx) => ({
      ...s,
      outcome: null,
      dqCode: undefined,
      finishPlace: null,
      laneNumber: LANE_SEQUENCE[idx],
    }));
    setSwimmers(seeded);
    setBracket((prev) => ({ ...prev, [upcoming]: seeded }));
    setRound(upcoming);
    setRoundPublished(false);
    setTimerRunning(false);
    setRestSeconds(REST_SECONDS);
    setMobileIndex(0);
  };

  const isFinal = round === 2;
  const restProgressPct = ((REST_SECONDS - restSeconds) / REST_SECONDS) * 100;

  return (
    <div
      className={cn(
        "space-y-4 rounded-xl p-3 sm:p-4",
        outdoorMode
          ? "bg-black text-yellow-300 [--tw-ring-color:theme(colors.yellow.300)]"
          : "bg-background text-foreground",
        className,
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className={cn("text-lg font-bold sm:text-xl", outdoorMode && "text-yellow-300")}>
            {eventName}
          </h2>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            Event {eventId} · {roundLabel(round)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={isFinal ? "default" : "secondary"} className="h-8 px-3 text-sm">
            <Trophy className="mr-1 size-4" />
            {roundLabel(round)}
          </Badge>
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
      </div>

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
              <div className="h-full bg-primary transition-all" style={{ width: `${restProgressPct}%` }} />
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

      <div className="hidden gap-4 md:grid md:grid-cols-[3fr_2fr]">
        <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
          <CardHeader>
            <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>Live Lane Status</CardTitle>
            <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
              Set finish order, DQ (with reason), or NS for {roundLabel(round)}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {rankedSwimmers.map((swimmer) => (
              <LaneRow
                key={swimmer.athleteId}
                swimmer={swimmer}
                usedPlaces={usedPlaces}
                maxPlace={swimmers.length}
                outdoorMode={outdoorMode}
                onSetOutcome={(outcome) => setOutcome(swimmer.athleteId, outcome)}
                onSetDqCode={(code) => setDqCode(swimmer.athleteId, code)}
                onSetPlace={(place) => setFinishPlace(swimmer.athleteId, place)}
              />
            ))}
          </CardContent>
        </Card>

        <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
          <CardHeader>
            <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>Elimination Bracket</CardTitle>
            <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
              Round of 6 → Round of 4 → Final 2
            </CardDescription>
          </CardHeader>
          <CardContent>
            <BracketTree bracket={bracket} currentRound={round} outdoorMode={outdoorMode} />
          </CardContent>
        </Card>
      </div>

      <div className="md:hidden">
        <div className="mb-2 flex items-center justify-between">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11 min-h-[48px] min-w-[48px]"
            disabled={mobileIndex === 0}
            onClick={() => setMobileIndex((i) => Math.max(0, i - 1))}
            aria-label="Previous lane"
          >
            <ChevronLeft className="size-5" />
          </Button>
          <span className={cn("text-sm font-medium", outdoorMode && "text-yellow-300")}>
            Lane {mobileIndex + 1} of {rankedSwimmers.length}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11 min-h-[48px] min-w-[48px]"
            disabled={mobileIndex >= rankedSwimmers.length - 1}
            onClick={() => setMobileIndex((i) => Math.min(rankedSwimmers.length - 1, i + 1))}
            aria-label="Next lane"
          >
            <ChevronRight className="size-5" />
          </Button>
        </div>

        <div
          className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            const idx = Math.round(el.scrollLeft / el.clientWidth);
            if (idx !== mobileIndex) setMobileIndex(idx);
          }}
        >
          {rankedSwimmers.map((swimmer) => (
            <div key={swimmer.athleteId} className="w-full min-w-0 shrink-0 snap-center">
              <MobileSwimmerCard
                swimmer={swimmer}
                usedPlaces={usedPlaces}
                maxPlace={swimmers.length}
                outdoorMode={outdoorMode}
                onSetOutcome={(outcome) => setOutcome(swimmer.athleteId, outcome)}
                onSetDqCode={(code) => setDqCode(swimmer.athleteId, code)}
                onSetPlace={(place) => setFinishPlace(swimmer.athleteId, place)}
              />
            </div>
          ))}
        </div>
      </div>

      {publishError && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          {publishError}
        </div>
      )}

      <Separator className={outdoorMode ? "bg-yellow-300/30" : undefined} />

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {roundPublished && !isFinal && (
          <Button type="button" variant="secondary" className="min-h-[48px]" onClick={handleAdvanceRound}>
            Advance to {roundLabel(nextRound(round)!)}
          </Button>
        )}
        <Button
          type="button"
          className="min-h-[48px]"
          disabled={!allDecided || publishing}
          onClick={() => void handlePublish()}
        >
          {publishing ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : roundPublished ? (
            <CheckCircle2 className="mr-2 size-4" />
          ) : null}
          {roundPublished ? "Round Published" : "Publish Round Results"}
        </Button>
      </div>
    </div>
  );
}

function OutcomeControls({
  swimmer,
  outdoorMode,
  onSetOutcome,
  onSetDqCode,
}: {
  swimmer: SkinsSwimmer;
  outdoorMode: boolean;
  onSetOutcome: (outcome: ResultOutcome) => void;
  onSetDqCode: (code: DqReason) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          size="sm"
          variant={swimmer.outcome === "valid" ? "default" : "outline"}
          className="min-h-[40px]"
          onClick={() => onSetOutcome("valid")}
        >
          Valid
        </Button>
        <Button
          type="button"
          size="sm"
          variant={swimmer.outcome === "dq" ? "destructive" : "outline"}
          className="min-h-[40px]"
          onClick={() => onSetOutcome("dq")}
        >
          DQ
        </Button>
        <Button
          type="button"
          size="sm"
          variant={swimmer.outcome === "no_show" ? "secondary" : "outline"}
          className={cn(
            "min-h-[40px]",
            swimmer.outcome === "no_show" && "bg-amber-600 text-white hover:bg-amber-600",
          )}
          onClick={() => onSetOutcome("no_show")}
        >
          NS
        </Button>
      </div>
      {swimmer.outcome === "dq" && (
        <Select
          value={swimmer.dqCode ?? "false_start"}
          onValueChange={(value) => {
            if (value != null) onSetDqCode(value as DqReason);
          }}
        >
          <SelectTrigger
            className={cn(
              "min-h-[44px] w-full",
              outdoorMode && "border-yellow-300/40 text-yellow-300",
            )}
          >
            {/* Select.Value renders the raw value by default — a render
                function is required to show the label. */}
            <SelectValue>
              {(value: DqReason) => DQ_REASON_LABELS[value] ?? value}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DQ_CODES.map((code) => (
              <SelectItem key={code} value={code}>
                {DQ_REASON_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function LaneRow({
  swimmer,
  usedPlaces,
  maxPlace,
  outdoorMode,
  onSetOutcome,
  onSetDqCode,
  onSetPlace,
}: {
  swimmer: SkinsSwimmer;
  usedPlaces: Set<number>;
  maxPlace: number;
  outdoorMode: boolean;
  onSetOutcome: (outcome: ResultOutcome) => void;
  onSetDqCode: (code: DqReason) => void;
  onSetPlace: (place: number) => void;
}) {
  const eliminated = isEliminated(swimmer);
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border p-3",
        outdoorMode ? "border-yellow-300/30" : "border-border",
      )}
    >
      <div className="flex min-w-[48px] items-center justify-center rounded-md bg-muted px-2 py-1 text-sm font-bold">
        L{swimmer.laneNumber}
      </div>
      <div className="min-w-0 flex-1">
        <AthleteLink
          athleteId={swimmer.athleteId}
          name={swimmer.athleteName}
          className={cn("block truncate font-medium", eliminated && "line-through opacity-60")}
        />
        {swimmer.teamName && (
          <p className={cn("truncate text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}>
            {swimmer.teamName}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {Array.from({ length: maxPlace }, (_, i) => i + 1).map((place) => {
          const active = swimmer.finishPlace === place;
          const taken = usedPlaces.has(place) && !active;
          return (
            <Button
              key={place}
              type="button"
              size="sm"
              variant={active ? "default" : "outline"}
              disabled={eliminated || taken}
              className="size-9 min-h-[36px] min-w-[36px] p-0"
              onClick={() => onSetPlace(place)}
            >
              {place}
            </Button>
          );
        })}
      </div>
      <div className="w-full sm:w-56">
        <OutcomeControls
          swimmer={swimmer}
          outdoorMode={outdoorMode}
          onSetOutcome={onSetOutcome}
          onSetDqCode={onSetDqCode}
        />
      </div>
    </div>
  );
}

function MobileSwimmerCard({
  swimmer,
  usedPlaces,
  maxPlace,
  outdoorMode,
  onSetOutcome,
  onSetDqCode,
  onSetPlace,
}: {
  swimmer: SkinsSwimmer;
  usedPlaces: Set<number>;
  maxPlace: number;
  outdoorMode: boolean;
  onSetOutcome: (outcome: ResultOutcome) => void;
  onSetDqCode: (code: DqReason) => void;
  onSetPlace: (place: number) => void;
}) {
  const eliminated = isEliminated(swimmer);
  return (
    <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
      <CardHeader className="pb-2 text-center">
        <Badge className="mx-auto mb-2 h-8 px-3 text-sm">Lane {swimmer.laneNumber}</Badge>
        <CardTitle
          className={cn(
            "text-xl",
            eliminated && "line-through opacity-60",
            outdoorMode && "text-yellow-300",
          )}
        >
          <AthleteLink athleteId={swimmer.athleteId} name={swimmer.athleteName} />
        </CardTitle>
        {swimmer.teamName && (
          <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
            {swimmer.teamName}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <p className={cn("text-center text-sm font-medium", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
          Finish place
        </p>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: maxPlace }, (_, i) => i + 1).map((place) => {
            const active = swimmer.finishPlace === place;
            const taken = usedPlaces.has(place) && !active;
            return (
              <Button
                key={place}
                type="button"
                variant={active ? "default" : "outline"}
                disabled={eliminated || taken}
                className="min-h-[48px] text-lg font-bold"
                onClick={() => onSetPlace(place)}
              >
                {place}
              </Button>
            );
          })}
        </div>
        <OutcomeControls
          swimmer={swimmer}
          outdoorMode={outdoorMode}
          onSetOutcome={onSetOutcome}
          onSetDqCode={onSetDqCode}
        />
      </CardContent>
    </Card>
  );
}

function BracketTree({
  bracket,
  currentRound,
  outdoorMode,
}: {
  bracket: Partial<Record<SkinsRound, SkinsSwimmer[]>>;
  currentRound: SkinsRound;
  outdoorMode: boolean;
}) {
  const advancingIdsByRound: Partial<Record<SkinsRound, Set<string>>> = {};
  ROUND_SEQUENCE.forEach((r) => {
    const results = bracket[r];
    if (!results) return;
    const cutoff = advanceCount(r);
    advancingIdsByRound[r] = new Set(
      results
        .filter((s) => s.outcome === "valid")
        .slice(0, cutoff || results.length)
        .map((s) => s.athleteId),
    );
  });

  return (
    <div className="grid grid-cols-3 gap-2">
      {ROUND_SEQUENCE.map((r) => {
        const results = bracket[r];
        const isActive = r === currentRound;
        return (
          <div key={r} className="space-y-2">
            <p
              className={cn(
                "text-center text-xs font-semibold uppercase tracking-wide",
                isActive ? "text-primary" : outdoorMode ? "text-yellow-100/60" : "text-muted-foreground",
              )}
            >
              {roundLabel(r)}
            </p>
            <div className="space-y-1">
              {(results ?? []).map((s) => {
                const advances = advancingIdsByRound[r]?.has(s.athleteId);
                const eliminated = isEliminated(s);
                return (
                  <div
                    key={s.athleteId}
                    className={cn(
                      "truncate rounded border px-2 py-1 text-xs",
                      eliminated && "opacity-40 line-through",
                      advances && !eliminated
                        ? "border-primary/50 bg-primary/10 font-semibold"
                        : outdoorMode
                          ? "border-yellow-300/20"
                          : "border-border",
                    )}
                    title={
                      s.outcome === "no_show"
                        ? `${s.athleteName} (NS)`
                        : s.outcome === "dq"
                          ? `${s.athleteName} (DQ)`
                          : s.athleteName
                    }
                  >
                    <AthleteLink athleteId={s.athleteId} name={s.athleteName} />
                    {s.outcome === "no_show" ? " · NS" : s.outcome === "dq" ? " · DQ" : ""}
                  </div>
                );
              })}
              {!results && (
                <div
                  className={cn(
                    "rounded border border-dashed px-2 py-3 text-center text-xs",
                    outdoorMode ? "border-yellow-300/20 text-yellow-100/50" : "border-border text-muted-foreground",
                  )}
                >
                  Pending
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
