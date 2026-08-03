"use client";

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilterSelect } from "@/components/events/filter-select";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { PerformanceBadges } from "@/components/results/performance-badges";
import {
  DEMO_ALL_TIME_RACES,
  fetchAllTimePerformances,
  fetchPointsPerformances,
  rankBestPerformances,
  rankBestPerformers,
  rankPointsPerformances,
  type PointsPerformance,
  type RacePerformance,
} from "@/lib/all-time-rankings";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { formatTimeMs } from "@/lib/format";
import { describeAgeAtSwim } from "@/lib/age";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

/**
 * The three cross-volume boards: Best Performers, Best Performances, and Best
 * Performance (World Aquatics points).
 *
 * Extracted from the /leaderboards/all-time page so the main Leaderboards
 * page can offer them alongside the meet standings — they were previously
 * reachable only through a text link on the Athletes page, which is not
 * anywhere anyone would look for a leaderboard.
 */
type BoardTab = "performers" | "performances" | "points";

export function AllTimeBoards() {
  const [races, setRaces] = useState<RacePerformance[]>(DEMO_ALL_TIME_RACES);
  const [pointsRows, setPointsRows] = useState<PointsPerformance[]>([]);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [tab, setTab] = useState<BoardTab>("performers");
  const [gender, setGender] = useState<Gender>("male");
  const [ageGroup, setAgeGroup] = useState<AgeGroup>("Open");
  const [stroke, setStroke] = useState<string>("Freestyle");
  const [distanceM, setDistanceM] = useState<number>(50);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [data, points] = await Promise.all([
        fetchAllTimePerformances(),
        fetchPointsPerformances(),
      ]);
      if (cancelled) return;
      setRaces(data);
      setPointsRows(points.data);
      // Previously dropped: a missing performance_highlights view (a database
      // still on an older schema) left the board silently empty and looking
      // like nobody had swum anything.
      setPointsError(points.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Stroke and distance are not independent choices here — together they ARE
  // the event, and only their combination identifies a record ("50m
  // Butterfly"). They were two separate pickers, which let you select a pair
  // nobody has ever swum and see an empty board with no explanation. One
  // Event dropdown, built from combinations that actually exist.
  const eventOptions = useMemo(() => {
    const seen = new Map<string, { value: string; label: string }>();
    for (const r of races) {
      const value = `${r.distanceM}|${r.stroke}`;
      if (!seen.has(value)) seen.set(value, { value, label: `${r.distanceM}m ${r.stroke}` });
    }
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [races]);

  const performers = useMemo(
    () =>
      rankBestPerformers(
        races,
        { gender, ageGroup, stroke, distanceM },
        10,
      ),
    [races, gender, ageGroup, stroke, distanceM],
  );
  const pointsPerformances = useMemo(
    () => rankPointsPerformances(pointsRows, { gender, ageGroup }, 25),
    [pointsRows, gender, ageGroup],
  );
  const performances = useMemo(
    () =>
      rankBestPerformances(
        races,
        { gender, ageGroup, stroke, distanceM },
        10,
      ),
    [races, gender, ageGroup, stroke, distanceM],
  );

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FilterSelect<Gender>
          label="Gender"
          value={gender}
          onChange={(v) => v && setGender(v)}
          outdoorMode={false}
          allowAll={false}
          options={[
            { value: "male", label: "Male" },
            { value: "female", label: "Female" },
          ]}
        />
        <FilterSelect<AgeGroup>
          label="Age group"
          value={ageGroup}
          onChange={(v) => v && setAgeGroup(v)}
          outdoorMode={false}
          allowAll={false}
          options={[
            { value: "U14", label: "14 & Under" },
            { value: "U17", label: "17 & Under" },
            { value: "Open", label: "Open" },
          ]}
        />
      </div>

      {tab !== "points" && (
        // Deliberately absent on the points board: World Aquatics points exist
        // precisely so swims in DIFFERENT events can be compared, so narrowing
        // it to one event defeats the board. The other two rank times, which
        // are only comparable within a single event, so they need it.
        <FilterSelect<string>
          label="Event"
          value={`${distanceM}|${stroke}`}
          onChange={(v) => {
            if (!v) return;
            const [d, s] = v.split("|");
            setDistanceM(Number(d));
            setStroke(s);
          }}
          outdoorMode={false}
          allowAll={false}
          options={eventOptions}
        />
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as BoardTab)}>
        {/* Stacked on phones: three near-identical labels squeezed into three
            columns wrapped to unreadable slivers, which is what made choosing
            between them hard. Also h-auto — the primitive hard-codes h-9 on
            the list, which clips 48px triggers. */}
        <TabsList className="grid h-auto w-full grid-cols-1 gap-1 p-1 group-data-horizontal/tabs:h-auto sm:grid-cols-3">
          <TabsTrigger value="performers" className="h-auto min-h-[48px] text-sm whitespace-normal">
            Best Performers
          </TabsTrigger>
          <TabsTrigger value="performances" className="h-auto min-h-[48px] text-sm whitespace-normal">
            Best Performances in Each Event
          </TabsTrigger>
          <TabsTrigger value="points" className="h-auto min-h-[48px] text-sm whitespace-normal">
            Best Performance (Points)
          </TabsTrigger>
        </TabsList>

        <TabsContent value="performers" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>
                Fastest swimmers — {distanceM}m {stroke} · {AGE_GROUP_LABELS[ageGroup]} · {gender}
              </CardTitle>
              <CardDescription>
                One entry per athlete (personal best). Ranked across all SSC meets.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {performers.length === 0 && (
                <p className="text-sm text-muted-foreground">No performances for this filter.</p>
              )}
              {performers.map((row) => (
                <div
                  key={`${row.athleteId}-${row.rank}`}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <div className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-bold">
                    {row.rank}
                  </div>
                  <div className="min-w-0 flex-1">
                    <AthleteLink athleteId={row.athleteId} name={row.athleteName} />
                    <p className="text-xs text-muted-foreground">
                      {row.teamName ?? "Unaffiliated"} · {row.racesCounted} races · set at age {row.ageAtSwim}
                    </p>
                  </div>
                  <p className="font-mono text-lg font-semibold tabular-nums">
                    {formatTimeMs(row.bestTimeMs)}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="performances" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>
                Best performances in {distanceM}m {stroke} — {AGE_GROUP_LABELS[ageGroup]} · {gender}
              </CardTitle>
              <CardDescription>
                Every race time ever swum in this event, ranked — the same swimmer may appear
                more than once. All-time only: scoped to a single meet this would just be that
                event&apos;s result sheet again.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {performances.length === 0 && (
                <p className="text-sm text-muted-foreground">No performances for this filter.</p>
              )}
              {performances.map((row) => (
                <div
                  key={row.resultId}
                  className="flex items-center gap-3 rounded-lg border p-3"
                >
                  <div className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-bold">
                    {row.rank}
                  </div>
                  <div className="min-w-0 flex-1">
                    <AthleteLink athleteId={row.athleteId} name={row.athleteName} />
                    <p className="text-xs text-muted-foreground">{row.teamName ?? "Unaffiliated"}</p>
                    <p className="text-xs text-muted-foreground">
                      {describeAgeAtSwim(row.ageAtSwim, row.volumeName ?? "SSC")}
                    </p>
                  </div>
                  <p className="font-mono text-lg font-semibold tabular-nums">
                    {formatTimeMs(row.officialTimeMs)}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="points" className="mt-4">
          <DataErrorBanner error={pointsError} subject="the World Aquatics points ranking" />
          <Card>
            <CardHeader>
              <CardTitle>
                Best Performance (World Aquatics points) — {AGE_GROUP_LABELS[ageGroup]} · {gender}
              </CardTitle>
              <CardDescription>
                Ranked by World Aquatics points (short course), so swims in different events
                compare directly — the higher the points, the better the swim. There is no event
                filter here on purpose: comparing across events is the whole point of the board.
                The 50m switch events have no points system and never appear.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {pointsPerformances.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No scored performances yet for this filter.
                </p>
              )}
              {pointsPerformances.map((row) => (
                <div key={row.resultId} className="flex items-center gap-3 rounded-lg border p-3">
                  <div className="flex size-9 items-center justify-center rounded-full bg-muted text-sm font-bold">
                    {row.rank}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <AthleteLink athleteId={row.athleteId} name={row.athleteName} />
                      <PerformanceBadges
                        isBestOverall={row.isBestOverall}
                        isBestInEvent={row.isBestInEvent}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {row.eventName} · {formatTimeMs(row.officialTimeMs)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.teamName ?? "Unaffiliated"} · {row.volumeName}
                    </p>
                  </div>
                  <p className="font-mono text-lg font-semibold tabular-nums">
                    {row.waPoints}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">pts</span>
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}
