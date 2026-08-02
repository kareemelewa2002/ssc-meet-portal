"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HeatResultEntry } from "@/components/referee/heat-result-entry";
import { AttendanceBoard } from "@/components/referee/attendance-board";
import { AppHeader } from "@/components/layout/app-header";
import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import type { AttendanceStatus, PublishStatus, SessionRow } from "@/lib/supabase/types";
import { cn } from "@/lib/utils";

interface RefereeEventOption {
  id: string;
  name: string;
  sessionId: string;
}

interface RefereeHeatOption {
  id: string;
  heatNumber: number;
  status: PublishStatus;
}

// A superset shape satisfying both HeatResultEntry's HeatLaneAthlete (which
// treats athleteId/attendanceStatus as optional, for a lane that might not
// have a seeded entry yet) and AttendanceBoard's stricter AttendanceLane —
// letting one fetched array feed both components without casts.
interface RefereeLane {
  heatLaneId: string;
  laneNumber: number;
  athleteName: string;
  athleteId: string;
  teamName?: string;
  seedTimeMs?: number | null;
  entryId?: string;
  attendanceStatus: AttendanceStatus;
}

const DEMO_SESSIONS: SessionRow[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    meet_volume_id: "00000000-0000-4000-8000-000000000000",
    session_number: 1,
    name: "Session 1",
    meet_date: "2026-10-02",
    start_time: "09:00",
    end_time: "12:00",
    created_at: "",
  },
];

const DEMO_EVENTS: RefereeEventOption[] = [
  { id: "00000000-0000-4000-8000-000000000002", name: "50 Freestyle", sessionId: "00000000-0000-4000-8000-000000000001" },
];

const DEMO_HEATS: RefereeHeatOption[] = [
  { id: "00000000-0000-4000-8000-000000000003", heatNumber: 3, status: "draft" },
];

// Every id below is a real (if obviously fake) RFC4122-shaped UUID — never
// a bare string like "hl-1". Postgres's uuid column type rejects anything
// else outright ("invalid input syntax for type uuid"), and this exact
// shape of placeholder used to be the demo fallback everywhere on this
// page, including inside markAttendance's real Supabase write path, which
// had no guard against ever sending one.
const DEMO_LANES: RefereeLane[] = [
  { heatLaneId: "00000000-0000-4000-8000-000000000101", laneNumber: 1, athleteName: "Mia Reyes", teamName: "Blue Marlins", seedTimeMs: 31000, athleteId: "00000000-0000-4000-8000-000000000201", attendanceStatus: "pending" },
  { heatLaneId: "00000000-0000-4000-8000-000000000102", laneNumber: 2, athleteName: "Noah Alvi", teamName: "Riptide", seedTimeMs: 30500, athleteId: "00000000-0000-4000-8000-000000000202", attendanceStatus: "present" },
  { heatLaneId: "00000000-0000-4000-8000-000000000103", laneNumber: 3, athleteName: "Zara Khan", teamName: "Blue Marlins", seedTimeMs: 29800, athleteId: "00000000-0000-4000-8000-000000000203", attendanceStatus: "pending" },
  { heatLaneId: "00000000-0000-4000-8000-000000000104", laneNumber: 4, athleteName: "Leo Fontaine", teamName: "Tidal Wave", seedTimeMs: 29200, athleteId: "00000000-0000-4000-8000-000000000204", attendanceStatus: "present" },
  { heatLaneId: "00000000-0000-4000-8000-000000000105", laneNumber: 5, athleteName: "Ava Thompson", teamName: "Riptide", seedTimeMs: 31500, athleteId: "00000000-0000-4000-8000-000000000205", attendanceStatus: "absent" },
  { heatLaneId: "00000000-0000-4000-8000-000000000106", laneNumber: 6, athleteName: "Kian Osei", teamName: "Tidal Wave", seedTimeMs: 32000, athleteId: "00000000-0000-4000-8000-000000000206", attendanceStatus: "pending" },
];

/**
 * The consolidated Referee role's deck page: one screen covers call-room
 * attendance AND heat time entry (see AGENTS scope lock — usher/entry_helper/
 * chief_referee no longer exist as separate concepts). Any referee who opens
 * a heat has full write access to every lane; the terminal action is
 * submitting the completed card to the Admin review queue, never publishing
 * directly (see enforce_result_publish in supabase/schema.sql).
 */
export default function RefereePage() {
  const [outdoorMode, setOutdoorMode] = useState(false);

  const [sessions, setSessions] = useState<SessionRow[]>(DEMO_SESSIONS);
  const [events, setEvents] = useState<RefereeEventOption[]>(DEMO_EVENTS);
  const [heats, setHeats] = useState<RefereeHeatOption[]>(DEMO_HEATS);
  const [sessionId, setSessionId] = useState(DEMO_SESSIONS[0].id);
  const [eventId, setEventId] = useState(DEMO_EVENTS[0].id);
  const [heatId, setHeatId] = useState(DEMO_HEATS[0].id);
  const [lanes, setLanes] = useState<RefereeLane[]>(DEMO_LANES);

  const sessionEvents = useMemo(
    () => events.filter((e) => e.sessionId === sessionId),
    [events, sessionId],
  );

  const loadSchedule = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data: sess } = await supabase
        .from("sessions")
        .select("*")
        .order("session_number", { ascending: true });
      if (sess?.length) {
        setSessions(sess);
        setSessionId((prev) => (sess.some((s) => s.id === prev) ? prev : sess[0].id));
      }

      const { data: ev } = await supabase
        .from("events")
        .select("id, name, session_id")
        .order("event_order", { ascending: true });
      if (ev?.length) {
        const mapped = ev.map((e) => ({ id: e.id, name: e.name, sessionId: e.session_id }));
        setEvents(mapped);
        setEventId((prev) => (mapped.some((e) => e.id === prev) ? prev : mapped[0].id));
      }
    } catch {
      // Keep demo schedule.
    }
  }, []);

  const latestHeatsRequestRef = useRef<string | null>(null);

  // Every event can have several heats (age-bracket heat sheets); the
  // referee works one physical heat at a time, so this is a second-level
  // picker beneath the event dropdown.
  const loadHeatsForEvent = useCallback(async (selectedEventId: string) => {
    latestHeatsRequestRef.current = selectedEventId;

    if (DEMO_EVENTS.some((e) => e.id === selectedEventId)) {
      setHeats(DEMO_HEATS);
      setHeatId(DEMO_HEATS[0].id);
      return;
    }

    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("heats")
        .select("id, heat_number, status")
        .eq("event_id", selectedEventId)
        .order("heat_number", { ascending: true });

      if (latestHeatsRequestRef.current !== selectedEventId) return;
      if (error || !data?.length) {
        setHeats([]);
        return;
      }

      const mapped: RefereeHeatOption[] = data.map((h) => ({
        id: h.id,
        heatNumber: h.heat_number,
        status: h.status,
      }));
      setHeats(mapped);
      // Default to the first heat still in draft (the one a referee is
      // actually about to run) — fall back to the first heat overall.
      const defaultHeat = mapped.find((h) => h.status === "draft") ?? mapped[0];
      setHeatId(defaultHeat.id);
    } catch {
      if (latestHeatsRequestRef.current !== selectedEventId) return;
      setHeats([]);
    }
  }, []);

  const latestLanesRequestRef = useRef<string | null>(null);

  const loadLanesForHeat = useCallback(async (selectedHeatId: string) => {
    latestLanesRequestRef.current = selectedHeatId;

    if (DEMO_HEATS.some((h) => h.id === selectedHeatId)) {
      setLanes(DEMO_LANES);
      return;
    }

    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("heat_lanes")
        .select(
          // Qualify the FK — athletes has two (user_id and parent_id), so a
          // bare "users(...)" embed is ambiguous to PostgREST (PGRST201).
          "id, lane_number, attendance_status, entries ( id, seed_time_ms, athletes ( id, users!athletes_user_id_fkey ( full_name ), teams ( name ) ) )",
        )
        .eq("heat_id", selectedHeatId)
        .order("lane_number", { ascending: true });

      if (latestLanesRequestRef.current !== selectedHeatId) return;
      if (error || !data?.length) {
        setLanes([]);
        return;
      }

      type RawLane = {
        id: string;
        lane_number: number;
        attendance_status: AttendanceStatus;
        entries:
          | {
              id: string;
              seed_time_ms: number | null;
              athletes:
                | {
                    id: string;
                    users: { full_name: string } | { full_name: string }[] | null;
                    teams: { name: string } | { name: string }[] | null;
                  }
                | {
                    id: string;
                    users: { full_name: string } | { full_name: string }[] | null;
                    teams: { name: string } | { name: string }[] | null;
                  }[]
                | null;
            }
          | {
              id: string;
              seed_time_ms: number | null;
              athletes:
                | {
                    id: string;
                    users: { full_name: string } | { full_name: string }[] | null;
                    teams: { name: string } | { name: string }[] | null;
                  }
                | {
                    id: string;
                    users: { full_name: string } | { full_name: string }[] | null;
                    teams: { name: string } | { name: string }[] | null;
                  }[]
                | null;
            }[]
          | null;
      };

      const mapped = (data as unknown as RawLane[])
        .map((lane): RefereeLane | null => {
          const entry = firstOf(lane.entries);
          const athlete = entry ? firstOf(entry.athletes) : null;
          const user = athlete ? firstOf(athlete.users) : null;
          const team = athlete ? firstOf(athlete.teams) : null;
          if (!athlete || !user) return null;
          return {
            heatLaneId: lane.id,
            laneNumber: lane.lane_number,
            athleteName: user.full_name,
            athleteId: athlete.id,
            teamName: team?.name,
            seedTimeMs: entry?.seed_time_ms ?? null,
            entryId: entry?.id,
            attendanceStatus: lane.attendance_status ?? "pending",
          };
        })
        .filter((l): l is RefereeLane => l !== null)
        .sort((a, b) => a.laneNumber - b.laneNumber);

      setLanes(mapped);
    } catch {
      if (latestLanesRequestRef.current !== selectedHeatId) return;
      setLanes([]);
    }
  }, []);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  useEffect(() => {
    void loadHeatsForEvent(eventId);
  }, [eventId, loadHeatsForEvent]);

  useEffect(() => {
    void loadLanesForHeat(heatId);
  }, [heatId, loadLanesForHeat]);

  const selectedHeat = heats.find((h) => h.id === heatId);

  return (
    <div className={cn("min-h-screen", outdoorMode && "bg-black text-yellow-300")}>
      <AppHeader title="Referee Deck" className={cn(outdoorMode && "border-yellow-300/30 bg-black/95")} />
      <main
        className={cn(
          "mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6",
        )}
      >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className={cn("text-2xl font-bold tracking-tight", outdoorMode && "text-yellow-300")}>
            Referee heat entry
          </h1>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            Check in swimmers, enter times, and submit the heat card to Admin.
          </p>
        </div>
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
          <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>Session, event & heat</CardTitle>
          <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
            Pick the physical heat you&rsquo;re on deck for.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>Session</Label>
            <Select
              value={sessionId}
              onValueChange={(value) => {
                if (!value) return;
                setSessionId(value);
                const firstEvent = events.find((e) => e.sessionId === value);
                if (firstEvent) setEventId(firstEvent.id);
              }}
            >
              <SelectTrigger className="min-h-[48px] w-full">
                {/* Select.Value renders the raw value string by default —
                    a render function is required to show the matching
                    label instead (see Base UI Select docs). */}
                <SelectValue>
                  {(value: string) => sessions.find((s) => s.id === value)?.name ?? "Select session"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Event</Label>
            <Select value={eventId} onValueChange={(value) => value && setEventId(value)}>
              <SelectTrigger className="min-h-[48px] w-full">
                <SelectValue>
                  {(value: string) => sessionEvents.find((e) => e.id === value)?.name ?? "Select event"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sessionEvents.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Heat</Label>
            <Select value={heatId} onValueChange={(value) => value && setHeatId(value)}>
              <SelectTrigger className="min-h-[48px] w-full" disabled={heats.length === 0}>
                <SelectValue placeholder={heats.length === 0 ? "No heats seeded" : undefined}>
                  {(value: string) => {
                    const h = heats.find((heat) => heat.id === value);
                    if (!h) return "No heats seeded";
                    return `Heat ${h.heatNumber} ${h.status === "published" ? "(Published)" : "(Draft)"}`;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {heats.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    Heat {h.heatNumber} {h.status === "published" ? "(Published)" : "(Draft)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <AttendanceBoard outdoorMode={outdoorMode} lanes={lanes} />

      <HeatResultEntry
        heatId={heatId}
        heatLabel={
          selectedHeat
            ? `${sessionEvents.find((e) => e.id === eventId)?.name ?? "Event"} — Heat ${selectedHeat.heatNumber}`
            : "Session 1 — 50 Free Heat 3"
        }
        lanes={lanes}
        outdoorMode={outdoorMode}
      />
      </main>
    </div>
  );
}
