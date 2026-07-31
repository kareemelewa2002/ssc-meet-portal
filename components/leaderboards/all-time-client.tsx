"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import { AthleteLink } from "@/components/athletes/athlete-link";
import {
  DEMO_ALL_TIME_RACES,
  fetchAllTimePerformances,
  rankBestPerformances,
  rankBestPerformers,
  type RacePerformance,
} from "@/lib/all-time-rankings";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { formatTimeMs } from "@/lib/format";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

export function AllTimeClient() {
  const [races, setRaces] = useState<RacePerformance[]>(DEMO_ALL_TIME_RACES);
  const [gender, setGender] = useState<Gender>("male");
  const [ageGroup, setAgeGroup] = useState<AgeGroup>("Open");
  const [stroke, setStroke] = useState<string>("Freestyle");
  const [distanceM, setDistanceM] = useState<number>(50);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const data = await fetchAllTimePerformances();
      if (!cancelled) setRaces(data);
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
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
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
            { value: "U13_14", label: "U13-14" },
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
        <TabsList className="grid h-auto w-full grid-cols-2">
          <TabsTrigger value="performers" className="min-h-[48px]">
            Best Performers
          </TabsTrigger>
          <TabsTrigger value="performances" className="min-h-[48px]">
            Best Performances
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
                      {row.teamName ?? "Unaffiliated"} · {row.racesCounted} races
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
                    <p className="text-xs text-muted-foreground">
                      {row.volumeName ?? "SSC"} · {row.teamName ?? "Unaffiliated"}
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
      </Tabs>
    </main>
  );
}
