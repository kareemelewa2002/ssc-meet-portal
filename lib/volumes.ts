import { createClient } from "@/lib/supabase/client";
import { ok, runQuery, type FetchResult } from "@/lib/fetch-policy";
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

/** "SSC Vol. 1" -> "ssc-vol-1" — lowercase, non-alphanumerics collapsed to
 * single hyphens, trimmed. Used both to build slug links and to resolve
 * a volume by slug below. */
export function slugifyVolumeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolves a meet volume from a route param that may be either the numeric
 * volume_number ("1") or a slugified name ("ssc-vol-1") — both forms are
 * valid /events/[volId]/... URLs. A bare Number(volId) on a slug produces
 * NaN, which 400s against the integer volume_number column outright rather
 * than just finding nothing, so the numeric path is only ever attempted
 * when volId genuinely parses as a positive integer.
 */
export async function fetchVolumeByNumber(
  volId: string | number,
): Promise<FetchResult<MeetVolumeRow | null>> {
  const raw = String(volId).trim();
  const asNumber = Number(raw);
  const isNumeric = raw !== "" && Number.isInteger(asNumber) && asNumber > 0;

  const demo =
    (isNumeric ? DEMO_VOLUMES.find((v) => v.volume_number === asNumber) : null) ??
    DEMO_VOLUMES.find((v) => slugifyVolumeName(v.name) === raw.toLowerCase()) ??
    null;

  if (isNumeric) {
    const numeric = await runQuery<MeetVolumeRow | null>(
      `Loading meet volume ${raw}`,
      async () => {
        const supabase = createClient();
        return supabase.from("meet_volumes").select("*").eq("volume_number", asNumber).maybeSingle();
      },
      { empty: null, demo },
    );
    // A successful lookup that simply found nothing falls through to the slug
    // path below; only a real failure short-circuits with its error intact.
    if (numeric.error) return numeric;
    if (numeric.data) return numeric;
  }

  // Slug path — slugifying happens in JS, not SQL (no slug column), so this
  // matches client-side over the full (small) volume list.
  const all = await runQuery<MeetVolumeRow[]>(
    `Resolving meet volume "${raw}"`,
    async () => {
      const supabase = createClient();
      return supabase.from("meet_volumes").select("*");
    },
    { empty: [], demo: DEMO_VOLUMES },
  );
  if (all.error) return { ...all, data: all.usedFallback ? demo : null };

  const match = all.data.find((v) => slugifyVolumeName(v.name) === raw.toLowerCase()) ?? null;
  return ok(match);
}

/** The most recent non-"planned" volume — the one currently being run
 * (spectator nav, admin seeding, etc. all target this by default). */
export async function fetchActiveVolume(): Promise<FetchResult<MeetVolumeRow | null>> {
  const result = await runQuery<MeetVolumeRow[]>(
    "Loading the active meet volume",
    async () => {
      const supabase = createClient();
      return supabase.from("meet_volumes").select("*").order("volume_number", { ascending: true });
    },
    { empty: [], demo: DEMO_VOLUMES },
  );
  const active = [...result.data].reverse().find((v) => v.status !== "planned") ?? null;
  return { ...result, data: active };
}

function demoSessionsFor(volumeId: string, meetDate: string): SessionRow[] {
  return [
    {
      id: `${volumeId}-s1`,
      meet_volume_id: volumeId,
      session_number: 1,
      name: "Session 1 — Morning",
      meet_date: meetDate,
      start_time: "09:00:00",
      end_time: "12:00:00",
      created_at: "",
    },
    {
      id: `${volumeId}-s2`,
      meet_volume_id: volumeId,
      session_number: 2,
      name: "Session 2 — Afternoon",
      meet_date: meetDate,
      start_time: "14:00:00",
      end_time: "17:00:00",
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

export async function fetchSessionsForVolume(
  volume: MeetVolumeRow,
): Promise<FetchResult<SessionRow[]>> {
  return runQuery<SessionRow[]>(
    `Loading sessions for ${volume.name}`,
    async () => {
      const supabase = createClient();
      return supabase
        .from("sessions")
        .select("*")
        .eq("meet_volume_id", volume.id)
        .order("session_number", { ascending: true });
    },
    { empty: [], demo: demoSessionsFor(volume.id, volume.meet_date ?? "2026-10-02") },
  );
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
