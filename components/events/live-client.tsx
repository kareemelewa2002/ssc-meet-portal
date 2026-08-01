"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, Radio } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";
import { OutdoorModeToggle } from "@/components/layout/outdoor-mode-toggle";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import { fetchSessionsForVolume, fetchVolumeByNumber } from "@/lib/volumes";
import {
  fetchEventSessionNumber,
  fetchLiveEventsForSession,
  type LiveEventView,
  type LiveHeatView,
  type LiveLaneView,
} from "@/lib/live-heats";
import { formatTimeMs, timeDropSeconds } from "@/lib/format";
import { DQ_REASON_LABELS } from "@/lib/results";
import type { AgeGroup, Gender, MeetVolumeRow, SessionRow } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";

const AGE_GROUP_LABELS: Record<AgeGroup, string> = {
  U13_14: "U13-14",
  U17: "U17",
  Open: "Open",
};

function LaneRow({ lane, outdoorMode }: { lane: LiveLaneView; outdoorMode: boolean }) {
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
          "flex min-w-[44px] items-center justify-center rounded-md px-2 py-1 text-sm font-bold",
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
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
          {lane.teamName && (
            <span
              className={cn("text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}
            >
              {lane.teamName}
            </span>
          )}
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
            {AGE_GROUP_LABELS[lane.ageGroup]}
          </Badge>
          <Badge variant="outline" className="h-5 px-1.5 text-[10px] capitalize">
            {lane.gender}
          </Badge>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={cn(
            "font-mono text-xs",
            outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
          )}
        >
          Seed {lane.isNt ? "NT" : formatTimeMs(lane.seedTimeMs)}
        </p>
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
                  <Badge className="h-5 px-1.5 text-[10px]">#{lane.result.finishPlace}</Badge>
                )}
                <span className={cn("font-mono text-sm font-bold", outdoorMode && "text-yellow-300")}>
                  {formatTimeMs(lane.result.officialTimeMs)}
                </span>
                {drop != null && (
                  <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                    -{drop.toFixed(2)}s
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

function HeatCard({ heat, outdoorMode }: { heat: LiveHeatView; outdoorMode: boolean }) {
  return (
    <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
      <CardHeader className="flex-row items-center gap-2 space-y-0 pb-2">
        <Badge className="h-7 px-2.5">Heat {heat.heatNumber}</Badge>
        <Badge variant="outline">{heat.heatGroup === "U13_14" ? "U13-14" : "U17 & Open"}</Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {heat.lanes.map((lane) => (
          <LaneRow key={lane.laneNumber} lane={lane} outdoorMode={outdoorMode} />
        ))}
      </CardContent>
    </Card>
  );
}

export function LiveEventsClient({ volId }: { volId: string }) {
  const { outdoorMode } = useOutdoorMode();
  const searchParams = useSearchParams();

  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionNumber, setSessionNumber] = useState<1 | 2 | 3>(() => {
    const raw = Number(searchParams.get("session"));
    return raw === 2 || raw === 3 ? raw : 1;
  });
  // A single-event deep link (?event=<id>) scopes the whole page to just
  // that event's heats — never a session-wide (let alone site-wide) wall.
  const eventFilterId = searchParams.get("event");
  const [events, setEvents] = useState<LiveEventView[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [live, setLive] = useState(false);

  const [genderFilter, setGenderFilter] = useState<Gender | null>(null);
  const [ageFilter, setAgeFilter] = useState<AgeGroup | null>(null);
  const [strokeFilter, setStrokeFilter] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vol = await fetchVolumeByNumber(Number(volId));
      if (cancelled) return;
      setVolume(vol);
      if (vol) {
        const sess = await fetchSessionsForVolume(vol);
        if (!cancelled) setSessions(sess);
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

  const currentSession = useMemo(
    () => sessions.find((s) => s.session_number === sessionNumber) ?? null,
    [sessions, sessionNumber],
  );

  const loadEvents = useCallback(async () => {
    if (!currentSession) return;
    const data = await fetchLiveEventsForSession(currentSession.id);
    setEvents(data);
    setLoadingEvents(false);
  }, [currentSession]);

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

  const strokes = useMemo(() => Array.from(new Set(events.map((e) => e.stroke))), [events]);

  const filteredEvents = useMemo(() => {
    return events
      .filter((ev) => !eventFilterId || ev.eventId === eventFilterId)
      .filter((ev) => !strokeFilter || ev.stroke === strokeFilter)
      .map((ev) => ({
        ...ev,
        heats: ev.heats
          .map((heat) => ({
            ...heat,
            lanes: heat.lanes.filter(
              (lane) =>
                (!genderFilter || lane.gender === genderFilter) &&
                (!ageFilter || lane.ageGroup === ageFilter),
            ),
          }))
          .filter((heat) => heat.lanes.length > 0),
      }))
      .filter((ev) => ev.heats.length > 0);
  }, [events, eventFilterId, strokeFilter, genderFilter, ageFilter]);

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
              <Badge variant="outline" className="gap-1.5 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                </span>
                Live
              </Badge>
            )}
            <OutdoorModeToggle />
          </div>
        </div>

        <header>
          <h1 className={cn("text-xl font-bold sm:text-2xl", outdoorMode && "text-yellow-300")}>
            {volume?.name ?? "Meet"} — Heat Sheets & Results
          </h1>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            Results update automatically as they&apos;re published.
          </p>
        </header>

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
              href={`/events/${volId}/live?session=${sessionNumber}`}
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
            onValueChange={(v) => setSessionNumber(Number(v) as 1 | 2 | 3)}
          >
            <TabsList className="grid h-auto w-full grid-cols-3">
              {[1, 2, 3].map((n) => (
                <TabsTrigger key={n} value={String(n)} className="min-h-[48px] flex-col gap-0 text-xs">
                  <span className="font-semibold">Session {n}</span>
                  <span className="text-[10px] opacity-70">
                    {n === 1 ? "9AM–12PM" : n === 2 ? "2PM–4PM" : "5PM–7PM · Skins"}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}

        <div className="flex flex-wrap gap-4">
          <FilterPillGroup
            label="Gender"
            value={genderFilter}
            onChange={setGenderFilter}
            outdoorMode={outdoorMode}
            options={[
              { value: "male", label: "Male" },
              { value: "female", label: "Female" },
            ]}
          />
          <FilterPillGroup
            label="Age Group"
            value={ageFilter}
            onChange={setAgeFilter}
            outdoorMode={outdoorMode}
            options={[
              { value: "U13_14", label: "U13-14" },
              { value: "U17", label: "U17" },
              { value: "Open", label: "Open" },
            ]}
          />
          {strokes.length > 0 && (
            <FilterPillGroup
              label="Stroke"
              value={strokeFilter}
              onChange={setStrokeFilter}
              outdoorMode={outdoorMode}
              options={strokes.map((s) => ({ value: s, label: s }))}
            />
          )}
        </div>

        {loadingEvents ? (
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
            Loading heat sheets…
          </p>
        ) : filteredEvents.length === 0 ? (
          <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
            <CardContent className="py-8 text-center">
              <Radio
                className={cn(
                  "mx-auto mb-2 size-8",
                  outdoorMode ? "text-yellow-300/60" : "text-muted-foreground",
                )}
              />
              <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
                {events.length === 0
                  ? "No heat sheets published for this session yet — check back soon."
                  : "No swimmers match the selected filters."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {filteredEvents.map((ev) => (
              <div key={ev.eventId} className="space-y-2">
                <h2 className={cn("text-base font-bold", outdoorMode && "text-yellow-300")}>
                  {ev.name}
                </h2>
                <div className="space-y-3">
                  {ev.heats.map((heat) => (
                    <HeatCard key={heat.heatId} heat={heat} outdoorMode={outdoorMode} />
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
