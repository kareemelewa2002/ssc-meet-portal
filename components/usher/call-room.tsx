"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, UserRoundX, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, getErrorMessage } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  applyAttendancePatch,
  setLaneAttendance,
  summarizeAttendance,
  type AttendanceLane,
} from "@/lib/attendance";
import type { AttendanceStatus, SessionRow } from "@/lib/supabase/types";
import { AthleteLink } from "@/components/athletes/athlete-link";

export interface UsherProfile {
  fullName: string;
  roleLabel?: string;
  profileImageUrl?: string | null;
}

export interface CallRoomEventOption {
  id: string;
  name: string;
  sessionId: string;
}

export interface CallRoomHeat {
  id: string;
  heatNumber: number;
  eventName: string;
  lanes: AttendanceLane[];
}

const DEMO_SESSIONS: SessionRow[] = [
  {
    id: "sess-1",
    meet_volume_id: "vol-1",
    session_number: 1,
    name: "Session 1",
    meet_date: "2026-10-02",
    start_time: "09:00",
    end_time: "12:00",
    created_at: "",
  },
  {
    id: "sess-2",
    meet_volume_id: "vol-1",
    session_number: 2,
    name: "Session 2",
    meet_date: "2026-10-02",
    start_time: "14:00",
    end_time: "16:00",
    created_at: "",
  },
];

const DEMO_EVENTS: CallRoomEventOption[] = [
  { id: "ev-1", name: "50 Freestyle", sessionId: "sess-1" },
  { id: "ev-2", name: "50 Butterfly", sessionId: "sess-2" },
];

const DEMO_HEATS: CallRoomHeat[] = [
  {
    id: "heat-1",
    heatNumber: 3,
    eventName: "50 Freestyle",
    lanes: [
      { heatLaneId: "hl-1", laneNumber: 1, athleteId: "ath-mia", athleteName: "Mia Reyes", teamName: "Blue Marlins", attendanceStatus: "pending" },
      { heatLaneId: "hl-2", laneNumber: 2, athleteId: "ath-noah", athleteName: "Noah Alvi", teamName: "Riptide", attendanceStatus: "present" },
      { heatLaneId: "hl-3", laneNumber: 3, athleteId: "ath-zara", athleteName: "Zara Khan", teamName: "Blue Marlins", attendanceStatus: "pending" },
      { heatLaneId: "hl-4", laneNumber: 4, athleteId: "ath-leo", athleteName: "Leo Fontaine", teamName: "Tidal Wave", attendanceStatus: "present" },
      { heatLaneId: "hl-5", laneNumber: 5, athleteId: "ath-ava", athleteName: "Ava Thompson", teamName: "Riptide", attendanceStatus: "absent" },
      { heatLaneId: "hl-6", laneNumber: 6, athleteId: "ath-kian", athleteName: "Kian Osei", teamName: "Tidal Wave", attendanceStatus: "pending" },
    ],
  },
];

export interface CallRoomProps {
  usher: UsherProfile;
  className?: string;
}

export function CallRoom({ usher, className }: CallRoomProps) {
  const [sessions, setSessions] = useState<SessionRow[]>(DEMO_SESSIONS);
  const [events, setEvents] = useState<CallRoomEventOption[]>(DEMO_EVENTS);
  const [sessionId, setSessionId] = useState(DEMO_SESSIONS[0].id);
  const [eventId, setEventId] = useState(DEMO_EVENTS[0].id);
  const [heats, setHeats] = useState<CallRoomHeat[]>(DEMO_HEATS);
  const [savingLaneId, setSavingLaneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        const mapped = ev.map((e) => ({
          id: e.id,
          name: e.name,
          sessionId: e.session_id,
        }));
        setEvents(mapped);
        setEventId((prev) => (mapped.some((e) => e.id === prev) ? prev : mapped[0].id));
      }
    } catch {
      // Keep demo schedule.
    }
  }, []);

  // Tracks the most recently *requested* event so an out-of-order network
  // response for a stale selection can never clobber the current one.
  const latestRequestRef = useRef<string | null>(null);

  const loadHeats = useCallback(async (selectedEventId: string) => {
    latestRequestRef.current = selectedEventId;
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from("heats")
        .select(
          "id, heat_number, events ( name ), heat_lanes ( id, lane_number, attendance_status, entries ( athletes ( id, users ( full_name ), teams ( name ) ) ) )",
        )
        .eq("event_id", selectedEventId)
        .order("heat_number", { ascending: true });

      // This response is for a selection the usher has since navigated away
      // from — discard it rather than render heats for the wrong event.
      if (latestRequestRef.current !== selectedEventId) return;

      if (fetchError) throw fetchError;
      if (!data?.length) {
        // A real, successful query for THIS event came back empty — that's
        // a genuine "no heats seeded yet," never a reason to keep showing a
        // previous event's stale lanes (and their non-UUID demo lane ids).
        setHeats(DEMO_EVENTS.some((e) => e.id === selectedEventId) ? DEMO_HEATS : []);
        return;
      }

      // Nested embeds aren't modeled in our hand-written Relationships metadata.
      type RawHeat = {
        id: string;
        heat_number: number;
        events: { name: string } | { name: string }[] | null;
        heat_lanes: Array<{
          id: string;
          lane_number: number;
          attendance_status: AttendanceStatus | null;
          entries:
            | {
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
        }> | null;
      };

      const heatsRaw = data as unknown as RawHeat[];
      const mapped: CallRoomHeat[] = heatsRaw.map((heat) => {
        const eventName =
          (Array.isArray(heat.events) ? heat.events[0]?.name : heat.events?.name) ?? "Event";
        const lanes = (heat.heat_lanes ?? [])
          .map((lane) => {
            const entry = Array.isArray(lane.entries) ? lane.entries[0] : lane.entries;
            const athlete = entry
              ? Array.isArray(entry.athletes)
                ? entry.athletes[0]
                : entry.athletes
              : null;
            const user = athlete
              ? Array.isArray(athlete.users)
                ? athlete.users[0]
                : athlete.users
              : null;
            const team = athlete
              ? Array.isArray(athlete.teams)
                ? athlete.teams[0]
                : athlete.teams
              : null;
            if (!athlete || !user) return null;
            return {
              heatLaneId: lane.id,
              laneNumber: lane.lane_number,
              athleteId: athlete.id,
              athleteName: user.full_name,
              teamName: team?.name ?? null,
              attendanceStatus: lane.attendance_status ?? "pending",
            } satisfies AttendanceLane;
          })
          .filter(Boolean) as AttendanceLane[];

        return {
          id: heat.id,
          heatNumber: heat.heat_number,
          eventName,
          lanes: lanes.sort((a, b) => a.laneNumber - b.laneNumber),
        };
      });

      setHeats(mapped);
    } catch {
      if (latestRequestRef.current !== selectedEventId) return;
      // Real fetch failed (network/RLS) — only show the bundled demo heat
      // while we're still on the bundled demo event; otherwise show empty
      // rather than a mismatched previous event's data.
      setHeats(DEMO_EVENTS.some((e) => e.id === selectedEventId) ? DEMO_HEATS : []);
    }
  }, []);

  useEffect(() => {
    void loadSchedule();
  }, [loadSchedule]);

  useEffect(() => {
    void loadHeats(eventId);
  }, [eventId, loadHeats]);

  // Live attendance sync so other ushers / referees stay aligned.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`call-room-${eventId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "heat_lanes" },
        (payload) => {
          const row = payload.new as { id?: string; attendance_status?: AttendanceStatus };
          if (!row.id || !row.attendance_status) return;
          setHeats((prev) =>
            prev.map((heat) => ({
              ...heat,
              lanes: applyAttendancePatch(heat.lanes, row.id!, row.attendance_status!),
            })),
          );
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [eventId]);

  const markAttendance = async (
    heatId: string,
    heatLaneId: string,
    status: Exclude<AttendanceStatus, "pending">,
  ) => {
    setError(null);

    let nextStatus: AttendanceStatus = status;
    setHeats((prev) => {
      const heat = prev.find((h) => h.id === heatId);
      const lane = heat?.lanes.find((l) => l.heatLaneId === heatLaneId);
      nextStatus = lane?.attendanceStatus === status ? "pending" : status;
      return prev.map((h) =>
        h.id === heatId ? { ...h, lanes: setLaneAttendance(h.lanes, heatLaneId, status) } : h,
      );
    });

    setSavingLaneId(heatLaneId);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("heat_lanes")
        .update({ attendance_status: nextStatus })
        .eq("id", heatLaneId);
      if (updateError) {
        // Demo / offline path — local state already updated.
        if (!updateError.message.toLowerCase().includes("jwt")) {
          setError(updateError.message);
        }
      }
    } catch (err) {
      setError(getErrorMessage(err, "Could not save attendance."));
    } finally {
      setSavingLaneId(null);
    }
  };

  const initials = usher.fullName
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className={cn("space-y-4", className)}>
      <Card>
        <CardContent className="flex items-center gap-4 py-4">
          <Avatar size="lg" className="size-16">
            {usher.profileImageUrl ? (
              <AvatarImage src={usher.profileImageUrl} alt={usher.fullName} />
            ) : null}
            <AvatarFallback className="text-lg">{initials}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-bold">{usher.fullName}</p>
            <Badge className="mt-1">{usher.roleLabel ?? "Usher"}</Badge>
            <p className="mt-1 text-sm text-muted-foreground">
              Call-room check-in — mark Present / Absent before heats start.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Session & event</CardTitle>
          <CardDescription>Select the active call-room heat sheet.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {sessions.map((session) => (
              <Button
                key={session.id}
                type="button"
                variant={sessionId === session.id ? "default" : "outline"}
                className="min-h-[48px]"
                onClick={() => {
                  setSessionId(session.id);
                  const first = events.find((e) => e.sessionId === session.id);
                  if (first) setEventId(first.id);
                }}
              >
                {session.name}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {sessionEvents.map((event) => (
              <Button
                key={event.id}
                type="button"
                variant={eventId === event.id ? "secondary" : "outline"}
                className="min-h-[48px]"
                onClick={() => setEventId(event.id)}
              >
                {event.name}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {heats.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No heats seeded for this event yet.
          </CardContent>
        </Card>
      )}
      {heats.map((heat) => {
        const summary = summarizeAttendance(heat.lanes);
        return (
          <Card key={heat.id}>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>
                  Heat {heat.heatNumber} · {heat.eventName}
                </CardTitle>
                <Badge variant={summary.readyForStart ? "default" : "outline"}>
                  <Users className="mr-1 size-3.5" />
                  {summary.present} present · {summary.absent} absent · {summary.pending} pending
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {heat.lanes.map((lane) => (
                <div
                  key={lane.heatLaneId}
                  className="space-y-2 rounded-lg border p-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex size-12 min-h-[48px] min-w-[48px] items-center justify-center rounded-md bg-muted text-sm font-bold">
                      L{lane.laneNumber}
                    </div>
                    <div className="min-w-0 flex-1">
                      <AthleteLink
                        athleteId={lane.athleteId}
                        name={lane.athleteName}
                        className="flex min-h-[48px] items-center truncate text-base font-semibold"
                      />
                      {lane.teamName && (
                        <p className="truncate text-xs text-muted-foreground">{lane.teamName}</p>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      className={cn(
                        "min-h-[48px] text-base font-semibold",
                        lane.attendanceStatus === "present" && "bg-emerald-600 hover:bg-emerald-600",
                      )}
                      variant={lane.attendanceStatus === "present" ? "default" : "outline"}
                      disabled={savingLaneId === lane.heatLaneId}
                      onClick={() => void markAttendance(heat.id, lane.heatLaneId, "present")}
                    >
                      {savingLaneId === lane.heatLaneId ? (
                        <Loader2 className="mr-2 size-4 animate-spin" />
                      ) : (
                        <Check className="mr-2 size-4" />
                      )}
                      Present
                    </Button>
                    <Button
                      type="button"
                      className={cn(
                        "min-h-[48px] text-base font-semibold",
                        lane.attendanceStatus === "absent" && "bg-amber-600 text-white hover:bg-amber-600",
                      )}
                      variant={lane.attendanceStatus === "absent" ? "secondary" : "outline"}
                      disabled={savingLaneId === lane.heatLaneId}
                      onClick={() => void markAttendance(heat.id, lane.heatLaneId, "absent")}
                    >
                      <UserRoundX className="mr-2 size-4" />
                      Absent
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
