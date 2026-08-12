import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { ok, runQuery, type FetchResult } from "@/lib/fetch-policy";
import type { Database, MeetVolumeRow } from "@/lib/supabase/types";
import type { SessionRow } from "@/lib/supabase/types";

/**
 * Used when Supabase isn't reachable, so nothing here passes through RLS.
 *
 * That is exactly why it lists ONLY the volume that is meant to be public.
 * It used to carry a planned, non-public "SSC Vol. 2" as well, mirroring the
 * schema seed — but every other path hides that row behind
 * public.volume_is_public(), and this constant is the one path that cannot.
 * A dropped connection would therefore surface an unannounced future meet to
 * whoever happened to be looking, which is the single thing the is_public
 * flag exists to prevent.
 *
 * A hidden volume is not "missing" from this list; it is correctly absent.
 */
export const DEMO_VOLUMES: MeetVolumeRow[] = [
  {
    id: "demo-vol-1",
    volume_number: 1,
    name: "SSC Vol. 1",
    meet_date: "2026-10-02",
    status: "scheduled",
    is_public: true,
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
 *
 * `client` is optional and exists for exactly one caller:
 * app/events/[volId]/layout.tsx, a Server Component. That layout is the
 * enforcement point for is_public — a signed-in non-admin must get "not
 * found" for a hidden volume, and RLS is what makes that true. But
 * lib/supabase/client.ts's browser client cannot see a Server Component's
 * request cookies, so calling it there would authenticate as nobody and make
 * the admin bypass silently stop working. Passing the server client through
 * is what keeps the real session — and therefore RLS's is_admin() check —
 * intact. Every other caller omits it and gets the ordinary browser client,
 * unchanged from before.
 */
export async function fetchVolumeByNumber(
  volId: string | number,
  client?: SupabaseClient<Database>,
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
        const supabase = client ?? createClient();
        return supabase.from("meet_volumes").select("*").eq("volume_number", asNumber).maybeSingle();
      },
      { empty: null, demo },
    );
    // A successful lookup that simply found nothing falls through to the slug
    // path below; only a real failure short-circuits with its error intact.
    //
    // That "found nothing" case is now also what a HIDDEN volume looks like
    // to a non-admin caller: RLS returns zero rows rather than the real one,
    // so this is indistinguishable from the volume not existing at all — the
    // intended behavior, since confirming existence is part of what stays
    // hidden.
    if (numeric.error) return numeric;
    if (numeric.data) return numeric;
  }

  // Slug path — slugifying happens in JS, not SQL (no slug column), so this
  // matches client-side over the full (small) volume list. RLS already
  // limited that list to whatever this caller may see, so no separate
  // visibility check is needed here either.
  const all = await runQuery<MeetVolumeRow[]>(
    `Resolving meet volume "${raw}"`,
    async () => {
      const supabase = client ?? createClient();
      return supabase.from("meet_volumes").select("*");
    },
    { empty: [], demo: DEMO_VOLUMES },
  );
  if (all.error) return { ...all, data: all.usedFallback ? demo : null };

  const match = all.data.find((v) => slugifyVolumeName(v.name) === raw.toLowerCase()) ?? null;
  return ok(match);
}

/**
 * Every volume this caller may see, RLS-scoped — for admin tooling that needs
 * to pick among them (the Control Unit's volume selector). No status/is_public
 * filter is applied here in app code: the point of the RLS policy on
 * meet_volumes is that it IS that filter, so an admin session naturally gets
 * every volume including planned/unpublished ones, and any other caller gets
 * only the public ones, with nothing in TypeScript re-deciding the rule.
 */
export async function fetchAllVolumes(): Promise<FetchResult<MeetVolumeRow[]>> {
  return runQuery<MeetVolumeRow[]>(
    "Loading meet volumes",
    async () => {
      const supabase = createClient();
      return supabase.from("meet_volumes").select("*").order("volume_number", { ascending: true });
    },
    { empty: [], demo: DEMO_VOLUMES },
  );
}

/** Publishes or unpublishes a volume. Admin-only at the RLS layer
 * (admins_full_access_meet_volumes) — this call fails silently-as-a-no-op for
 * anyone else, same as every other admin-only write in this app. */
export async function saveVolumeVisibility(
  volumeId: string,
  isPublic: boolean,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("meet_volumes")
    .update({ is_public: isPublic })
    .eq("id", volumeId);
  if (error) return { success: false, error: error.message };
  return { success: true };
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
