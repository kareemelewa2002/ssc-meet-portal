"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, TrendingUp, Trophy } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { TeamLeaderboard } from "@/components/leaderboards/team-leaderboard";
import { cn } from "@/lib/utils";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";
import { OutdoorModeToggle } from "@/components/layout/outdoor-mode-toggle";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import { fetchVolumeByNumber, isEarliestVolume } from "@/lib/volumes";
import {
  fetchSeriesLeaderboard,
  fetchVolumeLeaderboard,
  type LeaderboardEntryView,
} from "@/lib/leaderboard";
import type { AgeGroup, Gender, MeetVolumeRow } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { DataErrorBanner } from "@/components/ui/data-error-banner";

type Scope = "volume" | "series";
type LeaderboardTab = "champions" | "progress" | "teams";

function LeaderboardRow({
  rank,
  entry,
  metric,
  outdoorMode,
}: {
  rank: number;
  entry: LeaderboardEntryView;
  metric: "placement" | "improvement";
  outdoorMode: boolean;
}) {
  const points = metric === "placement" ? entry.placementPoints : entry.improvementPoints;
  const medalClass =
    rank === 1
      ? "bg-amber-400 text-black"
      : rank === 2
        ? "bg-zinc-300 text-black"
        : rank === 3
          ? "bg-amber-700 text-white"
          : outdoorMode
            ? "bg-yellow-300 text-black"
            : "bg-muted text-foreground";

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border p-3",
        outdoorMode ? "border-yellow-300/30" : "border-border",
      )}
    >
      <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold", medalClass)}>
        {rank}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("truncate font-semibold", outdoorMode && "text-yellow-300")}>
          <AthleteLink
            athleteId={entry.athleteId}
            name={entry.athleteName}
            className={cn("font-semibold", outdoorMode && "text-yellow-300")}
          />
        </p>
        {entry.teamName && (
          <p className={cn("truncate text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}>
            {entry.teamName}
          </p>
        )}
      </div>
      <div className="shrink-0 text-right">
        <p className={cn("text-lg font-bold tabular-nums", outdoorMode && "text-yellow-300")}>
          {points.toFixed(metric === "improvement" ? 1 : 0)}
        </p>
        <p className={cn("text-[10px] uppercase", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}>
          {metric === "placement" ? "pts" : "drop pts"}
        </p>
      </div>
    </div>
  );
}

function ProgressEmptyState({ outdoorMode }: { outdoorMode: boolean }) {
  return (
    <Card className={cn("border-dashed", outdoorMode && "border-yellow-300/40 bg-black")}>
      <CardContent className="flex flex-col items-center gap-3 py-8 text-center">
        <TrendingUp className={cn("size-8", outdoorMode ? "text-yellow-300/70" : "text-muted-foreground")} />
        <div className="max-w-sm space-y-2">
          <p className={cn("font-semibold", outdoorMode && "text-yellow-300")}>
            Progress Leaderboard unlocks in Vol. 2
          </p>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
            The Progress Leaderboard tracks swimmer improvement meet-over-meet across the SSC
            series! Because Vol. 1 is our inaugural meet, time drop points will unlock starting in
            SSC Vol. 2 when swimmers compare their performance against their official Vol. 1
            benchmark times.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export function LeaderboardClient({ volId }: { volId: string }) {
  const { outdoorMode } = useOutdoorMode();
  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [scope, setScope] = useState<Scope>("volume");
  const [gender, setGender] = useState<Gender>("male");
  const [category, setCategory] = useState<AgeGroup>("Open");
  const [tab, setTab] = useState<LeaderboardTab>("champions");
  const [entries, setEntries] = useState<LeaderboardEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vol = await fetchVolumeByNumber(volId);
      if (!cancelled) setVolume(vol.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [volId]);

  const loadEntries = useCallback(async () => {
    if (!volume) return;
    setLoading(true);
    const result =
      scope === "volume"
        ? await fetchVolumeLeaderboard(volume.id, category)
        : await fetchSeriesLeaderboard(category);
    setEntries(result.data);
    setDataError(result.error);
    setLoading(false);
  }, [volume, scope, category]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const ranked = useMemo(() => {
    return entries
      .filter((e) => e.gender === gender)
      .sort((a, b) =>
        tab === "champions"
          ? b.placementPoints - a.placementPoints
          : b.improvementPoints - a.improvementPoints,
      );
  }, [entries, gender, tab]);

  const showProgressEmptyState = volume ? isEarliestVolume(volume.volume_number) : false;

  return (
    <div className={cn("min-h-screen", outdoorMode ? "bg-black text-yellow-300" : "bg-background")}>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/"
            className={cn(
              "flex min-h-[48px] items-center gap-2 text-sm font-medium",
              outdoorMode ? "text-yellow-300" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <ArrowLeft className="size-4" />
            All Events
          </Link>
          <OutdoorModeToggle />
        </div>

        <DataErrorBanner
          error={dataError}
          subject="leaderboard standings"
          onRetry={() => void loadEntries()}
        />

        <header>
          <h1 className={cn("flex items-center gap-2 text-xl font-bold sm:text-2xl", outdoorMode && "text-yellow-300")}>
            <Trophy className="size-6" />
            {volume?.name ?? "Meet"} — Leaderboards
          </h1>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            Each volume keeps its own standings while feeding the overall series total.{" "}
            <Link
              href="/leaderboards/all-time"
              className={cn(
                "font-medium underline-offset-2 hover:underline",
                outdoorMode ? "text-yellow-300" : "text-primary",
              )}
            >
              All-Time Records
            </Link>
          </p>
        </header>

        <div className="flex gap-2">
          <Button
            type="button"
            variant={scope === "volume" ? "default" : "outline"}
            className="min-h-[48px] flex-1"
            onClick={() => setScope("volume")}
          >
            This Volume
          </Button>
          <Button
            type="button"
            variant={scope === "series" ? "default" : "outline"}
            className="min-h-[48px] flex-1"
            onClick={() => setScope("series")}
          >
            Full Series
          </Button>
        </div>

        <div className="flex flex-wrap gap-4">
          <FilterPillGroup
            label="Gender"
            allowAll={false}
            value={gender}
            onChange={(v) => v && setGender(v)}
            outdoorMode={outdoorMode}
            options={[
              { value: "male", label: "Male" },
              { value: "female", label: "Female" },
            ]}
          />
          <FilterPillGroup
            label="Age Bracket"
            allowAll={false}
            value={category}
            onChange={(v) => v && setCategory(v)}
            outdoorMode={outdoorMode}
            options={[
              { value: "U14", label: "14 & Under" },
              { value: "U17", label: "17 & Under" },
              { value: "Open", label: "Open (All Ages)" },
            ]}
          />
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as LeaderboardTab)}>
          <TabsList className="grid h-auto w-full grid-cols-3 group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="champions" className="h-auto min-h-[48px] text-sm">
              Champions
            </TabsTrigger>
            <TabsTrigger value="progress" className="h-auto min-h-[48px] text-sm">
              Progress
            </TabsTrigger>
            <TabsTrigger value="teams" className="h-auto min-h-[48px] text-sm">
              Teams
            </TabsTrigger>
          </TabsList>

          <TabsContent value="champions" className="mt-3 space-y-2">
            {loading ? (
              <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
                Loading standings…
              </p>
            ) : ranked.length === 0 ? (
              <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
                <CardContent className="py-8 text-center">
                  <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
                    No published results yet for this category.
                  </p>
                </CardContent>
              </Card>
            ) : (
              ranked.map((entry, i) => (
                <LeaderboardRow
                  key={entry.athleteId}
                  rank={i + 1}
                  entry={entry}
                  metric="placement"
                  outdoorMode={outdoorMode}
                />
              ))
            )}
          </TabsContent>

          <TabsContent value="progress" className="mt-3 space-y-2">
            {showProgressEmptyState ? (
              <ProgressEmptyState outdoorMode={outdoorMode} />
            ) : loading ? (
              <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
                Loading standings…
              </p>
            ) : ranked.filter((e) => e.improvementPoints > 0).length === 0 ? (
              <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
                <CardContent className="py-8 text-center">
                  <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
                    No time drops recorded yet for this category.
                  </p>
                </CardContent>
              </Card>
            ) : (
              ranked
                .filter((e) => e.improvementPoints > 0)
                .map((entry, i) => (
                  <LeaderboardRow
                    key={entry.athleteId}
                    rank={i + 1}
                    entry={entry}
                    metric="improvement"
                    outdoorMode={outdoorMode}
                  />
                ))
            )}
          </TabsContent>

          <TabsContent value="teams" className="mt-3">
            {/* Team totals sum every member's series points, so this is the
                club-level view of the same standings the athlete tabs show. */}
            <TeamLeaderboard className={cn(outdoorMode && "border-yellow-300/40 bg-black")} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
