-- ===========================================================================
-- Give the demo swimmers a meet: entries, heats, lanes and published times
-- across all three sessions, plus relay squads for the other teams.
--
-- Apply with: paste into Supabase Dashboard → SQL Editor → Run.
-- Idempotent: re-runnable any number of times.
--
-- RUN supabase/seed-production-demo-auth.sql FIRST. This script populates the
-- accounts that one creates; on its own it has nothing to work with.
--
-- ===========================================================================
-- WHAT IT WILL NOT DO
-- ===========================================================================
-- IT NEVER OVERWRITES A RESULT. Every result insert is
-- `on conflict (heat_lane_id) do nothing`, so times entered or corrected by
-- hand are left exactly as they are. Re-running only fills gaps.
--
-- IT PUBLISHES NO RELAY RESULTS. Relay squads are registered and left
-- unswum, so relay times can be entered through the referee deck afterwards.
--
-- IT DOES NOT TOUCH THE REGISTRATION WINDOW. Nothing here opens or closes
-- registration; meet_settings is not written at all.
--
-- IT DELETES NOTHING. No entry, heat, lane, result, squad or account is
-- removed, and no existing athlete is moved off their team.
--
-- ===========================================================================
-- THE ONE STRUCTURAL CONSTRAINT WORTH UNDERSTANDING
-- ===========================================================================
-- public.generate_heats_for_event() refuses to re-seed an event that already
-- has ANY result — deleting its heats would cascade away those results. That
-- guard is correct and this script depends on it.
--
-- But it has a consequence. Confirming a NEW entry in an already-scored event
-- fires the seeding trigger, the guard declines, and the swimmer ends up
-- confirmed with no heat and no lane — permanently stuck on "Payment
-- confirmed — Heat & Lane assignments pending seeding" on their dashboard.
--
-- So section 3 does not rely on the trigger. It places any unseeded entry
-- into a heat ADDITIVELY: an existing heat of the right bucket with a spare
-- lane, or a new heat appended after the last one. Nothing is rebuilt, so
-- results already on file cannot be disturbed.
-- ===========================================================================

begin;

do $$
declare
  v_admin        uuid;
  v_volume       uuid;
  v_meet_date    date;
  v_team         uuid;
  v_targets      uuid[];
  rec            record;
  v_entry        uuid;
  v_heat         uuid;
  v_lane         integer;
  v_group        public.heat_group;
  v_seed         integer;
  v_entries_made integer := 0;
  v_lanes_made   integer := 0;
  v_results_made integer := 0;
  v_squads_made  integer := 0;
  v_kareem       uuid;
begin
  -- -------------------------------------------------------------------------
  -- 0. Act as an admin.
  --
  -- Entry confirmation (enforce_entry_status_change) and result publication
  -- (enforce_result_publish) both require an admin or referee. The SQL editor
  -- runs as postgres with no JWT, so auth.uid() is NULL and is_admin() is
  -- false. Adopting the real superadmin's id is what lets those triggers pass.
  -- -------------------------------------------------------------------------
  select u.id into v_admin
  from public.users u
  where lower(u.email) = lower(coalesce(
    (select superadmin_email from public.app_settings limit 1),
    'elewakareem2002@gmail.com'
  ));

  if v_admin is null then
    raise exception
      'No superadmin account found. Run supabase/seed-production-demo-auth.sql first.';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text,
    true
  );

  -- The live volume: the highest-numbered one that is not still 'planned'.
  select mv.id, mv.meet_date into v_volume, v_meet_date
  from public.meet_volumes mv
  where mv.status <> 'planned'
  order by mv.volume_number desc
  limit 1;

  if v_volume is null then
    raise exception 'No live meet volume (every volume is still ''planned'').';
  end if;

  -- -------------------------------------------------------------------------
  -- 1. Who this script is about.
  --
  -- Every demo account, plus Kareem Hashim — matched on full_name because
  -- that account was registered by hand through the app and its email is not
  -- known here. Matched case-insensitively and only when EXACTLY one such
  -- person exists: silently populating the wrong person's dashboard because
  -- two swimmers share a name would be worse than skipping it.
  -- -------------------------------------------------------------------------
  select array_agg(a.id) into v_targets
  from public.athletes a
  join public.users u on u.id = a.user_id
  where u.email like '%@ssc.com';

  select a.id into v_kareem
  from public.athletes a
  join public.users u on u.id = a.user_id
  where lower(trim(u.full_name)) = 'kareem hashim'
    and (select count(*) from public.users u2
          where lower(trim(u2.full_name)) = 'kareem hashim') = 1;

  if v_kareem is not null then
    v_targets := v_targets || v_kareem;
  else
    raise notice
      'Kareem Hashim was not matched (missing, not an athlete, or the name is not unique) — skipped.';
  end if;

  if v_targets is null or array_length(v_targets, 1) is null then
    raise exception 'No demo athletes found. Run supabase/seed-production-demo-auth.sql first.';
  end if;

  raise notice 'Populating % athlete(s).', array_length(v_targets, 1);

  -- Under-15s cannot be entered without safety acceptance on file, and an
  -- unapproved athlete cannot be seeded. Both are gates this script would
  -- otherwise trip over one row at a time.
  update public.athletes
  set approved_by_admin = true,
      safety_accepted_at = coalesce(safety_accepted_at, now()),
      safety_accepted_by = coalesce(safety_accepted_by, v_admin)
  where id = any(v_targets);

  -- -------------------------------------------------------------------------
  -- 2. One individual race per session, per athlete.
  --
  -- One per session rather than everything available: meet_settings
  -- .athlete_event_limit defaults to 4, and entering every event would breach
  -- it for a swimmer who has already entered races of their own. This gives
  -- each of the three sessions something to show without crowding out an
  -- athlete's real entries.
  --
  -- Relay and Skins events are excluded — relays are built by a captain in
  -- section 5, and Skins entries are generated from published results by
  -- materialise_skins_heat(), never entered directly.
  -- -------------------------------------------------------------------------
  for rec in
    -- Athlete x session, with the lateral choosing ONE event within THAT
    -- session. Correlating the lateral to s.id is what makes this "one race
    -- per session" rather than one race for the whole meet.
    select
      a.id  as athlete_id,
      ev.id as event_id,
      s.id  as session_id
    from unnest(v_targets) as t(athlete_id)
    join public.athletes a on a.id = t.athlete_id
    join public.sessions s on s.meet_volume_id = v_volume
    cross join lateral (
      select ev2.id
      from public.events ev2
      where ev2.session_id = s.id
        and ev2.is_relay = false
        and ev2.is_skins = false
      order by
        -- Prefer an event that has not been scored yet, so the ordinary
        -- seeding trigger can do the work and this athlete lands in a
        -- properly seeded heat rather than an appended one.
        (exists (
          select 1 from public.results r
          join public.heat_lanes hl on hl.id = r.heat_lane_id
          join public.heats h on h.id = hl.heat_id
          where h.event_id = ev2.id
        )),
        ev2.event_order
      limit 1
    ) ev
    -- Skip a session this athlete already races in, so their own real entries
    -- are never duplicated or crowded.
    where not exists (
      select 1
      from public.entries en
      join public.events ev3 on ev3.id = en.event_id
      where en.athlete_id = a.id and ev3.session_id = s.id
    )
  loop
    -- A plausible seed time, stable per (athlete, event) so re-running does
    -- not reshuffle the seeding. hashtext is deterministic.
    v_seed := 28000 + (abs(hashtext(rec.athlete_id::text || rec.event_id::text)) % 12000);

    insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
    values (rec.event_id, rec.athlete_id, v_seed, false, 'confirmed')
    on conflict (event_id, athlete_id) do nothing;

    if found then
      v_entries_made := v_entries_made + 1;
    end if;
  end loop;

  -- Anything already on file but unpaid becomes confirmed, so these swimmers
  -- are not sitting in the cash queue for a meet they are about to have
  -- results in. Scoped to the demo athletes only.
  update public.entries
  set status = 'confirmed'
  where athlete_id = any(v_targets)
    and status <> 'confirmed';

  -- -------------------------------------------------------------------------
  -- 3. Every confirmed entry gets a lane — additively.
  --
  -- See the header. The seeding trigger will have handled events with no
  -- results; this catches the rest without rebuilding anything.
  -- -------------------------------------------------------------------------
  for rec in
    select en.id as entry_id, en.event_id, a.gender,
           coalesce(en.age_group_at_entry, a.age_group) as age_group
    from public.entries en
    join public.athletes a on a.id = en.athlete_id
    join public.events ev on ev.id = en.event_id
    join public.sessions s on s.id = ev.session_id
    where en.athlete_id = any(v_targets)
      and en.status = 'confirmed'
      and s.meet_volume_id = v_volume
      and ev.is_relay = false
      and ev.is_skins = false
      and not exists (select 1 from public.heat_lanes hl where hl.entry_id = en.id)
  loop
    -- heat_group folds 17 & Under together with Open: they swim the same water.
    v_group := case when rec.age_group = 'U14' then 'U13_14' else 'U17_OPEN' end::public.heat_group;

    -- An existing heat of this bucket with a free lane.
    select h.id,
           (select min(l.n)
              from generate_series(1, 6) as l(n)
             where not exists (
               select 1 from public.heat_lanes hl
               where hl.heat_id = h.id and hl.lane_number = l.n
             ))
      into v_heat, v_lane
    from public.heats h
    where h.event_id = rec.event_id
      and h.heat_group = v_group
      and h.gender is not distinct from rec.gender
      and (select count(*) from public.heat_lanes hl where hl.heat_id = h.id) < 6
    order by h.heat_number
    limit 1;

    if v_heat is null then
      -- No room: append a new heat after the last one in this event.
      insert into public.heats (event_id, heat_group, gender, heat_number, heat_order, status)
      values (
        rec.event_id, v_group, rec.gender,
        coalesce((select max(h2.heat_number) from public.heats h2
                   where h2.event_id = rec.event_id
                     and h2.heat_group = v_group
                     and h2.gender is not distinct from rec.gender), 0) + 1,
        coalesce((select max(h2.heat_order) from public.heats h2
                   where h2.event_id = rec.event_id), 0) + 1,
        'published'
      )
      returning id into v_heat;
      -- Lanes fill from the middle out on a real deck: 4, 3, 5, 2, 1, 6.
      v_lane := 4;
    end if;

    insert into public.heat_lanes (heat_id, lane_number, entry_id)
    values (v_heat, v_lane, rec.entry_id)
    on conflict do nothing;

    v_lanes_made := v_lanes_made + 1;
  end loop;

  -- A heat sheet only becomes visible to athletes and parents once published
  -- (lib/heat-assignment-visibility.ts). Draft heats holding a demo swimmer
  -- would show them "pending seeding" despite having a lane.
  update public.heats h
  set status = 'published'
  where h.status = 'draft'
    and exists (
      select 1
      from public.heat_lanes hl
      join public.entries en on en.id = hl.entry_id
      where hl.heat_id = h.id and en.athlete_id = any(v_targets)
    );

  -- -------------------------------------------------------------------------
  -- 4. Published times — ONLY where no result exists.
  --
  -- `do nothing` rather than `do update`: this is the line that protects
  -- hand-entered and hand-corrected results. The played-meet E2E helper uses
  -- `do update` because it owns a disposable database; this script does not.
  -- -------------------------------------------------------------------------
  insert into public.results (
    heat_lane_id, result_outcome, official_time_ms, status, recorded_by
  )
  select
    hl.id,
    'valid',
    -- Deterministic per lane, and correlated with the seed time so the
    -- results are not absurd relative to how the heat was seeded.
    coalesce(en.seed_time_ms, 30000) + (abs(hashtext(hl.id::text)) % 3000) - 1500,
    'published',
    v_admin
  from public.heat_lanes hl
  join public.entries en on en.id = hl.entry_id
  join public.heats h on h.id = hl.heat_id
  join public.events ev on ev.id = h.event_id
  join public.sessions s on s.id = ev.session_id
  where en.athlete_id = any(v_targets)
    and s.meet_volume_id = v_volume
    and ev.is_relay = false
    and ev.is_skins = false
  on conflict (heat_lane_id) do nothing;

  get diagnostics v_results_made = row_count;

  -- -------------------------------------------------------------------------
  -- 5. Relay squads for the OTHER teams.
  --
  -- SSC Demo Squad is deliberately excluded — its relays are yours to enter
  -- through the captain dashboard, which is the workflow worth demonstrating.
  --
  -- A squad is only created where the team can genuinely field one: four
  -- swimmers already entered in this meet, with the exact gender split the
  -- event requires (public.relay_gender_requirement). Squads are left
  -- 'pending_payment' and UNSWUM — no results, per the brief.
  --
  -- Age group is taken from the OLDEST swimmer picked, which is now legal for
  -- everyone in the squad: public.relay_age_eligible() lets a squad draw on
  -- its own age group and younger.
  -- -------------------------------------------------------------------------
  for rec in
    select ev.id as event_id, t.id as team_id, ev.name as event_name
    from public.events ev
    join public.sessions s on s.id = ev.session_id
    cross join public.teams t
    where s.meet_volume_id = v_volume
      and ev.is_relay = true
      and t.approved_by_admin = true
      and t.name <> 'SSC Demo Squad'
      and not exists (
        select 1 from public.relay_squads rs
        where rs.event_id = ev.id and rs.team_id = t.id
      )
  loop
    declare
      v_need_m integer;
      v_need_f integer;
      v_picked uuid[];
      v_squad  uuid;
      v_age    public.age_group;
      v_leg    integer := 0;
      v_a      uuid;
    begin
      select male_count, female_count into v_need_m, v_need_f
      from public.relay_gender_requirement(rec.event_name);

      -- Entered in this meet, on this team, and not already committed to a
      -- squad for this same event.
      with eligible as (
        select distinct a.id, a.gender, a.age_group
        from public.athletes a
        join public.entries en on en.athlete_id = a.id
        join public.events ev2 on ev2.id = en.event_id
        join public.sessions s2 on s2.id = ev2.session_id
        where a.team_id = rec.team_id
          and s2.meet_volume_id = v_volume
          and not exists (
            select 1
            from public.relay_legs rl
            join public.relay_squads rs on rs.id = rl.squad_id
            where rl.athlete_id = a.id and rs.event_id = rec.event_id
          )
      )
      select array_agg(id) into v_picked
      from (
        (select id from eligible where gender = 'male'   order by id limit v_need_m)
        union all
        (select id from eligible where gender = 'female' order by id limit v_need_f)
      ) chosen;

      -- Not enough swimmers of the right genders — skip this team quietly
      -- rather than creating a squad the validator will reject at commit.
      if v_picked is null or array_length(v_picked, 1) <> 4 then
        continue;
      end if;

      -- The oldest band present. Everyone else is younger, which the
      -- cumulative rule now allows.
      --
      -- Resolved with an explicit CASE rather than max(): neither the text
      -- ordering ('Open' < 'U14' < 'U17') nor the enum's declaration order
      -- is the age order, so max() would pick the wrong band and the squad
      -- would fail validation.
      select case
        when exists (select 1 from public.athletes a
                      where a.id = any(v_picked) and a.age_group = 'Open') then 'Open'
        when exists (select 1 from public.athletes a
                      where a.id = any(v_picked) and a.age_group = 'U17') then 'U17'
        else 'U14'
      end::public.age_group into v_age;

      insert into public.relay_squads (event_id, team_id, age_group, squad_letter, status, created_by)
      values (rec.event_id, rec.team_id, v_age, 'A', 'pending_payment', v_admin)
      returning id into v_squad;

      foreach v_a in array v_picked loop
        v_leg := v_leg + 1;
        insert into public.relay_legs (squad_id, leg_number, athlete_id)
        values (v_squad, v_leg, v_a);
      end loop;

      v_squads_made := v_squads_made + 1;
    end;
  end loop;

  raise notice
    'Done. entries=% lanes_appended=% results=% relay_squads=%',
    v_entries_made, v_lanes_made, v_results_made, v_squads_made;
end $$;

commit;

-- ===========================================================================
-- Verification
-- ===========================================================================
-- === Demo swimmers: races entered and results published ===
select
  u.full_name,
  coalesce(t.name, '—')                       as team,
  a.age_group,
  count(distinct en.id)                       as entries,
  count(distinct hl.id)                       as lanes,
  count(distinct r.id) filter (where r.status = 'published') as published_results
from public.users u
join public.athletes a on a.user_id = u.id
left join public.teams t on t.id = a.team_id
left join public.entries en on en.athlete_id = a.id
left join public.heat_lanes hl on hl.entry_id = en.id
left join public.results r on r.heat_lane_id = hl.id
where u.email like '%@ssc.com' or lower(trim(u.full_name)) = 'kareem hashim'
group by u.full_name, t.name, a.age_group
order by u.full_name;

-- === Relay squads (should be unswum — no results) ===
select
  t.name as team,
  ev.name as event,
  rs.age_group,
  rs.squad_letter,
  rs.status,
  count(rl.id) as legs
from public.relay_squads rs
join public.teams t on t.id = rs.team_id
join public.events ev on ev.id = rs.event_id
left join public.relay_legs rl on rl.squad_id = rs.id
group by t.name, ev.name, rs.age_group, rs.squad_letter, rs.status
order by t.name, ev.name;

-- === SSC Demo Squad roster (needs 2 male + 2 female per band for relays) ===
select a.age_group, a.gender, count(*) as swimmers
from public.athletes a
join public.teams t on t.id = a.team_id
where t.name = 'SSC Demo Squad'
group by a.age_group, a.gender
order by a.age_group, a.gender;
