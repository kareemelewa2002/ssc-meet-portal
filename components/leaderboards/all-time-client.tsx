"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { PerformanceBadges } from "@/components/results/performance-badges";
import { TeamLeaderboard } from "@/components/leaderboards/team-leaderboard";
import { AppHeader } from "@/components/layout/app-header";
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

export function AllTimeClient() {
  const [races, setRaces] = useState<RacePerformance[]>(DEMO_ALL_TIME_RACES);
  const [pointsRows, setPointsRows] = useState<PointsPerformance[]>([]);
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
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const strokes = useMemo(
    () => [...new Set(races.map((r) => r.stroke))].sort(),
    [races],
  );
  const distances = useMemo(
    () => [...new Set(races.map((r) => r.distanceM))].sort((a, b) => a - b),
    [races],
  );

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
    <div className="min-h-screen">
      <AppHeader title="All-Time Records" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <Link
        href="/athletes"
        className="inline-flex min-h-[48px] items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" /> Athletes
      </Link>

      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">All-Time SSC Records</h1>
        <p className="text-sm text-muted-foreground">
          Best performers (by swimmer) and best performances (by race time) across every volume.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <FilterPillGroup<Gender>
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
        <FilterPillGroup<AgeGroup>
          label="Age group"
          value={ageGroup}
          onChange={(v) => v && setAgeGroup(v)}
          outdoorMode={false}
          allowAll={false}
          options={[
            { value: "U14", label: "U14" },
            { value: "U17", label: "U17" },
            { value: "Open", label: "Open" },
          ]}
        />
      </div>

      <FilterPillGroup<string>
        label="Stroke"
        value={stroke}
        onChange={(v) => v && setStroke(v)}
        outdoorMode={false}
        allowAll={false}
        options={strokes.map((s) => ({ value: s, label: s }))}
      />

      <FilterPillGroup<string>
        label="Distance"
        value={String(distanceM)}
        onChange={(v) => v && setDistanceM(Number(v))}
        outdoorMode={false}
        allowAll={false}
        options={distances.map((d) => ({ value: String(d), label: `${d}m` }))}
      />

      <Tabs defaultValue="performers">
        <TabsList className="grid h-auto w-full grid-cols-3">
          <TabsTrigger value="performers" className="min-h-[48px]">
            Best Performers
          </TabsTrigger>
          <TabsTrigger value="performances" className="min-h-[48px]">
            Best Performances
          </TabsTrigger>
          <TabsTrigger value="points" className="min-h-[48px]">
            Best Performance
          </TabsTrigger>
        </TabsList>

        <TabsContent value="performers" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>
                Fastest swimmers — {distanceM} {stroke} · {AGE_GROUP_LABELS[ageGroup]} · {gender}
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
                Top 10 race times — {distanceM} {stroke} · {AGE_GROUP_LABELS[ageGroup]} · {gender}
              </CardTitle>
              <CardDescription>
                Individual race performances; the same swimmer may appear more than once.
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
          <Card>
            <CardHeader>
              <CardTitle>
                Best Performance — {AGE_GROUP_LABELS[ageGroup]} · {gender}
              </CardTitle>
              <CardDescription>
                Ranked by World Aquatics points (short course), so swims in different events
                compare directly — the higher the points, the better the swim. Stroke and
                distance filters do not apply here; that is the whole point of the board. The
                50m switch events have no points system and never appear.
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

      <TeamLeaderboard />
      </main>
    </div>
  );
}
