"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Radar } from "lucide-react";
import { OutdoorModeToggle } from "@/components/layout/outdoor-mode-toggle";
import { HeatLaneVisualizer } from "@/components/telemetry/heat-lane-visualizer";
import { FilterPillNav } from "@/components/telemetry/filter-pill-nav";
import { TelemetryLeaderboard } from "@/components/telemetry/telemetry-leaderboard";
import {
  SwimmerModal,
  type SwimmerModalTarget,
} from "@/components/telemetry/swimmer-modal";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { heatTitle } from "@/lib/format";
import { fetchVolumeByNumber, fetchSessionsForVolume } from "@/lib/volumes";
import { fetchMeetSettings } from "@/lib/meet-settings";
import { fetchWaBaseTimes, type WaBaseTimes } from "@/lib/wa-points";
import {
  fetchLiveEventsForSession,
  type LiveEventView,
  type LiveLaneView,
} from "@/lib/live-heats";
import {
  ALL_FILTERS,
  applyTelemetryFilters,
  buildEventStandings,
  deriveFilterOptions,
  type TelemetryFilters,
  type TelemetryStanding,
} from "@/lib/telemetry";
import type { MeetVolumeRow, SessionRow } from "@/lib/supabase/types";

const GENDER_LABELS: Record<string, string> = { male: "Men", female: "Women" };

/**
 * Top-level state and data orchestration for the Aquatic Telemetry view
 * (phases 1 and 2 — see TECH_STACK_DECISIONS.md §12). A PARALLEL route:
 * /events/[volId]/heats, /live and /leaderboard are unmodified and keep
 * working exactly as they do today.
 *
 * State is plain useState, matching every other data page in this app (no
 * global store anywhere in this codebase) — session/event/heat/filter
 * selection is page-local UI state, not something another route needs to
 * read.
 *
 * The pill filters are applied to ALREADY-FETCHED events: changing one is a
 * pure re-render with no router navigation and no new query. Only the session
 * picker crosses a network boundary, because only it changes which events
 * exist.
 */
export function TelemetryClient({ volId }: { volId: string }) {
  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [laneCount, setLaneCount] = useState(8);
  const [baseTimes, setBaseTimes] = useState<WaBaseTimes>(new Map());
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [events, setEvents] = useState<LiveEventView[]>([]);
  const [eventId, setEventId] = useState<string | null>(null);
  const [heatIndex, setHeatIndex] = useState(0);
  const [filters, setFilters] = useState<TelemetryFilters>(ALL_FILTERS);
  const [modalTarget, setModalTarget] = useState<SwimmerModalTarget | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const volResult = await fetchVolumeByNumber(volId);
      if (cancelled) return;
      setVolume(volResult.data);
      setDataError(volResult.error);
      if (!volResult.data) {
        setLoading(false);
        return;
      }
      const [sessResult, settingsResult, baseResult] = await Promise.all([
        fetchSessionsForVolume(volResult.data),
        fetchMeetSettings(volResult.data.id),
        fetchWaBaseTimes(),
      ]);
      if (cancelled) return;
      setSessions(sessResult.data);
      setLaneCount(settingsResult.data?.laneCount ?? 8);
      setBaseTimes(baseResult.data);
      setSessionId(sessResult.data[0]?.id ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [volId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    (async () => {
      const result = await fetchLiveEventsForSession(sessionId);
      if (cancelled) return;
      setEvents(result.data);
      setHeatIndex(0);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const options = useMemo(() => deriveFilterOptions(events), [events]);
  const filteredEvents = useMemo(
    () => applyTelemetryFilters(events, filters),
    [events, filters],
  );

  // Selection is derived, not stored-and-corrected: whenever the filters or
  // the session change the current eventId may no longer be in range, and
  // falling back to the first surviving event here means there is never a
  // frame where the board renders against an event the filters excluded.
  const selectedEvent =
    filteredEvents.find((e) => e.eventId === eventId) ??
    filteredEvents[0] ??
    null;
  const selectedHeat =
    selectedEvent?.heats[Math.min(heatIndex, selectedEvent.heats.length - 1)] ??
    null;

  const standings = useMemo(
    () => (selectedEvent ? buildEventStandings(selectedEvent, baseTimes) : []),
    [selectedEvent, baseTimes],
  );

  function openFromLane(lane: LiveLaneView) {
    if (!selectedEvent || !selectedHeat) return;
    setModalTarget({
      athleteId: lane.athleteId,
      athleteName: lane.athleteName,
      teamName: lane.teamName,
      ageGroup: lane.ageGroup,
      eventName: selectedEvent.name,
      stroke: selectedEvent.stroke,
      distanceM: selectedEvent.distanceM,
      heatNumber: selectedHeat.heatNumber,
      laneNumber: lane.laneNumber,
      seedTimeMs: lane.seedTimeMs,
      isNt: lane.isNt,
      officialTimeMs:
        lane.result?.status === "published" ? lane.result.officialTimeMs : null,
      waPoints: null,
    });
  }

  function openFromStanding(standing: TelemetryStanding) {
    if (!selectedEvent) return;
    setModalTarget({
      athleteId: standing.athleteId,
      athleteName: standing.athleteName,
      teamName: standing.teamName,
      ageGroup: standing.ageGroup,
      eventName: selectedEvent.name,
      stroke: selectedEvent.stroke,
      distanceM: selectedEvent.distanceM,
      heatNumber: standing.heatNumber,
      laneNumber: standing.laneNumber,
      seedTimeMs: standing.seedTimeMs,
      isNt: standing.isNt,
      officialTimeMs: standing.officialTimeMs,
      waPoints: standing.waPoints,
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radar
            className="size-5"
            style={{ color: "var(--color-neon-cyan)" }}
          />
          <h1 className="text-xl font-extrabold tracking-tight">
            {volume?.name ?? "Loading…"} — Telemetry
          </h1>
        </div>
        <OutdoorModeToggle />
      </div>

      <DataErrorBanner error={dataError} subject="this meet's telemetry" />

      {!loading && volume && (
        <>
          <div className="flex flex-wrap gap-3">
            <Select
              value={sessionId ?? ""}
              onValueChange={(v) => setSessionId(v)}
            >
              <SelectTrigger
                className="h-auto min-h-[48px] min-w-[9rem]"
                aria-label="Session"
              >
                {/* Select.Value renders the raw value string unless given a
                      render function — the same gotcha FilterSelect already
                      works around (components/events/filter-select.tsx). */}
                <SelectValue>
                  {() => {
                    const s = sessions.find((s) => s.id === sessionId);
                    return s ? `Session ${s.session_number}` : "Session";
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    Session {s.session_number}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={selectedEvent?.eventId ?? ""}
              onValueChange={(v) => {
                setEventId(v);
                setHeatIndex(0);
              }}
            >
              <SelectTrigger
                className="h-auto min-h-[48px] min-w-[12rem] flex-1"
                aria-label="Event"
              >
                <SelectValue>
                  {() => selectedEvent?.name ?? "Event"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {filteredEvents.map((e) => (
                  <SelectItem key={e.eventId} value={e.eventId}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {selectedEvent && selectedEvent.heats.length > 1 && (
              <Select
                value={String(heatIndex)}
                onValueChange={(v) => setHeatIndex(Number(v))}
              >
                <SelectTrigger
                  className="h-auto min-h-[48px] min-w-[8rem]"
                  aria-label="Heat"
                >
                  {/* heatTitle, not the bare number: heat_number restarts
                        per age board AND gender, so a plain "Heat 1" appears
                        several times in one event's list and picks the wrong
                        heat. */}
                  <SelectValue>
                    {() => (selectedHeat ? heatTitle(selectedHeat) : "Heat")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {selectedEvent.heats.map((h, i) => (
                    <SelectItem key={h.heatId} value={String(i)}>
                      {heatTitle(h)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="flex flex-wrap gap-3">
            {options.genders.length > 1 && (
              <FilterPillNav
                label="Gender"
                value={filters.gender}
                onChange={(gender) =>
                  setFilters((prev) => ({
                    ...prev,
                    gender: gender as TelemetryFilters["gender"],
                  }))
                }
                options={[
                  { value: "all", label: "All" },
                  ...options.genders.map((g) => ({
                    value: g,
                    label: GENDER_LABELS[g] ?? g,
                  })),
                ]}
              />
            )}
            {options.strokes.length > 1 && (
              <FilterPillNav
                label="Stroke"
                value={filters.stroke}
                onChange={(stroke) =>
                  setFilters((prev) => ({ ...prev, stroke }))
                }
                options={[
                  { value: "all", label: "All" },
                  ...options.strokes.map((s) => ({ value: s, label: s })),
                ]}
              />
            )}
            {options.distances.length > 1 && (
              <FilterPillNav
                label="Distance"
                value={filters.distance}
                onChange={(distance) =>
                  setFilters((prev) => ({ ...prev, distance }))
                }
                options={[
                  { value: "all", label: "All" },
                  ...options.distances.map((d) => ({
                    value: String(d),
                    label: `${d}m`,
                  })),
                ]}
              />
            )}
          </div>
        </>
      )}

      {loading ? (
        <p className="text-sm text-[var(--muted-foreground)]">Loading…</p>
      ) : selectedEvent && selectedHeat ? (
        <>
          <motion.div
            key={selectedHeat.heatId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--muted-foreground)] uppercase">
              {selectedEvent.distanceM}m {selectedEvent.stroke} ·{" "}
              {heatTitle(selectedHeat)}
            </p>
            <HeatLaneVisualizer
              heat={selectedHeat}
              laneCount={laneCount}
              stroke={selectedEvent.stroke}
              distanceM={selectedEvent.distanceM}
              onSelectLane={openFromLane}
            />
          </motion.div>

          <section aria-label="Event standings">
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-[var(--muted-foreground)] uppercase">
              Standings · all heats
            </h2>
            <TelemetryLeaderboard
              standings={standings}
              onOpenProfile={openFromStanding}
            />
          </section>
        </>
      ) : (
        !dataError && (
          <p className="text-sm text-[var(--muted-foreground)]">
            {events.length === 0
              ? "No events seeded for this session yet."
              : "No events match these filters."}
          </p>
        )
      )}

      <AnimatePresence>
        {modalTarget && (
          <SwimmerModal
            target={modalTarget}
            onClose={() => setModalTarget(null)}
          />
        )}
      </AnimatePresence>
    </main>
  );
}
