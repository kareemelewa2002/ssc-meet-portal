-- ===========================================================================
-- Leaderboard points come from each board's own event standing.
--
-- WHAT WAS WRONG
-- --------------
-- public.apply_result_points() read results.placement_points — a rank WITHIN
-- A SINGLE HEAT — and credited that same figure to the swimmer's native age
-- group AND to Open. Heats are seeded by age group (U14 swims apart from the
-- combined U17/Open field), so winning a U14 heat banked full Open points
-- without the swimmer ever having been ranked against the Open field. The
-- Open board could therefore be won by winning age-group races.
--
-- The same bug inflated the age-group boards: in a multi-heat event every
-- heat winner scored 6 points, making three or four "winners" of one race.
--
-- WHAT IT DOES NOW
-- ----------------
-- public.event_results already ranks each swim once per board it belongs to
-- (a U14 swim is ranked in U14, in U17 and in Open). Points are taken from
-- event_place on each of those rows independently, so ranking 1st in U14 and
-- 2nd overall scores 1st-place points on the U14 board and 2nd-place points
-- on Open.
--
-- It is a full rebuild per volume rather than an incremental delta because a
-- place is relative — one published result reorders everyone behind it, so no
-- per-row increment can be correct.
--
-- Also adds session_number, event_order and improvement_points to
-- public.event_results. Without event_order the only sort key a caller had
-- was event_name, which is alphabetical: "100m Free" sorted ahead of "50m
-- Fly" and a results page read in an order matching no session ever swum.
--
-- Safe to run on a live meet: it rebuilds derived standings from published
-- results and touches no entry, heat, lane or payment.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Points awarded for 1st place — one definition, two callers.
-- ---------------------------------------------------------------------------
create or replace function public.max_placement_points()
returns numeric
language sql
immutable
as $$ select 6::numeric $$;

comment on function public.max_placement_points() is
  'Placement points awarded for 1st; each subsequent place scores one less, '
  'to a floor of zero. Places beyond this therefore score nothing.';

-- ---------------------------------------------------------------------------
-- 2. event_results gains running order and improvement points.
-- ---------------------------------------------------------------------------
-- DROP, not CREATE OR REPLACE. Replacing a view can only APPEND columns to
-- the end of its select list — it cannot insert one in the middle, and this
-- adds session_number and event_order ahead of meet_volume_id. Left as a
-- replace it fails with 'cannot change name of view column "meet_volume_id"
-- to "session_number"'. Plain drop rather than CASCADE: if something does
-- depend on this view, that must surface as an error here, not as a silently
-- dropped dependent.
drop view if exists public.event_results;

create view public.event_results as
with scored as (
  select
    ev.id                                             as event_id,
    ev.name                                           as event_name,
    ev.stroke,
    ev.distance_m,
    ev.session_id,
    ev.event_order,
    s.session_number,
    s.meet_volume_id,
    r.improvement_points,
    coalesce(en.age_group_at_entry, a.age_group)      as own_age_group,
    a.gender,
    a.id                                              as athlete_id,
    u.full_name                                       as athlete_name,
    t.name                                            as team_name,
    h.heat_number,
    h.heat_order,
    hl.lane_number,
    r.official_time_ms,
    r.result_outcome,
    r.dq_code,
    (r.result_outcome = 'valid' and r.official_time_ms is not null) as is_ranked,
    public.world_aquatics_points(ev.stroke, ev.distance_m, a.gender, r.official_time_ms)
                                                      as wa_points
  from public.results r
  join public.heat_lanes hl on hl.id = r.heat_lane_id
  join public.heats h       on h.id = hl.heat_id
  join public.events ev     on ev.id = h.event_id
  join public.sessions s    on s.id = ev.session_id
  join public.entries en    on en.id = hl.entry_id
  join public.athletes a    on a.id = en.athlete_id
  join public.users u       on u.id = a.user_id
  left join public.teams t  on t.id = a.team_id
  where r.status = 'published'
    and r.result_outcome is not null
),
categorised as (
  select scored.*, cat.age_group, (cat.age_group <> scored.own_age_group) as is_open_entry
  from scored
  cross join lateral (
    select distinct unnest(
      case scored.own_age_group
        when 'U14' then array['U14', 'U17', 'Open']::public.age_group[]
        when 'U17' then array['U17', 'Open']::public.age_group[]
        else array['Open']::public.age_group[]
      end
    ) as age_group
  ) cat
)
select
  event_id,
  event_name,
  session_id,
  session_number,
  event_order,
  meet_volume_id,
  improvement_points,
  age_group,
  own_age_group,
  is_open_entry,
  gender,
  athlete_id,
  athlete_name,
  team_name,
  heat_number,
  heat_order,
  lane_number,
  official_time_ms,
  result_outcome,
  dq_code,
  is_ranked,
  wa_points,
  case when is_ranked then
    rank() over (
      partition by event_id, age_group, gender, is_ranked
      order by official_time_ms asc
    )
  end                                               as event_place
from categorised;

comment on view public.event_results is
  'Overall per-event standings across ALL heats, partitioned by event x age '
  'group x gender. Distinct from results.finish_place, which ranks only '
  'within a single heat. Includes DQ and NS rows with a NULL event_place and '
  'is_ranked = false, so they can be shown honestly at the bottom of a '
  'standing instead of vanishing from it.';

-- Dropping the view dropped its grants with it, so they must be restored.
-- service_role included: the blanket grant in schema.sql covers it, and
-- omitting it here would leave server-side jobs unable to read a view they
-- could read before this migration ran.
grant select on public.event_results to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. The rebuild itself.
-- ---------------------------------------------------------------------------
create or replace function public.recompute_volume_leaderboard(p_meet_volume_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_meet_volume_id is null then
    return;
  end if;

  delete from public.leaderboards where meet_volume_id = p_meet_volume_id;

  insert into public.leaderboards (
    meet_volume_id, athlete_id, category, placement_points, improvement_points
  )
  select
    p_meet_volume_id,
    er.athlete_id,
    er.age_group,
    -- event_place is NULL for DQ and NS, which score nothing. greatest(...,0)
    -- floors places past the points-paying depth at zero.
    coalesce(sum(
      greatest(0, public.max_placement_points() + 1 - er.event_place)
    ) filter (where er.event_place is not null), 0),
    coalesce(sum(er.improvement_points), 0)
  from public.event_results er
  where er.meet_volume_id = p_meet_volume_id
  group by er.athlete_id, er.age_group;
end;
$$;

comment on function public.recompute_volume_leaderboard(uuid) is
  'Rebuilds public.leaderboards for one volume from public.event_results. '
  'Placement points come from each board''s own event standing, so a swimmer '
  'earns 14 & Under points for their 14 & Under place and Open points for '
  'their place against the whole field. Full rebuild by design: a place is '
  'relative, so no per-result increment can be correct.';

-- ---------------------------------------------------------------------------
-- 4. Swap the trigger.
-- ---------------------------------------------------------------------------
create or replace function public.results_recompute_leaderboard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meet_volume_id uuid;
  v_heat_lane_id uuid;
begin
  -- NEW is unassigned on DELETE and OLD on INSERT — dereferencing the wrong
  -- one raises "record is not assigned yet", so branch on TG_OP explicitly.
  if TG_OP = 'DELETE' then
    v_heat_lane_id := old.heat_lane_id;
  else
    v_heat_lane_id := new.heat_lane_id;
  end if;

  select s.meet_volume_id
    into v_meet_volume_id
  from public.heat_lanes hl
  join public.heats h    on h.id = hl.heat_id
  join public.events ev  on ev.id = h.event_id
  join public.sessions s on s.id = ev.session_id
  where hl.id = v_heat_lane_id;

  if v_meet_volume_id is not null then
    perform public.recompute_volume_leaderboard(v_meet_volume_id);
  end if;

  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Trigger first, then the function it referenced.
drop trigger if exists results_apply_points on public.results;
drop function if exists public.apply_result_points();

drop trigger if exists results_recompute_leaderboard_trigger on public.results;
create trigger results_recompute_leaderboard_trigger
  after insert or update or delete on public.results
  for each row execute function public.results_recompute_leaderboard();

-- ---------------------------------------------------------------------------
-- 5. Rebuild every existing volume, so standings already on file are restated
--    under the new rule rather than keeping points banked under the old one.
-- ---------------------------------------------------------------------------
do $$
declare
  v_id uuid;
begin
  for v_id in select id from public.meet_volumes loop
    perform public.recompute_volume_leaderboard(v_id);
  end loop;
end;
$$;
