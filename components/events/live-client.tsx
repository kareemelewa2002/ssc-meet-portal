"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Radio } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { heatTitle } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";
import { OutdoorModeToggle } from "@/components/layout/outdoor-mode-toggle";
import { FilterSelect } from "@/components/events/filter-select";
import { fetchSessionsForVolume, fetchVolumeByNumber } from "@/lib/volumes";
import {
  fetchEventResultsForSession,
  fetchEventSessionNumber,
  fetchLiveEventsForSession,
  fetchLiveEventsForSessions,
  type EventResultView,
  type LiveEventView,
  type LiveHeatView,
  type LiveLaneView,
  fetchPerformanceHighlights,
  type PerformanceHighlight,
} from "@/lib/live-heats";
import { formatTimeMs, timeDropSeconds } from "@/lib/format";
import { DQ_REASON_LABELS, compareResultStanding } from "@/lib/results";
import { compareByCategory } from "@/lib/category-order";
import { formatWaPoints } from "@/lib/wa-points";
import type { AgeGroup, Gender, MeetVolumeRow, SessionRow } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { AGE_GROUP_LABELS, AGE_GROUP_SHORT_LABELS } from "@/lib/athletes";
import { PerformanceBadges } from "@/components/results/performance-badges";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkeletonLane } from "@/components/ui/skeleton";

function LaneRow({
  lane,
  outdoorMode,
  highlight,
}: {
  lane: LiveLaneView;
  outdoorMode: boolean;
  highlight?: PerformanceHighlight;
}) {
  const drop =
    lane.result?.outcome === "valid"
      ? timeDropSeconds(lane.seedTimeMs, lane.result.officialTimeMs)
      : null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg border p-3",
        outdoorMode ? "border-yellow-300/30" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex min-w-[48px] items-center justify-center rounded-lg border-2 border-black px-2 py-1.5 font-telemetry text-sm font-extrabold",
          outdoorMode ? "bg-yellow-300 text-black" : "bg-muted",
        )}
      >
        L{lane.laneNumber}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate font-medium",
            lane.result?.outcome === "dq" && "line-through opacity-60",
            outdoorMode && "text-yellow-300",
          )}
        >
          <AthleteLink
            athleteId={lane.athleteId}
            name={lane.athleteName}
            className={outdoorMode ? "text-yellow-300" : undefined}
          />
        </p>
        {highlight && (
          <div className="mt-0.5">
            <PerformanceBadges
              isBestOverall={highlight.isBestOverall}
              isBestInEvent={highlight.isBestInEvent}
              outdoorMode={outdoorMode}
            />
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {lane.teamName && (
            <span
              className={cn("text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}
            >
              {lane.teamName}
            </span>
          )}
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
            {AGE_GROUP_SHORT_LABELS[lane.ageGroup]}
          </Badge>
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">
            {lane.gender}
          </Badge>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={cn(
            "font-telemetry text-xs",
            outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
          )}
        >
          Seed {lane.isNt ? "NT" : formatTimeMs(lane.seedTimeMs)}
        </p>
        {lane.awaitingApproval && (
          // A referee has entered a time; an admin has not published it. The
          // time itself is deliberately not shown — it is not official yet.
          <Badge variant="outline" className="mt-1 h-5 px-1.5 text-[10px]">
            Awaiting approval
          </Badge>
        )}
        {lane.result && (
          <div className="mt-1">
            {lane.result.outcome === "dq" ? (
              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                DQ — {lane.result.dqCode ? DQ_REASON_LABELS[lane.result.dqCode] : "Disqualified"}
              </Badge>
            ) : lane.result.outcome === "no_show" ? (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                NS — No Show
              </Badge>
            ) : (
              <div className="flex items-center justify-end gap-1.5">
                {lane.result.finishPlace && (
                  <Badge
                    className={cn(
                      "h-5 px-1.5 font-telemetry text-[10px]",
                      // Podium places get their own accent so the top three
                      // read at a glance from the far side of the pool.
                      lane.result.finishPlace === 1 && "bg-neon-lime text-black",
                      lane.result.finishPlace === 2 && "bg-neon-cyan text-black",
                      lane.result.finishPlace === 3 && "bg-neon-violet text-white",
                    )}
                  >
                    #{lane.result.finishPlace}
                  </Badge>
                )}
                <span
                  className={cn(
                    "font-telemetry text-sm font-bold",
                    outdoorMode && "text-yellow-300",
                  )}
                >
                  {formatTimeMs(lane.result.officialTimeMs)}
                </span>
                {/* Always rendered on a scored lane. A swim with no
                    highlight row is one whose event has no base time (the
                    switch events, relays) — deliberately unrateable, which
                    an em dash says and a blank space does not. Never a 0:
                    that would read as a real score of nought. */}
                <span
                  className={cn(
                    "font-telemetry text-[10px] font-bold",
                    outdoorMode ? "text-yellow-100/80" : "text-muted-foreground",
                  )}
                  title="World Aquatics points (short course)"
                >
                  {formatWaPoints(highlight?.waPoints)} pts
                </span>
                {drop != null && (
                  // Seed -> official delta. A drop is the whole point of the
                  // series' Progress scoring, so it gets the lime glow.
                  <span
                    className={cn(
                      "rounded-full border-2 border-black px-1.5 font-telemetry text-[10px] font-bold",
                      drop > 0 ? "bg-neon-lime text-black" : "bg-neon-orange text-black",
                    )}
                  >
                    {drop > 0 ? "-" : "+"}
                    {Math.abs(drop).toFixed(2)}s
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function HeatCard({
  heat,
  eventId,
  outdoorMode,
  highlights,
}: {
  heat: LiveHeatView;
  eventId: string;
  outdoorMode: boolean;
  highlights: Map<string, PerformanceHighlight>;
}) {
  return (
    <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
        <Badge className="h-7 px-2.5">{heatTitle(heat)}</Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {heat.lanes.map((lane) => (
          <LaneRow
            key={lane.laneNumber}
            lane={lane}
            outdoorMode={outdoorMode}
            highlight={highlights.get(`${lane.athleteId}:${eventId}`)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Drives BOTH per-meet views:
 *   mode="heats"   — the heat sheet: every seeded lane, by session.
 *   mode="results" — only lanes with a published result, plus an event filter.
 *
 * They share sessions, filters, realtime and the lane renderer, so splitting
 * them into two components would have meant maintaining two copies of the
 * same subscription and filter logic.
 */
export function LiveEventsClient({
  volId,
  mode = "heats",
}: {
  volId: string;
  mode?: "heats" | "results";
}) {
  const isResults = mode === "results";
  const { outdoorMode } = useOutdoorMode();
  const searchParams = useSearchParams();

  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  // "all" lists every race in the meet in the order they are swum, and is the
  // default: someone looking for one swimmer should not have to already know
  // which session their race was in. An explicit ?session=N still wins, so
  // existing deep links keep working.
  const [sessionNumber, setSessionNumber] = useState<1 | 2 | 3 | "all">(() => {
    const n = Number(searchParams.get("session"));
    return n === 1 || n === 2 || n === 3 ? n : "all";
  });
  // A single-event deep link (?event=<id>) scopes the whole page to just
  // that event's heats — never a session-wide (let alone site-wide) wall.
  const eventFilterId = searchParams.get("event");
  const [events, setEvents] = useState<LiveEventView[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [live, setLive] = useState(false);
  // A failed query must never look like an empty schedule — see
  // lib/fetch-policy.ts for why this exists.
  const [dataError, setDataError] = useState<string | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);

  const [genderFilter, setGenderFilter] = useState<Gender | null>(null);
  const [ageFilter, setAgeFilter] = useState<AgeGroup | null>(null);
  const [eventNameFilter, setEventNameFilter] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Map<string, PerformanceHighlight>>(new Map());
  const [eventResults, setEventResults] = useState<EventResultView[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const volResult = await fetchVolumeByNumber(volId);
      if (cancelled) return;
      setVolume(volResult.data);
      if (volResult.error) {
        setDataError(volResult.error);
        return;
      }
      if (volResult.data) {
        const sess = await fetchSessionsForVolume(volResult.data);
        if (cancelled) return;
        setSessions(sess.data);
        if (sess.error) setDataError(sess.error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [volId]);

  // Deep-linking straight to an event doesn't always carry ?session= — look
  // up which session it belongs to so the right tab (and thus the right
  // fetch) is selected before we filter down to that one event below.
  useEffect(() => {
    if (!eventFilterId || searchParams.get("session")) return;
    let cancelled = false;
    (async () => {
      const sess = await fetchEventSessionNumber(eventFilterId);
      if (!cancelled && (sess === 1 || sess === 2 || sess === 3)) setSessionNumber(sess);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventFilterId, searchParams]);

  const showingAll = sessionNumber === "all";
  const currentSession = useMemo(
    () => (showingAll ? null : sessions.find((s) => s.session_number === sessionNumber) ?? null),
    [sessions, sessionNumber, showingAll],
  );
  const volumeId = volume?.id ?? currentSession?.meet_volume_id ?? null;

  const loadEvents = useCallback(async () => {
    if (showingAll ? sessions.length === 0 : !currentSession) return;

    const result = showingAll
      ? await fetchLiveEventsForSessions(sessions)
      : await fetchLiveEventsForSession(currentSession!.id);
    setEvents(result.data);
    setDataError(result.error);
    setUsedFallback(result.usedFallback);
    setLoadingEvents(false);

    // Overall standings and points/badges only matter on the results view.
    if (isResults) {
      const targets = showingAll ? sessions : [currentSession!];
      const standings = await Promise.all(targets.map((s) => fetchEventResultsForSession(s.id)));
      setEventResults(standings.flatMap((r) => r.data));

      // These errors were previously dropped on the floor, so a failing
      // event_results query (a column the live database does not have yet,
      // say) rendered as the perfectly calm "No results published yet" —
      // indistinguishable from a meet nobody had scored. That is precisely
      // the silent-failure mode lib/fetch-policy.ts exists to prevent.
      const standingsError = standings.find((r) => r.error)?.error ?? null;
      const hl = volumeId ? await fetchPerformanceHighlights(volumeId) : null;
      if (hl) setHighlights(hl.data);
      if (standingsError || hl?.error) {
        setDataError(standingsError ?? hl?.error ?? null);
      }
    }
  }, [currentSession, isResults, sessions, showingAll, volumeId]);

  useEffect(() => {
    setLoadingEvents(true);
    void loadEvents();
  }, [loadEvents]);

  // Real-time: any change to results or heats in this session triggers a refetch.
  useEffect(() => {
    if (!currentSession || currentSession.id.startsWith("demo-")) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`live-session-${currentSession.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "results" }, () => {
        void loadEvents();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "heats" }, () => {
        void loadEvents();
      })
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      void supabase.removeChannel(channel);
      setLive(false);
    };
  }, [currentSession, loadEvents]);


  const filteredEvents = useMemo(() => {
    return events
      .filter((ev) => !eventFilterId || ev.eventId === eventFilterId)
      .filter((ev) => !eventNameFilter || ev.name === eventNameFilter)
      .map((ev) => ({
        ...ev,
        heats: ev.heats
          .map((heat) => ({
            ...heat,
            lanes: heat.lanes
              .filter(
                (lane) =>
                  (!genderFilter || lane.gender === genderFilter) &&
                  (!ageFilter || lane.ageGroup === ageFilter) &&
                  // Results view shows only swum lanes; the heat sheet shows
                  // every seeded lane whether or not it has been scored.
                  (!isResults || lane.result != null),
              )
              // On the heat sheet a lane list IS the pool, so lane order is
              // the only honest order. On the results view it is a standing,
              // so it ranks — with DQ and NS below every valid swim.
              .sort((a, b) =>
                isResults
                  ? compareResultStanding(
                      {
                        outcome: a.result?.outcome,
                        place: a.result?.finishPlace,
                        officialTimeMs: a.result?.officialTimeMs,
                      },
                      {
                        outcome: b.result?.outcome,
                        place: b.result?.finishPlace,
                        officialTimeMs: b.result?.officialTimeMs,
                      },
                    ) || a.laneNumber - b.laneNumber
                  : a.laneNumber - b.laneNumber,
              ),
          }))
          .filter((heat) => heat.lanes.length > 0)
          // Category running order: 14&U Women, 14&U Men, 17&U/Open Women,
          // 17&U/Open Men — the same order /admin/seeding and /referee use.
          .sort(compareByCategory),
      }))
      .filter((ev) => ev.heats.length > 0);
  }, [events, eventFilterId, eventNameFilter, genderFilter, ageFilter, isResults]);

  const eventNames = useMemo(() => Array.from(new Set(events.map((e) => e.name))), [events]);

  // The results view is driven by the ranked standings, not by heats — so the
  // filters and the empty state have to key off these rows, or filtering to a
  // combination with no swimmers would still render an empty rankings block.
  const visibleEventResults = useMemo(
    () =>
      eventResults
        .filter((r) => !eventFilterId || r.eventId === eventFilterId)
        .filter((r) => !eventNameFilter || r.eventName === eventNameFilter)
        .filter((r) => !genderFilter || r.gender === genderFilter)
        .filter((r) => !ageFilter || r.ageGroup === ageFilter)
        // The view already orders places ascending with nulls last, but the
        // rows are stitched together from several per-session fetches — so
        // the standing is only guaranteed ordered once it is sorted here.
        .sort((a, b) =>
          compareResultStanding(
            { outcome: a.outcome, place: a.eventPlace, officialTimeMs: a.officialTimeMs },
            { outcome: b.outcome, place: b.eventPlace, officialTimeMs: b.officialTimeMs },
          ),
        ),
    [eventResults, eventFilterId, eventNameFilter, genderFilter, ageFilter],
  );

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
          <div className="flex items-center gap-2">
            {live && (
              <Badge
                className={cn(
                  "gap-1.5 font-telemetry tracking-widest uppercase",
                  outdoorMode
                    ? "border-yellow-300 bg-yellow-300 text-black"
                    : "border-black bg-neon-cyan text-black",
                )}
              >
                <span className="animate-pulse-ring inline-flex size-2 rounded-full bg-black" />
                Live
              </Badge>
            )}
            <OutdoorModeToggle />
          </div>
        </div>

        <header>
          <h1 className={cn("text-xl font-bold sm:text-2xl", outdoorMode && "text-yellow-300")}>
            {volume?.name ?? "Meet"} — {isResults ? "Results" : "Heat Sheets"}
          </h1>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            {isResults
              ? "Every race in the order it was swum, with official times, World Aquatics points and DQ/NS codes. Filter by session, event, age group, or gender."
              : "Every race in the order it is swum, with lane assignments and seed times. Filter by session, event, age group, or gender."}
          </p>
        </header>

        <DataErrorBanner
          error={dataError}
          usedFallback={usedFallback}
          subject={isResults ? "results" : "heat sheets"}
          onRetry={() => void loadEvents()}
        />

        {eventFilterId ? (
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm",
              outdoorMode ? "border-yellow-300/40 bg-black" : "bg-muted/40",
            )}
          >
            <span>
              Showing <strong>{filteredEvents[0]?.name ?? "this event"}</strong> only.
            </span>
            <Link
              href={`/events/${volId}/live?session=${sessionNumber === "all" ? 1 : sessionNumber}`}
              className={cn(
                "min-h-[40px] rounded-md px-2 text-xs font-medium underline underline-offset-4",
                outdoorMode ? "text-yellow-300" : "text-primary",
              )}
            >
              View full session
            </Link>
          </div>
        ) : (
          <Tabs
            value={String(sessionNumber)}
            onValueChange={(v) => setSessionNumber(v === "all" ? "all" : (Number(v) as 1 | 2 | 3))}
          >
            <TabsList
              className={cn(
                // The list variant hard-codes group-data-horizontal/tabs:h-9;
                // override at the same specificity or 48px triggers overflow it.
                "grid h-auto w-full grid-cols-4 gap-1 p-1 group-data-horizontal/tabs:h-auto",
                outdoorMode ? "border-yellow-300/60 bg-black" : "bg-muted",
              )}
            >
              {(["all", 1, 2, 3] as const).map((n) => (
                <TabsTrigger
                  key={String(n)}
                  value={String(n)}
                  className={cn(
                    // h-auto defeats the primitive's h-[calc(100%-1px)],
                    // which overflowed the padded pill container.
                    "h-auto min-h-[48px] rounded-lg border-2 text-sm font-bold tracking-tight",
                    // Inactive pills need real contrast on the pool deck —
                    // the default 60% foreground washed out under glare.
                    outdoorMode
                      ? "text-yellow-100/70 data-active:border-yellow-300 data-active:bg-yellow-300 data-active:text-black"
                      : "text-foreground/70 data-active:bg-background data-active:text-foreground",
                  )}
                >
                  {n === "all" ? "All Races" : `Session ${n}`}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        <div className="flex flex-wrap gap-4">
          <FilterSelect
            label="Gender"
            value={genderFilter}
            onChange={setGenderFilter}
            outdoorMode={outdoorMode}
            options={[
              { value: "male", label: "Male" },
              { value: "female", label: "Female" },
            ]}
          />
          <FilterSelect
            label="Age Group"
            value={ageFilter}
            onChange={setAgeFilter}
            outdoorMode={outdoorMode}
            options={[
              { value: "U14", label: AGE_GROUP_LABELS.U14 },
              { value: "U17", label: AGE_GROUP_LABELS.U17 },
              { value: "Open", label: "Open" },
            ]}
          />
          {isResults && eventNames.length > 0 && (
            <FilterSelect
              label="Event"
              value={eventNameFilter}
              onChange={setEventNameFilter}
              outdoorMode={outdoorMode}
              options={eventNames.map((n) => ({ value: n, label: n }))}
            />
          )}
        </div>

        {loadingEvents ? (
          <div className="space-y-3" role="status" aria-busy="true">
            <span className="sr-only">Loading heat sheets</span>
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonLane key={i} />
            ))}
          </div>
        ) : (
            isResults
              ? visibleEventResults.length === 0 &&
                // Skins results live outside the time-ranked standings, so a
                // meet where only Skins has been published is not empty.
                filteredEvents.filter((ev) => ev.isSkins).length === 0
              : filteredEvents.length === 0
          ) ? (
          <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
            <CardContent className="py-8 text-center">
              <Radio
                className={cn(
                  "mx-auto mb-2 size-8",
                  outdoorMode ? "text-yellow-300/60" : "text-muted-foreground",
                )}
              />
              <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
                {dataError
                  ? "Couldn’t be loaded — see the error above."
                  : isResults
                    ? eventResults.length === 0
                      // A referee's entries are drafts until an admin publishes
                      // them, so "nothing here" genuinely means nothing has been
                      // approved — not that nothing has been swum.
                      ? "No results published yet — times appear here once an admin approves the referee's heat card."
                      : "No published results match the selected filters."
                    : events.length === 0
                      ? "No heat sheets published yet — check back soon."
                      : "No swimmers match the selected filters."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {isResults && visibleEventResults.length > 0 && (
              <section aria-label="Overall event standings" className="space-y-3">
                <div>
                  <h2 className={cn("text-base font-bold", outdoorMode && "text-yellow-300")}>
                    Results by rank
                  </h2>
                  <p
                    className={cn(
                      "text-xs",
                      outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
                    )}
                  >
                    Ranked across every heat of the event — heats are seeded by speed, so winning
                    heat 1 is not the same as winning the event. Open is open to all ages, so U14
                    and U17 swimmers are ranked there against the Open field as well as in their
                    own age group.
                  </p>
                </div>
                {Object.entries(
                  visibleEventResults
                    .reduce<Record<string, EventResultView[]>>((acc, r) => {
                      const key = `${r.eventName} · ${r.ageGroup} · ${r.gender}`;
                      (acc[key] ??= []).push(r);
                      return acc;
                    }, {}),
                ).map(([group, rows]) => (
                  <Card key={group} className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
                    <CardHeader className="pb-2">
                      <p
                        className={cn(
                          "text-xs font-bold tracking-wide uppercase",
                          outdoorMode ? "text-yellow-300" : "text-muted-foreground",
                        )}
                      >
                        {group}
                      </p>
                    </CardHeader>
                    <CardContent className="space-y-1.5">
                      {rows.map((r) => (
                        <div
                          key={r.athleteId}
                          className={cn(
                            "flex items-center gap-3 rounded-lg border-2 p-2",
                            outdoorMode ? "border-yellow-300/30" : "border-border",
                            // DQ and NS are shown, sorted below every valid
                            // swim, rather than dropped from the standing —
                            // "not in the list" reads as "never entered".
                            r.eventPlace == null && "opacity-70",
                          )}
                        >
                          {r.eventPlace == null ? (
                            <Badge
                              variant={r.outcome === "dq" ? "destructive" : "secondary"}
                              className="h-6 min-w-[34px] justify-center font-telemetry text-[11px]"
                            >
                              {r.outcome === "dq" ? "DQ" : "NS"}
                            </Badge>
                          ) : (
                            <Badge
                              className={cn(
                                "h-6 min-w-[34px] justify-center font-telemetry text-[11px]",
                                r.eventPlace === 1 && "bg-neon-lime text-black",
                                r.eventPlace === 2 && "bg-neon-cyan text-black",
                                r.eventPlace === 3 && "bg-neon-violet text-white",
                              )}
                            >
                              #{r.eventPlace}
                            </Badge>
                          )}
                          <div className="min-w-0 flex-1">
                            <AthleteLink
                              athleteId={r.athleteId}
                              name={r.athleteName}
                              className={cn(
                                "truncate",
                                outdoorMode && "text-yellow-300",
                                r.outcome === "dq" && "line-through",
                              )}
                            />
                            <p
                              className={cn(
                                "truncate text-xs",
                                outdoorMode ? "text-yellow-100/60" : "text-muted-foreground",
                              )}
                            >
                              {r.teamName ? `${r.teamName} · ` : ""}heat {r.heatNumber}
                              {r.isOpenEntry ? ` · ${AGE_GROUP_LABELS[r.ownAgeGroup]} swimmer` : ""}
                              {r.outcome === "dq" && r.dqCode
                                ? ` · ${DQ_REASON_LABELS[r.dqCode]}`
                                : ""}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            <span
                              className={cn(
                                "block font-telemetry text-sm font-bold",
                                outdoorMode && "text-yellow-300",
                              )}
                            >
                              {formatTimeMs(r.officialTimeMs)}
                            </span>
                            {/* An em dash, never a 0: relays, Skins and the
                                switch events have no base time on file and
                                are unrateable by design. */}
                            <span
                              className={cn(
                                "block font-telemetry text-[10px]",
                                outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
                              )}
                              title="World Aquatics points (short course)"
                            >
                              {formatWaPoints(r.waPoints)} pts
                            </span>
                          </div>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                ))}
              </section>
            )}

            {/* Skins is placed by eye and has no times, so it can never appear
                in the time-ranked standings above — it would be missing from
                the results page entirely. Its rounds are listed here instead,
                in the same running order as every other race. */}
            {(isResults ? filteredEvents.filter((ev) => ev.isSkins) : filteredEvents).map((ev) => (
              <div key={ev.eventId} className="space-y-2">
                <h2
                  className={cn(
                    "flex flex-wrap items-center gap-2 text-base font-bold",
                    outdoorMode && "text-yellow-300",
                  )}
                >
                  {ev.name}
                  {showingAll && ev.sessionNumber != null && (
                    // In the combined list the session is no longer implied by
                    // a selected tab, so each race has to say where it sits.
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                      Session {ev.sessionNumber}
                    </Badge>
                  )}
                </h2>
                <div className="space-y-3">
                  {ev.heats.map((heat) => (
                    <HeatCard
                      key={heat.heatId}
                      heat={heat}
                      eventId={ev.eventId}
                      outdoorMode={outdoorMode}
                      highlights={highlights}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
