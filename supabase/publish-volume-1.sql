-- =============================================================================
-- Publish (or create) SSC Vol. 1 as a publicly-visible meet volume.
-- =============================================================================
-- Apply with: paste into the Supabase Dashboard > SQL Editor for the
-- PRODUCTION project (the one Vercel's NEXT_PUBLIC_SUPABASE_URL points at),
-- or: psql "$PRODUCTION_DATABASE_URL" -f supabase/publish-volume-1.sql
--
-- WHY THIS EXISTS
-- ----------------
-- app/events/[volId]/layout.tsx gates EVERY /events/1/* route (heats, live,
-- leaderboard, register, schedule, results, and now telemetry) on
-- meet_volumes' RLS policy: a non-admin only sees a volume when
-- is_public = true AND status <> 'planned'. If volume_number = 1 doesn't
-- exist yet, or exists but fails that check, the layout's fetchVolumeByNumber()
-- finds nothing and calls notFound() — the 404 is enforcing that rule
-- correctly, not a bug in the telemetry route. This script is the fix on the
-- DATA side, not the code side.
--
-- SAFETY / RE-RUN BEHAVIOR
-- -------------------------
--   - Idempotent: running this twice is a no-op the second time.
--   - Never touches a volume's `name` or `meet_date` if the row already
--     exists — only is_public/status are changed, and only when the row is
--     not already in the target state.
--   - status must be one of the three real public.volume_status enum labels
--     ('planned' | 'scheduled' | 'completed') — 'open' is NOT a valid value
--     and would fail outright with an invalid-enum-label error.
--   - 'scheduled' is used here (not 'completed'), since this only publishes
--     volume 1's EXISTENCE — it does not seed sessions, events, heats or
--     results. If volume 1 is meant to show real telemetry (lanes, times,
--     standings), it separately needs sessions/events/entries seeded or
--     already present; this script does not create those.
--
-- Run as the Postgres table-owner role (Dashboard SQL Editor or a direct
-- psql connection) — both bypass RLS automatically, so no admin JWT/session
-- GUC setup is needed here, unlike supabase/seed-demo.sql which also has to
-- satisfy trigger-level admin guards this simple UPDATE/INSERT never touches.
-- =============================================================================

-- Step 0 — see what's actually there before changing anything.
select id, volume_number, name, meet_date, status, is_public
from public.meet_volumes
order by volume_number;

-- Step 1 — if volume_number = 1 already exists, publish it in place.
update public.meet_volumes
set
  is_public = true,
  status = case when status = 'planned' then 'scheduled' else status end
where volume_number = 1
  and (is_public = false or status = 'planned');

-- Step 2 — if volume_number = 1 does not exist at all, create it.
-- meet_date is left null (schema allows it) since the real date is a
-- decision for whoever owns this meet, not something this script should
-- invent — set it explicitly afterward if/when it's known.
insert into public.meet_volumes (volume_number, name, status, is_public)
select 1, 'SSC Vol. 1', 'scheduled', true
where not exists (select 1 from public.meet_volumes where volume_number = 1);

-- Step 3 — confirm the result.
select id, volume_number, name, meet_date, status, is_public
from public.meet_volumes
where volume_number = 1;
