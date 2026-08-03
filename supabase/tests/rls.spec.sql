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

  -- U14 always swims before the combined U17/Open field. heat_order, NOT
  -- heat_number: numbering restarts inside each (age group, gender) bucket,
  -- so both fields start at 1 and only heat_order carries the running order.
  select max(heat_order) into v_u14_max from public.heats
   where event_id = v_event and heat_group = 'U13_14';
  select min(heat_order) into v_open_min from public.heats
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
  -- heat_order, not heat_number: two different heats now legitimately share
  -- heat_number (one per age group x gender), which would collapse the count.
  select count(distinct heat_order) into v_distinct_heats
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

-- DB-15 — male and female never share a heat.
do $$
declare v_mixed int; v_null int; v_heats int;
begin
  perform set_config('role','postgres',true);
  select count(*) into v_heats from public.heats;
  perform ssc_test.check('DB-15','precondition: heats exist to check', v_heats > 0, null);

  select count(*) into v_mixed from (
    select hl.heat_id
    from public.heat_lanes hl
    join public.entries en on en.id = hl.entry_id
    join public.athletes a on a.id = en.athlete_id
    group by hl.heat_id
    having count(distinct a.gender) > 1
  ) x;
  perform ssc_test.check('DB-15','no heat contains more than one gender', v_mixed = 0,
    format('mixed heats=%s', v_mixed));

  select count(*) into v_null from public.heats where gender is null;
  perform ssc_test.check('DB-15','every generated heat is labelled with its gender', v_null = 0,
    format('unlabelled=%s', v_null));

  -- The label must agree with who is actually in the water.
  select count(*) into v_mixed
  from public.heat_lanes hl
  join public.heats h on h.id = hl.heat_id
  join public.entries en on en.id = hl.entry_id
  join public.athletes a on a.id = en.athlete_id
  where h.gender is not null and a.gender <> h.gender;
  perform ssc_test.check('DB-15','heat gender label matches its swimmers', v_mixed = 0,
    format('mismatched lanes=%s', v_mixed));
exception when others then
  perform ssc_test.check('DB-15','gender split', false, sqlerrm);
end $$;

-- DB-16 — tied times share a place and skip the places they consumed (1,1,3).
do $$
declare v_heat uuid; v_lane uuid; i int := 0; v_places int[]; v_pts numeric[];
  v_times int[] := array[25000, 25000, 25500];
begin
  perform set_config('role','postgres',true);
  -- Only needs three lanes: two on the same time and one behind them. Larger
  -- heats are consumed by earlier assertions in this suite.
  select h.id into v_heat
  from public.heats h
  join public.heat_lanes hl on hl.heat_id = h.id
  where not exists (select 1 from public.results r
                    join public.heat_lanes hl2 on hl2.id = r.heat_lane_id
                    where hl2.heat_id = h.id)
  group by h.id having count(hl.id) >= 3 limit 1;
  perform ssc_test.check('DB-16','precondition: an unscored heat with 3+ lanes', v_heat is not null, null);
  if v_heat is null then return; end if;

  for v_lane in select id from public.heat_lanes where heat_id = v_heat order by lane_number limit 3 loop
    i := i + 1;
    insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
    values (v_lane, 'valid', v_times[i], 'draft');
  end loop;

  select array_agg(r.finish_place order by r.official_time_ms, r.finish_place),
         array_agg(r.placement_points order by r.official_time_ms, r.finish_place)
    into v_places, v_pts
  from public.results r
  join public.heat_lanes hl on hl.id = r.heat_lane_id
  where hl.heat_id = v_heat;

  -- Two tied for 1st, so the next swimmer is 3rd — not 2nd (dense ranking)
  -- and not split arbitrarily by scan order (row_number).
  perform ssc_test.check('DB-16','equal times share a place and skip the next',
    v_places = array[1,1,3], format('places=%s', v_places));
  perform ssc_test.check('DB-16','tied swimmers score identical placement points',
    v_pts[1] = v_pts[2] and v_pts[3] < v_pts[1], format('points=%s', v_pts));

  delete from public.results r using public.heat_lanes hl
    where hl.id = r.heat_lane_id and hl.heat_id = v_heat;
exception when others then
  perform ssc_test.check('DB-16','tie ranking', false, sqlerrm);
end $$;

-- DB-17 — stroke-switch events are NT no matter what the client sends.
do $$
declare v_event uuid; v_entry uuid; v_is_nt boolean; v_seed int; v_bad int;
begin
  perform set_config('role','postgres',true);
  select id into v_event from public.events where seeds_as_nt limit 1;
  perform ssc_test.check('DB-17','precondition: a switch event exists', v_event is not null, null);
  if v_event is null then return; end if;

  select count(*) into v_bad
  from public.entries en join public.events ev on ev.id = en.event_id
  where ev.seeds_as_nt and (not en.is_nt or en.seed_time_ms is not null);
  perform ssc_test.check('DB-17','no switch entry carries a seed time', v_bad = 0,
    format('violations=%s', v_bad));

  -- The trigger must win over a direct write, not just over the UI.
  select id into v_entry
  from public.entries
  where event_id = v_event and status <> 'confirmed'
  order by id
  limit 1;
  if v_entry is not null then
    update public.entries set is_nt = false, seed_time_ms = 28000 where id = v_entry;
    select is_nt, seed_time_ms into v_is_nt, v_seed from public.entries where id = v_entry;
    perform ssc_test.check('DB-17','a direct write cannot un-NT a switch entry',
      v_is_nt and v_seed is null, format('is_nt=%s seed=%s', v_is_nt, v_seed));
  end if;

  -- World Aquatics points: a base-time swim scores 1000, and an event with no
  -- base time on file is unrated (NULL), never zero.
  perform ssc_test.check('DB-17','world_aquatics_points scores a base time at 1000',
    public.world_aquatics_points('Freestyle', 50, 'male', 19900) = 1000,
    format('got %s', public.world_aquatics_points('Freestyle', 50, 'male', 19900)));
  perform ssc_test.check('DB-17','an unrated event returns NULL, not 0',
    public.world_aquatics_points('Back-to-Breast Switch', 50, 'male', 30000) is null, null);
exception when others then
  perform ssc_test.check('DB-17','switch events', false, sqlerrm);
end $$;

-- DB-18 — volume 2+ seeds from meet history, never from a declaration.
do $$
declare v_vol uuid; v_sess uuid; v_ev uuid; v_ath uuid; v_seed int; v_nt boolean;
begin
  perform set_config('role','postgres',true);
  select id into v_vol from public.meet_volumes where volume_number = 2;
  perform ssc_test.check('DB-18','precondition: a second volume exists', v_vol is not null, null);
  if v_vol is null then return; end if;

  insert into public.sessions (meet_volume_id, session_number, name, meet_date, start_time, end_time)
  values (v_vol, 1, 'DB-18 session', '2027-10-01', '09:00', '12:00')
  on conflict (meet_volume_id, session_number) do nothing;
  select id into v_sess from public.sessions where meet_volume_id = v_vol and session_number = 1;

  insert into public.events (session_id, name, stroke, distance_m, event_order, is_relay, is_skins, seeds_as_nt)
  values (v_sess, 'DB-18 50m Freestyle', 'Freestyle', 50, 99, false, false, false)
  returning id into v_ev;

  -- A swimmer with a published Vol. 1 time for the same stroke/distance.
  select en.athlete_id into v_ath
  from public.results r
  join public.heat_lanes hl on hl.id = r.heat_lane_id
  join public.entries en on en.id = hl.entry_id
  join public.events ev on ev.id = en.event_id
  where r.status = 'published' and r.result_outcome = 'valid'
    and ev.stroke = 'Freestyle' and ev.distance_m = 50
  order by en.athlete_id
  limit 1;

  perform ssc_test.check('DB-18','precondition: a swimmer with a previous official time',
    v_ath is not null, null);

  if v_ath is not null then
    -- Declare something absurd; the trigger must overwrite it.
    insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
    values (v_ev, v_ath, 1000, false, 'pending_payment');
    select seed_time_ms, is_nt into v_seed, v_nt
    from public.entries where event_id = v_ev and athlete_id = v_ath;

    perform ssc_test.check('DB-18','a declared time is replaced by the swimmer''s own record',
      v_seed is not null and v_seed <> 1000 and not v_nt,
      format('seed=%s is_nt=%s', v_seed, v_nt));
    perform ssc_test.check('DB-18','the seed equals their best previous official time',
      v_seed = public.best_previous_official_time(v_ath, v_ev),
      format('seed=%s best=%s', v_seed, public.best_previous_official_time(v_ath, v_ev)));
  end if;

  -- A swimmer who has never swum it enters NT, whatever they claim.
  select a.id into v_ath from public.athletes a
  where not exists (
    select 1 from public.results r
    join public.heat_lanes hl on hl.id = r.heat_lane_id
    join public.entries en on en.id = hl.entry_id
    join public.events ev on ev.id = en.event_id
    where en.athlete_id = a.id and ev.stroke = 'Freestyle' and ev.distance_m = 50
      and r.status = 'published' and r.result_outcome = 'valid')
  order by a.id
  limit 1;

  perform ssc_test.check('DB-18','precondition: a swimmer who has never swum it',
    v_ath is not null, null);

  if v_ath is not null then
    insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
    values (v_ev, v_ath, 26000, false, 'pending_payment');
    select seed_time_ms, is_nt into v_seed, v_nt
    from public.entries where event_id = v_ev and athlete_id = v_ath;
    perform ssc_test.check('DB-18','never swum it before means NT from volume 2',
      v_nt and v_seed is null, format('seed=%s is_nt=%s', v_seed, v_nt));
  end if;

  delete from public.entries where event_id = v_ev;
  delete from public.events where id = v_ev;
exception when others then
  perform ssc_test.check('DB-18','historical seeding', false, sqlerrm);
end $$;

-- DB-19 — World Aquatics points views.
do $$
declare v_switch int; v_neg int; v_best int; v_im boolean;
begin
  perform set_config('role','postgres',true);
  select count(*) into v_switch
  from public.performance_points pp
  join public.events ev on ev.id = pp.event_id
  where ev.seeds_as_nt and ev.stroke ilike '%switch%';
  perform ssc_test.check('DB-19','the 50m switch events have no points at all', v_switch = 0,
    format('rows=%s', v_switch));

  select count(*) into v_neg from public.performance_points where wa_points is null or wa_points <= 0;
  perform ssc_test.check('DB-19','every scored swim has positive points', v_neg = 0,
    format('bad rows=%s', v_neg));

  -- 100 IM is seeds_as_nt at ENTRY but must remain rateable: it has a base
  -- time, and filtering rating on seeds_as_nt would silently discard it.
  select seeds_as_nt into v_im from public.events where name like '100m Individual Medley%' limit 1;
  perform ssc_test.check('DB-19','100 IM is entered NT (no long course equivalent)', coalesce(v_im, false), null);
  perform ssc_test.check('DB-19','100 IM still has a base time, so it still scores',
    public.world_aquatics_points('Individual Medley', 100, 'male', 60000) > 0, null);

  select public.athlete_best_wa_points(a.id) into v_best
  from public.athletes a
  join public.entries en on en.athlete_id = a.id
  where en.seed_time_ms is not null limit 1;
  perform ssc_test.check('DB-19','a swimmer with a seed time is rateable before any results exist',
    v_best is not null and v_best > 0, format('points=%s', v_best));
exception when others then
  perform ssc_test.check('DB-19','points views', false, sqlerrm);
end $$;

-- DB-20 — Open is open to all ages, and drafts are not results.
do $$
declare v_u14_rows int; v_open_own int; v_dupes int; v_draft_visible int; v_heat uuid; v_lane uuid;
begin
  perform set_config('role','postgres',true);

  -- Age-group boards stay exclusive...
  select count(*) into v_u14_rows
  from public.event_results where age_group = 'U14' and own_age_group <> 'U14';
  perform ssc_test.check('DB-20','the U14 board contains only U14 swimmers', v_u14_rows = 0,
    format('foreign rows=%s', v_u14_rows));

  -- ...but the Open board takes everyone.
  select count(distinct own_age_group) into v_open_own
  from public.event_results where age_group = 'Open';
  perform ssc_test.check('DB-20','the Open board ranks U14 and U17 swimmers too', v_open_own > 1,
    format('distinct own age groups on the Open board=%s', v_open_own));

  -- An Open swimmer must not be duplicated by the own-group + Open expansion.
  select coalesce(max(c), 0) into v_dupes from (
    select athlete_id, event_id, age_group, count(*) c
    from public.event_results group by 1,2,3
  ) x;
  perform ssc_test.check('DB-20','no swimmer appears twice on the same board', v_dupes <= 1,
    format('max rows per swimmer per board=%s', v_dupes));

  -- A draft result must never reach the standings.
  -- order by h.id: earlier blocks consume unscored heats, so an unordered
  -- limit 1 made this block skip on some runs and not others — the assertion
  -- count wobbled between runs, which would hide a genuine skip.
  select h.id into v_heat
  from public.heats h join public.heat_lanes hl on hl.heat_id = h.id
  where not exists (select 1 from public.results r
                    join public.heat_lanes hl2 on hl2.id = r.heat_lane_id
                    where hl2.heat_id = h.id)
  group by h.id having count(hl.id) >= 1
  order by h.id limit 1;

  perform ssc_test.check('DB-20','precondition: an unscored heat to draft into',
    v_heat is not null, null);

  if v_heat is not null then
    select id into v_lane from public.heat_lanes where heat_id = v_heat order by lane_number limit 1;
    insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
    values (v_lane, 'valid', 24000, 'draft');

    select count(*) into v_draft_visible
    from public.event_results er
    join public.heat_lanes hl on hl.heat_id = v_heat
    join public.entries en on en.id = hl.entry_id
    where er.athlete_id = en.athlete_id and er.official_time_ms = 24000;
    perform ssc_test.check('DB-20','a draft result never reaches the standings', v_draft_visible = 0,
      format('leaked rows=%s', v_draft_visible));

    delete from public.results where heat_lane_id = v_lane;
  end if;
exception when others then
  perform ssc_test.check('DB-20','open board / draft isolation', false, sqlerrm);
end $$;

-- DB-21 — seeding order, heat numbering, and cumulative boards.
do $$
declare v_bad int; v_maxnum int; v_u17_from_u14 int;
begin
  perform set_config('role','postgres',true);

  -- A swimmer with a declared time must never be seeded into a LATER (faster)
  -- heat than an NT swimmer in the same bucket. Ordering by is_nt desc used to
  -- rank every NT swimmer first, landing them in the final heat.
  select count(*) into v_bad
  from public.heats h_nt
  join public.heat_lanes hl_nt on hl_nt.heat_id = h_nt.id
  join public.entries en_nt on en_nt.id = hl_nt.entry_id
  join public.heats h_t
    on h_t.event_id = h_nt.event_id
   and h_t.heat_group = h_nt.heat_group
   and h_t.gender is not distinct from h_nt.gender
  join public.heat_lanes hl_t on hl_t.heat_id = h_t.id
  join public.entries en_t on en_t.id = hl_t.entry_id
  where en_nt.is_nt and not en_t.is_nt
    and h_nt.heat_number > h_t.heat_number;
  perform ssc_test.check('DB-21','no NT swimmer is seeded above a swimmer with a time',
    v_bad = 0, format('violations=%s', v_bad));

  -- Heat numbers restart within each (age group, gender) bucket.
  select max(heat_number) into v_maxnum
  from public.heats h
  join public.events ev on ev.id = h.event_id
  where ev.is_relay = false and ev.is_skins = false;
  perform ssc_test.check('DB-21','heat numbers restart per bucket rather than running globally',
    v_maxnum is null or v_maxnum <= 6, format('max heat_number=%s', v_maxnum));

  -- Boards are cumulative: the 17 & Under board includes 14 & Under swimmers.
  select count(*) into v_u17_from_u14
  from public.event_results where age_group = 'U17' and own_age_group = 'U14';
  perform ssc_test.check('DB-21','the 17 & Under board includes 14 & Under swimmers',
    v_u17_from_u14 > 0, format('rows=%s', v_u17_from_u14));

  -- ...but never the other way round.
  select count(*) into v_bad
  from public.event_results where age_group = 'U14' and own_age_group <> 'U14';
  perform ssc_test.check('DB-21','the 14 & Under board never includes older swimmers',
    v_bad = 0, format('violations=%s', v_bad));
exception when others then
  perform ssc_test.check('DB-21','seeding order / boards', false, sqlerrm);
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
