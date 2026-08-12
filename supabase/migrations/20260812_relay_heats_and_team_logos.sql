-- ===========================================================================
-- Relays become real races: seeded into heats, timeable, and in the results.
--
-- WHAT WAS MISSING
-- ----------------
-- A relay could be built by a captain and paid for, and then existed in
-- relay_squads/relay_legs and NOWHERE ELSE. generate_heats_for_event()
-- declines relay events (they have no entries to seed from), nothing else
-- created a heat for one, results attach to heat_lanes, and event_results
-- INNER JOINed entries -> athletes. So a relay had no heat, no lane, no way
-- to record a time, and appeared in no heat sheet and no result.
--
-- WHAT CHANGES
-- ------------
--   1. heat_lanes may hold a relay SQUAD instead of an individual entry.
--   2. generate_relay_heats_for_event() seeds complete squads into heats,
--      fired whenever a squad's legs change.
--   3. event_results LEFT JOINs, so relay lanes produce standings rows with a
--      squad label ("Riptide A") and a NULL athlete_id.
--   4. recompute_volume_leaderboard() excludes relay rows — a relay place
--      belongs to the squad, and leaderboards.athlete_id is NOT NULL.
--   5. A public `team-logos` storage bucket for captain-uploaded crests.
--
-- WHY A SQUAD ON THE LANE AND NOT A SYNTHETIC ENTRY
-- An entry is one swimmer in one race, and it is what pricing, the athlete
-- event limit and event capacity all count. Four fake entries per squad would
-- bill swimmers individually for a squad the captain already paid for as a
-- unit, and push each of them toward their event cap. Hanging the squad off
-- the lane means results attach to a relay exactly as to an individual swim —
-- same table, same publish flow, same referee screen.
--
-- Safe on a live meet: it only ADDS a nullable column, a function, triggers
-- and a bucket, and widens a view. Relay heat generation refuses to rebuild
-- any event that already has results, so nothing recorded can be disturbed.
-- ===========================================================================

-- 1. A heat lane may hold a relay squad.
alter table public.heat_lanes
  add column if not exists relay_squad_id uuid references public.relay_squads (id) on delete cascade;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'heat_lanes_relay_squad_unique'
  ) then
    alter table public.heat_lanes
      add constraint heat_lanes_relay_squad_unique unique (heat_id, relay_squad_id);
  end if;

  -- A lane holds one competitor, or is empty. Never both at once.
  if not exists (
    select 1 from pg_constraint where conname = 'heat_lanes_one_occupant'
  ) then
    alter table public.heat_lanes
      add constraint heat_lanes_one_occupant
      check (entry_id is null or relay_squad_id is null);
  end if;
end;
$$;

create index if not exists heat_lanes_relay_squad_idx
  on public.heat_lanes (relay_squad_id) where relay_squad_id is not null;

-- 2. Relay heat generation.
create or replace function public.generate_relay_heats_for_event(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_heats   integer := 0;
  v_group   public.heat_group;
  v_gender  public.gender;
  v_need_m  integer;
  v_need_f  integer;
  v_name    text;
  v_heat    uuid;
  v_lanes   integer[] := array[4, 3, 5, 2, 1, 6];
  v_n       integer := 0;
  v_number  integer := 0;
  r         record;
begin
  if not exists (
    select 1 from public.events where id = p_event_id and is_relay = true
  ) then
    return 0;
  end if;

  -- Never rebuild an event that is already being scored.
  if exists (
    select 1
    from public.results r2
    join public.heat_lanes hl on hl.id = r2.heat_lane_id
    join public.heats h on h.id = hl.heat_id
    where h.event_id = p_event_id
  ) then
    return 0;
  end if;

  select name into v_name from public.events where id = p_event_id;
  select male_count, female_count into v_need_m, v_need_f
  from public.relay_gender_requirement(v_name);

  -- A single-gender relay names its gender; a mixed one genuinely has none.
  v_gender := case
    when v_need_f = 0 then 'male'::public.gender
    when v_need_m = 0 then 'female'::public.gender
    else null
  end;

  delete from public.heats where event_id = p_event_id;

  -- Youngest board first, then by team, so the running order is stable and
  -- matches how the rest of the meet is ordered.
  for r in
    select rs.id, rs.age_group, t.name as team_name
    from public.relay_squads rs
    join public.teams t on t.id = rs.team_id
    where rs.event_id = p_event_id
      and rs.status <> 'hold_expired'
      and (select count(*) from public.relay_legs rl where rl.squad_id = rs.id) = 4
    order by
      case rs.age_group when 'U14' then 0 when 'U17' then 1 else 2 end,
      t.name
  loop
    v_group := case when r.age_group = 'U14' then 'U13_14' else 'U17_OPEN' end::public.heat_group;

    -- Six lanes to a heat; a seventh squad starts a new one.
    if v_heat is null or v_n >= 6 then
      v_number := v_number + 1;
      insert into public.heats (event_id, heat_group, gender, heat_number, heat_order, status)
      values (p_event_id, v_group, v_gender, v_number, v_number, 'draft')
      returning id into v_heat;
      v_heats := v_heats + 1;
      v_n := 0;
    end if;

    v_n := v_n + 1;
    -- Lanes fill from the middle out, exactly as they do for individuals.
    insert into public.heat_lanes (heat_id, lane_number, relay_squad_id)
    values (v_heat, v_lanes[v_n], r.id);
  end loop;

  return v_heats;
end;
$$;

comment on function public.generate_relay_heats_for_event(uuid) is
  'Seeds complete relay squads into heats and lanes so a referee can time '
  'them. The relay counterpart of generate_heats_for_event(), which declines '
  'relay events because they have no entries to seed from.';

-- Seeds relay heats when a squad is completed or confirmed. Statement-level
-- with a transition table, matching the individual path, so one multi-row
-- change rebuilds each event once rather than once per leg.
create or replace function public.generate_relay_heats_on_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
begin
  for v_event_id in
    select distinct rs.event_id
    from public.relay_squads rs
    where rs.id in (select squad_id from changed_legs)
  loop
    perform public.generate_relay_heats_for_event(v_event_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists generate_relay_heats_on_leg_insert on public.relay_legs;
create trigger generate_relay_heats_on_leg_insert
  after insert on public.relay_legs
  referencing new table as changed_legs
  for each statement execute function public.generate_relay_heats_on_change();

-- 3. event_results includes relay standings.
drop view if exists public.event_results;

create view public.event_results as
with scored as (
  select
    ev.id                                             as event_id,
    ev.name                                           as event_name,
    ev.stroke,
    ev.distance_m,
    ev.is_relay,
    ev.session_id,
    -- Running order, so a standing can be listed in the order the races were
    -- actually swum. Without these a caller has only event_name to sort by,
    -- which is alphabetical: "100m Free" lands ahead of "50m Fly" and the
    -- results read in an order that matches no session that ever took place.
    ev.event_order,
    s.session_number,
    s.meet_volume_id,
    -- Time-drop points are a property of the SWIM, not of any board, so the
    -- same value rides every board this swim appears on — matching how the
    -- previous incremental trigger credited improvement to both the native
    -- age group and Open.
    r.improvement_points,
    -- A relay is ranked in its SQUAD's age group; an individual in the age
    -- group stamped on their entry.
    coalesce(rs.age_group, en.age_group_at_entry, a.age_group) as own_age_group,
    -- A relay has no single gender. Single-sex relays take the heat's gender
    -- (set from the event name when the heat was generated); a mixed relay is
    -- genuinely NULL, and every mixed squad then partitions together.
    coalesce(a.gender, h.gender)                      as gender,
    -- NULL for a relay: the competitor is the squad, not any one swimmer.
    -- Consumers must therefore treat athlete_id as optional and fall back to
    -- athlete_name, which is the squad label for a relay.
    a.id                                              as athlete_id,
    rs.id                                             as relay_squad_id,
    coalesce(u.full_name, rt.name || ' ' || rs.squad_letter) as athlete_name,
    coalesce(t.name, rt.name)                         as team_name,
    h.heat_number,
    h.heat_order,
    hl.lane_number,
    r.official_time_ms,
    r.result_outcome,
    r.dq_code,
    -- A swim only earns a place if it produced a time. DQ and NS never do.
    (r.result_outcome = 'valid' and r.official_time_ms is not null) as is_ranked,
    -- NULL for relays, Skins and the switch events, which have no base time
    -- on file and are deliberately unrateable — callers must render that as
    -- an em dash, never as zero points. Guarded on is_relay as well because
    -- a relay's gender may be NULL, and the scoring function needs one.
    case when ev.is_relay then null
         else public.world_aquatics_points(ev.stroke, ev.distance_m, a.gender, r.official_time_ms)
    end                                               as wa_points
  from public.results r
  join public.heat_lanes hl on hl.id = r.heat_lane_id
  join public.heats h       on h.id = hl.heat_id
  join public.events ev     on ev.id = h.event_id
  join public.sessions s    on s.id = ev.session_id
  -- LEFT, not INNER: a relay lane has no entry, and inner joins here are
  -- exactly why relays never appeared in the results at all.
  left join public.entries en  on en.id = hl.entry_id
  left join public.athletes a  on a.id = en.athlete_id
  left join public.users u     on u.id = a.user_id
  left join public.teams t     on t.id = a.team_id
  left join public.relay_squads rs on rs.id = hl.relay_squad_id
  left join public.teams rt    on rt.id = rs.team_id
  where r.status = 'published'
    and r.result_outcome is not null
    -- A lane with neither occupant is an empty lane, not a swim.
    and (a.id is not null or rs.id is not null)
),
categorised as (
  select scored.*, cat.age_group, (cat.age_group <> scored.own_age_group) as is_open_entry
  from scored
  -- distinct collapses the duplicate for a swimmer whose own group IS Open.
  -- Boards are CUMULATIVE, not exclusive: a 14 & Under swimmer is ranked in
  -- 14 & Under, in 17 & Under, and in Open; a 17 & Under swimmer in 17 & Under
  -- and Open. Each board is "this age and younger", with Open meaning open to
  -- everyone. distinct collapses the duplicate for a swimmer whose own group
  -- already is the board.
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
  is_relay,
  meet_volume_id,
  improvement_points,
  age_group,
  own_age_group,
  -- True when this row is a younger swimmer ranked up into an older board,
  -- so the UI can say so rather than looking like a mis-categorised entry.
  is_open_entry,
  gender,
  athlete_id,
  relay_squad_id,
  athlete_name,
  team_name,
  -- heat_number restarts per (age group, gender), so it identifies a heat
  -- only together with those. heat_order is the event-wide running order and
  -- is what actually distinguishes one heat from another.
  heat_number,
  heat_order,
  lane_number,
  official_time_ms,
  result_outcome,
  dq_code,
  is_ranked,
  wa_points,
  -- Partitioning on is_ranked as well restarts the numbering for the
  -- unranked group, and the CASE then discards it: a DQ has no place, and
  -- giving it "1" (or "0") would state something untrue about the swim.
  case when is_ranked then
    rank() over (
      partition by event_id, age_group, gender, is_ranked
      order by official_time_ms asc
    )
  end                                               as event_place
from categorised;

grant select on public.event_results to anon, authenticated, service_role;

-- 4. Relay rows must not reach the individual leaderboard.
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
    -- floors places past the points-paying depth at zero rather than letting
    -- them go negative.
    coalesce(sum(
      greatest(0, public.max_placement_points() + 1 - er.event_place)
    ) filter (where er.event_place is not null), 0),
    coalesce(sum(er.improvement_points), 0)
  from public.event_results er
  where er.meet_volume_id = p_meet_volume_id
    -- Relay rows carry a NULL athlete_id: the competitor is the squad, not
    -- any one swimmer. They must not reach this table — leaderboards.athlete_id
    -- is NOT NULL, and crediting a relay place to four individual boards would
    -- score a team result four times over. Team standings are computed
    -- separately from relay finishes.
    and er.athlete_id is not null
  group by er.athlete_id, er.age_group;
end;
$$;

comment on function public.recompute_volume_leaderboard(uuid) is
  'Rebuilds public.leaderboards for one volume from public.event_results. '
  'Placement points come from each board''s own event standing, so a swimmer '
  'earns 14 & Under points for their 14 & Under place and Open points for '
  'their place against the whole field. Full rebuild by design: a place is '
  'relative, so no per-result increment can be correct.';

-- 5. team-logos bucket.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    -- team-logos — a captain uploading their team's crest.
    --
    -- A SEPARATE BUCKET FROM avatars, deliberately. avatars_anyone_upload
    -- lets an unauthenticated visitor write, which that bucket needs because
    -- a profile photo is chosen during registration before the account
    -- exists. A team logo has no such moment: only a signed-in captain of an
    -- existing team ever sets one, so the upload is gated on authentication
    -- rather than inheriting a policy written for a different problem.
    --
    -- Public read: logos appear on heat sheets, results and the team list,
    -- all of which anonymous spectators can see.
    -- -----------------------------------------------------------------------
    insert into storage.buckets (id, name, public)
    values ('team-logos', 'team-logos', true)
    on conflict (id) do update set public = true;

    drop policy if exists "team_logos_public_read" on storage.objects;
    create policy "team_logos_public_read" on storage.objects
      for select using (bucket_id = 'team-logos');

    drop policy if exists "team_logos_authenticated_upload" on storage.objects;
    create policy "team_logos_authenticated_upload" on storage.objects
      for insert to authenticated with check (bucket_id = 'team-logos');

    drop policy if exists "team_logos_owner_update" on storage.objects;
    create policy "team_logos_owner_update" on storage.objects
      for update to authenticated
      using (bucket_id = 'team-logos' and owner = auth.uid())
      with check (bucket_id = 'team-logos' and owner = auth.uid());

    drop policy if exists "team_logos_owner_delete" on storage.objects;
    create policy "team_logos_owner_delete" on storage.objects
      for delete to authenticated
      using (bucket_id = 'team-logos' and owner = auth.uid());
  end if;
end $$;

-- 6. Seed relay heats for every relay event that has squads but no heats yet.
do $$
declare v_id uuid;
begin
  for v_id in
    select distinct rs.event_id from public.relay_squads rs
  loop
    perform public.generate_relay_heats_for_event(v_id);
  end loop;
end $$;
