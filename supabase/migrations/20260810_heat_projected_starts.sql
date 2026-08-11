-- =============================================================================
-- Projected heat start times.
-- =============================================================================
-- Apply with: psql "$DATABASE_URL" -f supabase/migrations/20260810_heat_projected_starts.sql
--         or: paste into the Supabase SQL Editor.
--
-- Safe on a live meet database and idempotent: creates one read-only view and
-- grants SELECT. It writes no rows and changes no existing object.
--
-- WHY A VIEW RATHER THAN CLIENT ARITHMETIC
-- ----------------------------------------
-- public.heats' read policy is `status = 'published'`. An athlete therefore
-- sees only published heats, so summing turnaround over what the CLIENT can
-- read skips every draft heat ahead of theirs and reports a start that is too
-- early — worse the more of the session is still unpublished. A swimmer who
-- warmed up for 10:40 because the app omitted four draft heats has been
-- actively misled, which is worse than showing no time at all.
--
-- A view evaluates its underlying tables with the VIEW OWNER's privileges, so
-- the ordinal counts every heat regardless of publication while exposing only
-- the derived time — never the draft sheet's lanes.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.heat_projected_starts — when a heat is expected to go off.
-- ---------------------------------------------------------------------------
-- session.start_time plus the turnaround of every heat scheduled before it in
-- that session, ordered the way the meet is actually run
-- (events.event_order, then heats.heat_order).
--
-- WHY THIS IS A VIEW AND NOT CLIENT ARITHMETIC
-- -------------------------------------------
-- public.heats' read policy is `status = 'published'`, so an athlete sees
-- only published heats. Summing turnaround over what the CLIENT can see
-- therefore skips every unpublished heat ahead of theirs and reports a start
-- that is too early — the more of the session is still in draft, the more
-- wrong it gets. A swimmer who warmed up for 10:40 because the app omitted
-- four draft heats has been actively misled, which is worse than showing no
-- time at all.
--
-- A view owned by the schema owner evaluates the underlying tables with the
-- OWNER's privileges, so the ordinal is computed over every heat regardless
-- of publication. Only the derived time is exposed, never the draft sheet
-- itself: callers still cannot read an unpublished heat's lanes.
--
-- It is a projection, not a promise. It assumes a session runs to turnaround
-- with no breaks, no scratches and no delay, which no meet does — consumers
-- must present it as approximate.
create or replace view public.heat_projected_starts as
select
  h.id as heat_id,
  s.id as session_id,
  (
    s.start_time
    + make_interval(secs => coalesce(sum(prior.turnaround_seconds), 0)::int)
  )::time as projected_start
from public.heats h
join public.events e on e.id = h.event_id
join public.sessions s on s.id = e.session_id
left join lateral (
  select e2.turnaround_seconds
  from public.heats h2
  join public.events e2 on e2.id = h2.event_id
  where e2.session_id = s.id
    and (e2.event_order, h2.heat_order) < (e.event_order, h.heat_order)
) prior on true
where s.start_time is not null
group by h.id, s.id, s.start_time;

comment on view public.heat_projected_starts is
  'Projected wall-clock start per heat: session start + turnaround of every '
  'preceding heat in that session. Computed with the view owner''s '
  'privileges so draft heats still count toward the ordinal — a client '
  'summing only the heats IT can see reports a time that is too early. '
  'Approximate by nature: assumes no breaks, scratches or delay.';

grant select on public.heat_projected_starts to anon, authenticated;

-- Verification: every seeded heat should resolve a projected start, and the
-- first heat of a session should equal that session's start_time.
select
  (select count(*) from public.heat_projected_starts) as projected_rows,
  (select count(*) from public.heats h
     join public.events e on e.id = h.event_id
     join public.sessions s on s.id = e.session_id
    where s.start_time is not null)                   as heats_in_timed_sessions;
