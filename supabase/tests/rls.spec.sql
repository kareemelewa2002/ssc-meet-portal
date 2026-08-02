-- =============================================================================
-- L2 — RLS & TRIGGER SUITE (DB-01 … DB-11)
-- =============================================================================
-- Exercises the guarantees that live in the database rather than in TypeScript:
-- row-level security, SECURITY DEFINER helpers, and the triggers enforcing the
-- team/join-request domain rules.
--
-- Every assertion runs under `SET ROLE authenticated` with
-- request.jwt.claim.sub impersonating a real seeded user, so RLS is genuinely
-- in force — running these as the superuser/owner would bypass RLS entirely
-- and silently pass.
--
-- Run: npm run test:rls   (see scripts/run-rls-tests.sh)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Harness
-- -----------------------------------------------------------------------------
drop schema if exists ssc_test cascade;
create schema ssc_test;

create table ssc_test.results (
  seq       serial primary key,
  id        text not null,
  name      text not null,
  passed    boolean not null,
  detail    text
);

create or replace function ssc_test.check(
  p_id text, p_name text, p_passed boolean, p_detail text default null
) returns void language sql as $$
  insert into ssc_test.results (id, name, passed, detail)
  values (p_id, p_name, coalesce(p_passed, false), p_detail);
$$;

/** Impersonate a signed-in user for the remainder of the current transaction. */
create or replace function ssc_test.act_as(p_user_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('role', 'authenticated', true);
end;
$$;

/** Convenience lookups against the seeded fixtures. */
create or replace function ssc_test.user_id(p_email text)
returns uuid language sql stable as $$
  select id from public.users where lower(email) = lower(p_email);
$$;

create or replace function ssc_test.team_id(p_name text)
returns uuid language sql stable as $$
  select id from public.teams where name = p_name;
$$;

-- =============================================================================
-- DB-01 — can_captain_team(): Open athletes, coaches and admins only.
-- =============================================================================
do $$
declare v_expected boolean; v_actual boolean; rec record;
begin
  for rec in
    select * from (values
      ('athlete01@ssc-demo.test', false, 'U14 athlete'),
      ('athlete13@ssc-demo.test', false, 'U17 athlete'),
      ('athlete25@ssc-demo.test', true,  'Open athlete'),
      ('coach.riptide@ssc-demo.test', true, 'coach'),
      ('elewakareem2002@gmail.com', true, 'admin')
    ) as t(email, expected, label)
  loop
    begin
      perform ssc_test.act_as(ssc_test.user_id(rec.email));
      v_actual := public.can_captain_team();
      perform set_config('role', 'postgres', true);
      perform ssc_test.check(
        'DB-01', format('can_captain_team() = %s for %s', rec.expected, rec.label),
        v_actual = rec.expected, format('got %s', v_actual)
      );
    exception when others then
      perform set_config('role', 'postgres', true);
      perform ssc_test.check('DB-01', format('can_captain_team() for %s', rec.label), false, sqlerrm);
    end;
  end loop;
end $$;

-- =============================================================================
-- DB-02 — a U14 athlete cannot create (and therefore captain) a team.
-- =============================================================================
do $$
declare v_uid uuid;
begin
  v_uid := ssc_test.user_id('athlete01@ssc-demo.test');
  perform ssc_test.act_as(v_uid);
  begin
    insert into public.teams (name, captain_id) values ('DB02 Rogue Team', v_uid);
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-02', 'U14 team INSERT is denied by RLS', false,
      'INSERT unexpectedly succeeded');
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-02', 'U14 team INSERT is denied by RLS',
      sqlerrm ilike '%row-level security%', sqlerrm);
  end;
end $$;

-- Sanity counterpart: an Open athlete MAY create a team (proves DB-02 is a
-- real role gate, not a blanket insert failure).
do $$
declare v_uid uuid;
begin
  v_uid := ssc_test.user_id('athlete25@ssc-demo.test');
  perform ssc_test.act_as(v_uid);
  begin
    insert into public.teams (name, captain_id) values ('DB02 Open Team', v_uid);
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-02', 'Open athlete team INSERT succeeds', true);
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-02', 'Open athlete team INSERT succeeds', false, sqlerrm);
  end;
end $$;

-- =============================================================================
-- DB-04 — transfer lock: an athlete already on a team cannot request a move
-- while a volume is 'scheduled'. (Runs before DB-03 because DB-03 needs the
-- lock lifted to create its first pending request.)
-- =============================================================================
do $$
declare v_uid uuid; v_team uuid;
begin
  update public.meet_volumes set status = 'scheduled' where volume_number = 1;
  perform ssc_test.check('DB-04', 'precondition: meet_in_progress() is true',
    public.meet_in_progress(), null);

  v_uid := ssc_test.user_id('athlete01@ssc-demo.test');  -- already on Riptide
  v_team := ssc_test.team_id('Blue Marlins');
  perform ssc_test.act_as(v_uid);
  begin
    insert into public.team_memberships (team_id, user_id) values (v_team, v_uid);
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-04', 'transfer blocked while meet in progress', false,
      'INSERT unexpectedly succeeded');
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-04', 'transfer blocked while meet in progress',
      sqlerrm ilike '%transfers are locked%', sqlerrm);
  end;
end $$;

-- =============================================================================
-- DB-05 — the lock lifts once the volume completes.
-- =============================================================================
do $$
declare v_uid uuid; v_team uuid; v_id uuid;
begin
  update public.meet_volumes set status = 'completed' where volume_number = 1;
  perform ssc_test.check('DB-05', 'precondition: meet_in_progress() is false',
    not public.meet_in_progress(), null);

  v_uid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_team := ssc_test.team_id('Blue Marlins');
  perform ssc_test.act_as(v_uid);
  begin
    insert into public.team_memberships (team_id, user_id)
    values (v_team, v_uid) returning id into v_id;
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-05', 'transfer request allowed once volume completed',
      v_id is not null, null);
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-05', 'transfer request allowed once volume completed', false, sqlerrm);
  end;
end $$;

-- =============================================================================
-- DB-03 — only ONE pending join request per athlete, platform-wide.
-- (athlete01 now holds the pending request created by DB-05.)
-- =============================================================================
do $$
declare v_uid uuid; v_team uuid;
begin
  v_uid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_team := ssc_test.team_id('Sunburst Aquatics');
  perform ssc_test.act_as(v_uid);
  begin
    insert into public.team_memberships (team_id, user_id) values (v_team, v_uid);
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-03', 'second pending join request is rejected', false,
      'INSERT unexpectedly succeeded');
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-03', 'second pending join request is rejected',
      sqlerrm ilike '%already have a pending%', sqlerrm);
  end;
end $$;

-- =============================================================================
-- DB-07 — a non-captain cannot accept someone else's join request.
-- RLS makes this a silent no-op (0 rows), not an error — assert the row is
-- genuinely unchanged rather than trusting the absence of an exception.
-- =============================================================================
do $$
declare v_membership uuid; v_status text; v_rows int;
begin
  select id into v_membership from public.team_memberships
   where user_id = ssc_test.user_id('athlete01@ssc-demo.test') and status = 'pending';

  -- athlete13 captains nothing at all.
  perform ssc_test.act_as(ssc_test.user_id('athlete13@ssc-demo.test'));
  update public.team_memberships set status = 'accepted' where id = v_membership;
  get diagnostics v_rows = row_count;
  perform set_config('role', 'postgres', true);

  select status into v_status from public.team_memberships where id = v_membership;
  perform ssc_test.check('DB-07', 'non-captain accept updates 0 rows', v_rows = 0,
    format('row_count=%s', v_rows));
  perform ssc_test.check('DB-07', 'membership still pending after non-captain attempt',
    v_status = 'pending', format('status=%s', v_status));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-07', 'non-captain accept is a no-op', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-06 — the real captain accepting syncs athletes.team_id + stamps responded_at.
-- =============================================================================
do $$
declare
  v_membership uuid; v_captain uuid; v_target_team uuid;
  v_new_team uuid; v_responded timestamptz;
begin
  select id, team_id into v_membership, v_target_team
    from public.team_memberships
   where user_id = ssc_test.user_id('athlete01@ssc-demo.test') and status = 'pending';
  select captain_id into v_captain from public.teams where id = v_target_team;

  perform ssc_test.check('DB-06', 'precondition: target team has a captain',
    v_captain is not null, null);

  perform ssc_test.act_as(v_captain);
  update public.team_memberships set status = 'accepted' where id = v_membership;
  perform set_config('role', 'postgres', true);

  select team_id into v_new_team from public.athletes
   where user_id = ssc_test.user_id('athlete01@ssc-demo.test');
  select responded_at into v_responded from public.team_memberships where id = v_membership;

  perform ssc_test.check('DB-06', 'accept syncs athletes.team_id to the new team',
    v_new_team = v_target_team, format('team_id=%s expected=%s', v_new_team, v_target_team));
  perform ssc_test.check('DB-06', 'accept stamps responded_at',
    v_responded is not null, format('responded_at=%s', v_responded));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-06', 'captain accept syncs roster', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-08 — 2026 birth-year bucketing, including the pre-birthday edge case.
-- =============================================================================
do $$
declare rec record; v_turning int; v_group text;
begin
  for rec in
    select * from (values
      ('2013-12-25'::date, 13, 'U14',  'born 2013, birthday not yet reached'),
      ('2013-01-02'::date, 13, 'U14',  'born 2013, birthday passed'),
      ('2012-06-15'::date, 14, 'U14',  'born 2012'),
      ('2011-03-01'::date, 15, 'U17',  'born 2011'),
      ('2010-01-01'::date, 16, 'U17',  'born 2010'),
      ('2009-12-31'::date, 17, 'U17',  'born 2009, birthday not yet reached'),
      ('2008-01-01'::date, 18, 'Open', 'born 2008'),
      ('1995-01-01'::date, 31, 'Open', 'born 1995')
    ) as t(dob, expected_age, expected_group, label)
  loop
    v_turning := public.age_turning_this_year(rec.dob, date '2026-08-02');
    v_group := public.age_group_for_age(v_turning)::text;
    perform ssc_test.check('DB-08',
      format('%s -> turns %s, %s', rec.label, rec.expected_age, rec.expected_group),
      v_turning = rec.expected_age and v_group = rec.expected_group,
      format('got turns=%s group=%s', v_turning, v_group));
  end loop;

  -- The convention itself: birth-year age must NOT equal exact calendar age
  -- before the birthday, which is the whole reason age_turning_this_year exists.
  perform ssc_test.check('DB-08',
    'birth-year age differs from exact age before the birthday',
    public.age_turning_this_year(date '2013-12-25', date '2026-08-02')
      <> public.age_at_date(date '2013-12-25', date '2026-08-02'),
    format('turning=%s exact=%s',
      public.age_turning_this_year(date '2013-12-25', date '2026-08-02'),
      public.age_at_date(date '2013-12-25', date '2026-08-02')));
end $$;

-- =============================================================================
-- DB-09 — handle_new_auth_user() populates age / age_group from signup metadata.
-- =============================================================================
do $$
declare v_id uuid := gen_random_uuid(); v_age int; v_group text; v_role text; v_parent text;
begin
  insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  values (
    v_id, 'db09.trigger@ssc-test.invalid',
    jsonb_build_object(
      'full_name', 'DB09 Trigger Probe', 'role', 'athlete',
      'date_of_birth', '2013-12-25', 'gender', 'female',
      'parent_email', 'db09.parent@ssc-test.invalid'
    ),
    now(), now()
  );

  select a.age, a.age_group::text, u.role::text, a.parent_link_status::text
    into v_age, v_group, v_role, v_parent
    from public.athletes a join public.users u on u.id = a.user_id
   where a.user_id = v_id;

  perform ssc_test.check('DB-09', 'trigger creates the public.users row as athlete',
    v_role = 'athlete', format('role=%s', v_role));
  perform ssc_test.check('DB-09', 'trigger stores birth-year age (13, not exact 12)',
    v_age = 13, format('age=%s', v_age));
  perform ssc_test.check('DB-09', 'trigger buckets born-2013 as U14',
    v_group = 'U14', format('age_group=%s', v_group));
  perform ssc_test.check('DB-09', 'U14 signup with a parent email is left pending linkage',
    v_parent = 'pending', format('parent_link_status=%s', v_parent));
end $$;

-- Privilege-escalation guard: a client requesting role 'admin' at signup must
-- be clamped, never honoured.
do $$
declare v_id uuid := gen_random_uuid(); v_role text;
begin
  insert into auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  values (v_id, 'db09.escalate@ssc-test.invalid',
    jsonb_build_object('full_name', 'DB09 Escalation Probe', 'role', 'admin'), now(), now());
  select role::text into v_role from public.users where id = v_id;
  perform ssc_test.check('DB-09', 'requested role=admin at signup is clamped',
    v_role is distinct from 'admin', format('role=%s', v_role));
end $$;

-- =============================================================================
-- DB-10 — every public primary key is an RFC4122 v4 UUID.
-- =============================================================================
do $$
declare rec record; v_bad bigint; v_total bigint; v_checked int := 0;
begin
  for rec in
    select distinct c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.table_constraints tc
        on tc.table_schema = c.table_schema and tc.table_name = c.table_name
       and tc.constraint_type = 'PRIMARY KEY'
      join information_schema.key_column_usage k
        on k.constraint_name = tc.constraint_name and k.column_name = c.column_name
     where c.table_schema = 'public' and c.data_type = 'uuid'
     order by c.table_name
  loop
    execute format(
      'select count(*) filter (where %I::text !~* ''^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''), count(*) from public.%I',
      rec.column_name, rec.table_name
    ) into v_bad, v_total;
    v_checked := v_checked + 1;
    perform ssc_test.check('DB-10',
      format('%s.%s is all RFC4122 v4', rec.table_name, rec.column_name),
      v_bad = 0, format('%s of %s rows non-v4', v_bad, v_total));
  end loop;

  perform ssc_test.check('DB-10', 'at least one uuid primary key was inspected',
    v_checked > 0, format('inspected %s columns', v_checked));
end $$;

-- =============================================================================
-- DB-11 — publishing results is admin-only; referees may draft but not publish.
-- =============================================================================
do $$
declare v_lane uuid; v_referee uuid; v_admin uuid; v_status text;
begin
  v_referee := ssc_test.user_id('referee1@ssc-demo.test');
  v_admin   := ssc_test.user_id('elewakareem2002@gmail.com');

  -- The seed now ships a pre-meet state (entries pending, no heats), so
  -- lanes must be produced the same way the app produces them: confirm an
  -- event's entries, which fires generate_heats_on_confirm.
  -- Confirming is admin-only (enforce_entry_status_change).
  perform ssc_test.act_as(ssc_test.user_id('elewakareem2002@gmail.com'));
  update public.entries set status = 'confirmed'
   where event_id = (select event_id from public.entries limit 1);
  perform set_config('role','postgres',true);
  select hl.id into v_lane from public.heat_lanes hl limit 1;
  delete from public.results where heat_lane_id = v_lane;
  perform ssc_test.check('DB-11', 'precondition: prepared a lane with no result',
    v_lane is not null, null);

  if v_lane is null then return; end if;

  -- Referee may write a DRAFT.
  perform ssc_test.act_as(v_referee);
  begin
    insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
    values (v_lane, 'valid', 31500, 'draft');
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-11', 'referee may insert a draft result', true);
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-11', 'referee may insert a draft result', false, sqlerrm);
  end;

  -- Referee may NOT flip it to published.
  perform ssc_test.act_as(v_referee);
  begin
    update public.results set status = 'published' where heat_lane_id = v_lane;
    perform set_config('role', 'postgres', true);
    select status::text into v_status from public.results where heat_lane_id = v_lane;
    perform ssc_test.check('DB-11', 'referee cannot publish a result',
      v_status <> 'published', format('status=%s after referee update', v_status));
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-11', 'referee cannot publish a result',
      sqlerrm ilike '%only an admin may publish%', sqlerrm);
  end;

  -- Admin may.
  perform ssc_test.act_as(v_admin);
  begin
    update public.results set status = 'published' where heat_lane_id = v_lane;
    perform set_config('role', 'postgres', true);
    select status::text into v_status from public.results where heat_lane_id = v_lane;
    perform ssc_test.check('DB-11', 'admin may publish a result',
      v_status = 'published', format('status=%s', v_status));
  exception when others then
    perform set_config('role', 'postgres', true);
    perform ssc_test.check('DB-11', 'admin may publish a result', false, sqlerrm);
  end;
end $$;

-- =============================================================================
-- DB-12 — contact privacy: phone/email only within a team, or between a
-- pending requester and that team's captain.
-- =============================================================================
do $$
declare
  v_same_team int; v_other_team int; v_self int; v_captain_sees int; v_member_sees int;
  v_alice uuid; v_bob uuid; v_outsider uuid; v_captain uuid; v_requester uuid; v_team uuid;
  v_member uuid;
begin
  -- Two Riptide athletes, and someone on a different team.
  select u.id into v_alice from public.users u join public.athletes a on a.user_id=u.id
   where u.email='athlete01@ssc-demo.test';
  select u.id into v_bob from public.users u join public.athletes a on a.user_id=u.id
   where a.team_id=(select team_id from public.athletes x join public.users y on y.id=x.user_id
                    where y.email='athlete01@ssc-demo.test')
     and u.email<>'athlete01@ssc-demo.test' limit 1;
  select u.id into v_outsider from public.users u join public.athletes a on a.user_id=u.id
   where a.team_id is distinct from (select team_id from public.athletes x join public.users y on y.id=x.user_id
                                     where y.email='athlete01@ssc-demo.test')
     and a.team_id is not null limit 1;

  perform ssc_test.act_as(v_alice);
  select count(*) into v_self from public.visible_contacts(array[v_alice]);
  select count(*) into v_same_team from public.visible_contacts(array[v_bob]);
  select count(*) into v_other_team from public.visible_contacts(array[v_outsider]);
  perform set_config('role','postgres',true);

  perform ssc_test.check('DB-12','a member sees their own contact', v_self = 1, format('rows=%s', v_self));
  perform ssc_test.check('DB-12','same-team members see each other', v_same_team = 1, format('rows=%s', v_same_team));
  perform ssc_test.check('DB-12','a different team is NOT visible', v_other_team = 0, format('rows=%s', v_other_team));

  -- Pending request: unattached athlete39 -> Blue Marlins.
  select u.id into v_requester from public.users u where u.email='athlete39@ssc-demo.test';
  select id, captain_id into v_team, v_captain from public.teams where name='Blue Marlins';
  update public.meet_volumes set status='completed' where volume_number=1;  -- lift transfer lock
  delete from public.team_memberships where user_id=v_requester;
  insert into public.team_memberships (team_id, user_id, status) values (v_team, v_requester, 'pending');

  perform ssc_test.act_as(v_captain);
  select count(*) into v_captain_sees from public.visible_contacts(array[v_requester]);
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-12','captain sees a pending requester', v_captain_sees = 1,
    format('rows=%s', v_captain_sees));

  -- ...but an ordinary member of that team must NOT.
  select u.id into v_member from public.users u join public.athletes a on a.user_id=u.id
   where a.team_id=v_team and u.id<>v_captain limit 1;
  perform ssc_test.act_as(v_member);
  select count(*) into v_member_sees from public.visible_contacts(array[v_requester]);
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-12','ordinary team member does NOT see a pending requester',
    v_member_sees = 0, format('rows=%s', v_member_sees));
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-12','contact privacy', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-13 — approving entries generates heats; heats are NOT pre-seeded.
-- =============================================================================
do $$
declare
  v_event uuid; v_before int; v_after int; v_lanes int; v_confirmed int;
  v_u14_max int; v_open_min int;
begin
  -- Pick an individual event nobody has confirmed yet.
  select e.event_id into v_event
    from public.entries e
    join public.events ev on ev.id = e.event_id
   where ev.is_relay = false and ev.is_skins = false
     and not exists (select 1 from public.heats h where h.event_id = e.event_id)
   group by e.event_id having count(*) >= 4
   limit 1;
  perform ssc_test.check('DB-13','precondition: an unseeded event with entries exists',
    v_event is not null, null);
  if v_event is null then return; end if;

  select count(*) into v_before from public.heats where event_id = v_event;
  perform ssc_test.check('DB-13','no heats exist before approval', v_before = 0,
    format('heats=%s', v_before));

  perform ssc_test.act_as(ssc_test.user_id('elewakareem2002@gmail.com'));
  update public.entries set status = 'confirmed' where event_id = v_event;
  perform set_config('role','postgres',true);
  select count(*) into v_confirmed from public.entries
   where event_id = v_event and status = 'confirmed';
  select count(*) into v_after from public.heats where event_id = v_event;
  select count(*) into v_lanes from public.heat_lanes hl
    join public.heats h on h.id = hl.heat_id where h.event_id = v_event;

  perform ssc_test.check('DB-13','approval generates heats', v_after > 0, format('heats=%s', v_after));
  perform ssc_test.check('DB-13','every confirmed entry gets a lane',
    v_lanes = v_confirmed, format('lanes=%s confirmed=%s', v_lanes, v_confirmed));

  -- U14 always swims before the combined U17/Open field.
  select max(heat_number) into v_u14_max from public.heats
   where event_id = v_event and heat_group = 'U13_14';
  select min(heat_number) into v_open_min from public.heats
   where event_id = v_event and heat_group = 'U17_OPEN';
  perform ssc_test.check('DB-13','U14 heats are scheduled before U17/Open',
    v_u14_max is null or v_open_min is null or v_u14_max < v_open_min,
    format('u14_max=%s open_min=%s', v_u14_max, v_open_min));

  -- Lanes fill from the middle out.
  perform ssc_test.check('DB-13','lanes are within the 6-lane pool',
    not exists (
      select 1 from public.heat_lanes hl join public.heats h on h.id = hl.heat_id
      where h.event_id = v_event and (hl.lane_number < 1 or hl.lane_number > 6)
    ), null);
exception when others then
  perform ssc_test.check('DB-13','heat generation on approval', false, sqlerrm);
end $$;

-- Re-seeding must never destroy live scoring.
do $$
declare v_event uuid; v_lane uuid; v_heats_before int; v_heats_after int; v_admin uuid;
begin
  select h.event_id, hl.id into v_event, v_lane
    from public.heat_lanes hl join public.heats h on h.id = hl.heat_id limit 1;
  v_admin := ssc_test.user_id('elewakareem2002@gmail.com');

  perform ssc_test.act_as(v_admin);
  insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
  values (v_lane, 'valid', 30000, 'published')
  on conflict (heat_lane_id) do update set status = 'published';
  perform set_config('role','postgres',true);

  select count(*) into v_heats_before from public.heats where event_id = v_event;
  perform public.generate_heats_for_event(v_event);
  select count(*) into v_heats_after from public.heats where event_id = v_event;

  perform ssc_test.check('DB-13','re-seeding a scored event is a no-op',
    v_heats_after = v_heats_before and v_heats_after > 0,
    format('before=%s after=%s', v_heats_before, v_heats_after));
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-13','re-seed guard', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-14 — event_results ranks across ALL heats, unlike heat finish_place.
-- =============================================================================
do $$
declare
  v_event uuid; v_admin uuid; v_rows int; v_firsts int; v_distinct_heats int;
begin
  v_admin := ssc_test.user_id('elewakareem2002@gmail.com');
  select h.event_id into v_event from public.heats h
   group by h.event_id having count(*) >= 2 limit 1;
  perform ssc_test.check('DB-14','precondition: an event with 2+ heats', v_event is not null, null);
  if v_event is null then return; end if;

  perform ssc_test.act_as(v_admin);
  insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
  select hl.id, 'valid', 28000 + (abs(hashtext(hl.id::text)) % 9000), 'published'
  from public.heat_lanes hl join public.heats h on h.id = hl.heat_id
  where h.event_id = v_event
  on conflict (heat_lane_id) do update
    set status='published', result_outcome='valid',
        official_time_ms = excluded.official_time_ms;
  perform set_config('role','postgres',true);

  select count(*) into v_rows from public.event_results where event_id = v_event;
  perform ssc_test.check('DB-14','publishing produces event results', v_rows > 0,
    format('rows=%s', v_rows));

  -- Exactly one 1st place per (age group x gender) partition.
  select count(*) into v_firsts from (
    select age_group, gender from public.event_results
    where event_id = v_event and event_place = 1
    group by age_group, gender having count(*) <> 1
  ) bad;
  perform ssc_test.check('DB-14','one winner per age-group x gender partition',
    v_firsts = 0, format('partitions with wrong winner count=%s', v_firsts));

  -- The whole point: winners are drawn from more than one heat, proving the
  -- ranking is cross-heat rather than heat-local.
  select count(distinct heat_number) into v_distinct_heats
    from public.event_results where event_id = v_event;
  perform ssc_test.check('DB-14','ranking spans multiple heats',
    v_distinct_heats >= 2, format('heats represented=%s', v_distinct_heats));

  -- Ordering is genuinely by time.
  perform ssc_test.check('DB-14','event_place ascends with official time',
    not exists (
      select 1 from public.event_results a
      join public.event_results b
        on a.event_id=b.event_id and a.age_group=b.age_group and a.gender=b.gender
      where a.event_id = v_event
        and a.event_place < b.event_place
        and a.official_time_ms > b.official_time_ms
    ), null);
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-14','event results', false, sqlerrm);
end $$;

-- =============================================================================
-- Report
-- =============================================================================
\echo ''
\echo '--- L2 RLS & TRIGGER SUITE ---'
select
  case when passed then '  PASS' else '  FAIL' end as "  ",
  id, name, coalesce(detail, '') as detail
from ssc_test.results
order by seq;

\echo ''
select
  count(*) filter (where passed) as passed,
  count(*) filter (where not passed) as failed,
  count(*) as total
from ssc_test.results;

-- Non-zero exit for CI when anything failed.
do $$
declare v_failed int;
begin
  select count(*) into v_failed from ssc_test.results where not passed;
  if v_failed > 0 then
    raise exception 'RLS SUITE FAILED: % assertion(s) did not pass', v_failed;
  end if;
end $$;
