import { createClient } from "@/lib/supabase/client";
import type { MeetVolumeRow, SessionRow } from "@/lib/supabase/types";

/** Mirrors the real supabase/schema.sql seed data, used when Supabase isn't reachable. */
export const DEMO_VOLUMES: MeetVolumeRow[] = [
  {
    id: "demo-vol-1",
    volume_number: 1,
    name: "SSC Vol. 1",
    meet_date: "2026-10-02",
    status: "scheduled",
    created_at: "",
    updated_at: "",
  },
  {
    id: "demo-vol-2",
    volume_number: 2,
    name: "SSC Vol. 2",
    meet_date: null,
    status: "planned",
    created_at: "",
    updated_at: "",
  },
];

export async function fetchVolumeByNumber(volumeNumber: number): Promise<MeetVolumeRow | null> {
  const fallback = DEMO_VOLUMES.find((v) => v.volume_number === volumeNumber) ?? null;
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("meet_volumes")
      .select("*")
      .eq("volume_number", volumeNumber)
      .maybeSingle();
    if (error || !data) return fallback;
    return data;
  } catch {
    return fallback;
  }
}

/** The most recent non-"planned" volume — the one currently being run
 * (spectator nav, admin seeding, etc. all target this by default). */
export async function fetchActiveVolume(): Promise<MeetVolumeRow | null> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("meet_volumes")
      .select("*")
      .order("volume_number", { ascending: true });
    const volumes = error || !data || data.length === 0 ? DEMO_VOLUMES : data;
    return [...volumes].reverse().find((v) => v.status !== "planned") ?? null;
  } catch {
    return [...DEMO_VOLUMES].reverse().find((v) => v.status !== "planned") ?? null;
  }
}

function demoSessionsFor(volumeId: string, meetDate: string): SessionRow[] {
  return [
    {
      id: `${volumeId}-s1`,
      meet_volume_id: volumeId,
      session_number: 1,
      name: "Session 1",
      meet_date: meetDate,
      start_time: "09:00:00",
      end_time: "12:00:00",
      created_at: "",
    },
    {
      id: `${volumeId}-s2`,
      meet_volume_id: volumeId,
      session_number: 2,
      name: "Session 2",
      meet_date: meetDate,
      start_time: "14:00:00",
      end_time: "16:00:00",
      created_at: "",
    },
    {
      id: `${volumeId}-s3`,
      meet_volume_id: volumeId,
      session_number: 3,
      name: "Session 3 — Skins",
      meet_date: meetDate,
      start_time: "17:00:00",
      end_time: "19:00:00",
      created_at: "",
    },
  ];
}

export async function fetchSessionsForVolume(volume: MeetVolumeRow): Promise<SessionRow[]> {
  const fallback = demoSessionsFor(volume.id, volume.meet_date ?? "2026-10-02");
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("sessions")
      .select("*")
      .eq("meet_volume_id", volume.id)
      .order("session_number", { ascending: true });
    if (error || !data || data.length === 0) return fallback;
    return data;
  } catch {
    return fallback;
  }
}

export function formatSessionTime(time: string): string {
  const [hours, minutes] = time.split(":").map(Number);
  const period = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${minutes.toString().padStart(2, "0")} ${period}`;
}

export function formatMeetDate(dateStr: string | null): string {
  if (!dateStr) return "Date TBA";
  const date = new Date(`${dateStr}T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** SSC Vol. 1 has no prior volume to compare against, so time-drop ("Progress")
 * points are meaningless until Vol. 2 — see the leaderboard page's empty state. */
export function isEarliestVolume(volumeNumber: number): boolean {
  return volumeNumber <= 1;
}
