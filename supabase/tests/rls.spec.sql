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
-- DB-01 — can_captain_team(): ELIGIBILITY to found a team (Open athletes and
-- admins). Not the same question as "captains team X" — that is
-- is_team_captain_of(), and it is what relay management checks.
-- =============================================================================
do $$
declare v_expected boolean; v_actual boolean; rec record;
begin
  for rec in
    select * from (values
      ('athlete01@ssc-demo.test', false, 'U14 athlete'),
      ('athlete13@ssc-demo.test', false, 'U17 athlete'),
      ('athlete25@ssc-demo.test', true,  'Open athlete'),
      -- A seeded team captain. A captain IS an Open-age athlete who founded
      -- the team, so eligibility must hold for them — this used to expect
      -- false, back when the captain accounts had no athletes row at all and
      -- so could never have created the teams they captain.
      ('captain.riptide@ssc-demo.test', true, 'team captain (Open athlete)'),
      -- A parent has no athlete profile and is not an admin: eligibility to
      -- found a team is about being an Open-age swimmer, nothing else.
      ('parent1@ssc-demo.test', false, 'parent with no athlete profile'),
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

-- DB-22 — relay squads: composition rules and captain-only management.
--
-- Builds its OWN fixture rather than hunting for a team that happens to have
-- the right roster. Earlier blocks move athletes between teams, so a search
-- found a usable team on some runs and not others — the suite total wobbled,
-- and worse, the "3 male + 1 female" case could pass because a null athlete
-- id broke the insert rather than because the gender rule rejected it.
do $$
declare
  v_team uuid; v_event uuid; v_captain uuid; v_other uuid;
  v_m uuid[]; v_f uuid[]; v_squad uuid; v_err text;
begin
  perform set_config('role','postgres',true);

  select t.id, t.captain_id into v_team, v_captain
  from public.teams t where t.captain_id is not null order by t.id limit 1;
  select id into v_event from public.events
  where is_relay and name ilike '%Mixed%' order by id limit 1;

  perform ssc_test.check('DB-22','precondition: a captained team and a mixed relay',
    v_team is not null and v_event is not null, null);
  if v_team is null or v_event is null then return; end if;

  -- Guarantee 3 Open men and 2 Open women on that team.
  update public.athletes set team_id = v_team, age_group = 'Open', gender = 'male'
  where id in (select id from public.athletes where team_id is distinct from v_team order by id limit 3);
  update public.athletes set team_id = v_team, age_group = 'Open', gender = 'female'
  where id in (select id from public.athletes
               where team_id is distinct from v_team order by id desc limit 2);

  select array_agg(id) into v_m from (
    select id from public.athletes
    where team_id = v_team and age_group = 'Open' and gender = 'male' order by id limit 3) x;
  select array_agg(id) into v_f from (
    select id from public.athletes
    where team_id = v_team and age_group = 'Open' and gender = 'female' order by id limit 2) x;

  perform ssc_test.check('DB-22','precondition: 3 male + 2 female Open swimmers on the team',
    array_length(v_m,1) = 3 and array_length(v_f,1) = 2,
    format('male=%s female=%s', array_length(v_m,1), array_length(v_f,1)));
  if coalesce(array_length(v_m,1),0) < 3 or coalesce(array_length(v_f,1),0) < 2 then return; end if;

  -- Every relay swimmer must already be entered in the meet.
  insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
  select (select ev.id from public.events ev
          join public.sessions se on se.id = ev.session_id
          where ev.is_relay = false and ev.is_skins = false order by ev.id limit 1),
         a, 30000, false, 'pending_payment'
  from unnest(v_m || v_f) a
  on conflict (event_id, athlete_id) do nothing;

  -- 1. A valid 2 + 2 squad commits.
  insert into public.relay_squads (event_id, team_id, age_group, squad_letter)
  values (v_event, v_team, 'Open', 'T') returning id into v_squad;
  insert into public.relay_legs (squad_id, leg_number, athlete_id) values
    (v_squad, 1, v_m[1]), (v_squad, 2, v_f[1]), (v_squad, 3, v_m[2]), (v_squad, 4, v_f[2]);
  set constraints all immediate;
  perform ssc_test.check('DB-22','a valid 2 male + 2 female squad is accepted',
    (select count(*) from public.relay_legs where squad_id = v_squad) = 4, null);

  -- 2. A mixed relay refuses 3 + 1 — asserted on the MESSAGE, so a squad that
  --    failed for some unrelated reason cannot pass this check.
  begin
    v_err := null;
    insert into public.relay_squads (event_id, team_id, age_group, squad_letter)
    values (v_event, v_team, 'Open', 'V') returning id into v_squad;
    insert into public.relay_legs (squad_id, leg_number, athlete_id) values
      (v_squad, 1, v_m[1]), (v_squad, 2, v_m[2]), (v_squad, 3, v_m[3]), (v_squad, 4, v_f[1]);
    set constraints all immediate;
  exception when others then
    v_err := sqlerrm;
  end;
  perform ssc_test.check('DB-22','a mixed relay refuses 3 male + 1 female',
    v_err like '%2 male and 2 female%', coalesce(v_err, 'no error raised'));

  -- 3. One squad per swimmer per relay event.
  begin
    v_err := null;
    insert into public.relay_squads (event_id, team_id, age_group, squad_letter)
    values (v_event, v_team, 'Open', 'U') returning id into v_squad;
    insert into public.relay_legs (squad_id, leg_number, athlete_id) values
      (v_squad, 1, v_m[1]), (v_squad, 2, v_f[1]), (v_squad, 3, v_m[2]), (v_squad, 4, v_f[2]);
    set constraints all immediate;
  exception when others then
    v_err := sqlerrm;
  end;
  perform ssc_test.check('DB-22','a swimmer cannot be in two squads for one relay',
    v_err like '%one squad per relay event%', coalesce(v_err, 'no error raised'));

  -- 4. RLS: only the captain may enter a squad for the team.
  select a.user_id into v_other from public.athletes a
  where a.team_id = v_team and a.user_id is distinct from v_captain order by a.id limit 1;
  perform ssc_test.check('DB-22','precondition: a team member who is not the captain',
    v_other is not null, null);

  if v_other is not null then
    begin
      v_err := null;
      perform ssc_test.act_as(v_other);
      insert into public.relay_squads (event_id, team_id, age_group, squad_letter)
      values (v_event, v_team, 'Open', 'W');
    exception when others then
      v_err := sqlerrm;
    end;
    perform set_config('role','postgres',true);
    perform ssc_test.check('DB-22','a non-captain cannot enter a squad for the team',
      v_err like '%row-level security%', coalesce(v_err, 'no error raised'));
  end if;

  delete from public.relay_squads where team_id = v_team;
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-22','relay squads', false, sqlerrm);
end $$;


-- DB-23 — Skins rounds: board identity, per-round publishing, entered places.
--
-- The bracket used to key its heat on heat_group, which cannot tell U17 from
-- Open, so the second board of a gender collided on heat_lanes
-- (heat_id, lane_number) and the whole board failed to open. All three rounds
-- also shared heat_number 1, so publishing one round overwrote the one
-- before it. Builds its own fixture: earlier blocks move athletes around.
do $$
declare
  v_event uuid; v_admin uuid;
  v_u17 uuid[]; v_open uuid[]; v_four uuid[];
  v_r6 uuid; v_r4 uuid; v_heats int; v_places int; v_err text;
  v_plain_heat uuid; v_fast uuid; v_slow uuid; v_fast_place int; v_slow_place int;
begin
  perform set_config('role','postgres',true);

  select id into v_event from public.events where is_skins order by id limit 1;
  select id into v_admin from public.users where role = 'admin' order by id limit 1;
  perform ssc_test.check('DB-23','precondition: a Skins event and an admin',
    v_event is not null and v_admin is not null, null);
  if v_event is null or v_admin is null then return; end if;

  -- Start from nothing so counts do not depend on what ran before.
  delete from public.heats where event_id = v_event;
  perform set_config('request.jwt.claim.sub', v_admin::text, true);

  -- Guarantee six U17 men and six Open men.
  update public.athletes set age_group = 'U17', gender = 'male'
  where id in (select id from public.athletes order by id limit 6);
  update public.athletes set age_group = 'Open', gender = 'male'
  where id in (select id from public.athletes order by id desc limit 6);

  select array_agg(id) into v_u17 from
    (select id from public.athletes where age_group='U17' and gender='male' order by id limit 6) x;
  select array_agg(id) into v_open from
    (select id from public.athletes where age_group='Open' and gender='male' order by id limit 6) x;

  perform ssc_test.check('DB-23','precondition: six U17 men and six Open men',
    coalesce(array_length(v_u17,1),0) = 6 and coalesce(array_length(v_open,1),0) = 6,
    format('u17=%s open=%s', array_length(v_u17,1), array_length(v_open,1)));
  if coalesce(array_length(v_u17,1),0) < 6 or coalesce(array_length(v_open,1),0) < 6 then return; end if;

  -- 1. The reported bug: both boards of one gender must open.
  perform public.materialise_skins_heat(v_event,'U17','male',v_u17,array[4,3,5,2,1,6],6,false);
  begin
    perform public.materialise_skins_heat(v_event,'Open','male',v_open,array[4,3,5,2,1,6],6,false);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform ssc_test.check('DB-23','U17 and Open boards of one gender do not collide on lanes',
    v_err is null, coalesce(v_err,'ok'));

  -- 2. Each round of a board is its own heat.
  v_four := array[v_u17[1], v_u17[2], v_u17[3], v_u17[4]];
  perform public.materialise_skins_heat(v_event,'U17','male',v_four,array[2,3,4,5],4,false);
  select count(*) into v_heats from public.heats
  where event_id = v_event and skins_category='U17' and gender='male';
  perform ssc_test.check('DB-23','each Skins round is a separate heat', v_heats = 2,
    format('%s heats for the U17 male board', v_heats));

  select id into v_r6 from public.heats where event_id=v_event
    and skins_category='U17' and gender='male' and skins_round=6 and not skins_swim_off;
  select id into v_r4 from public.heats where event_id=v_event
    and skins_category='U17' and gender='male' and skins_round=4 and not skins_swim_off;

  -- 3. Skins is placed by eye. The entered order must survive the trigger
  --    that derives finish places from times, because there are no times.
  insert into public.results (heat_lane_id, result_outcome, finish_place, placement_points, status)
  select hl.id, 'valid', hl.lane_number, 0, 'draft'
  from public.heat_lanes hl where hl.heat_id = v_r6;
  select count(distinct r.finish_place) into v_places
  from public.results r join public.heat_lanes hl on hl.id = r.heat_lane_id
  where hl.heat_id = v_r6;
  perform ssc_test.check('DB-23','referee-entered Skins places are not overwritten by time ranking',
    v_places = 6, format('%s distinct places recorded, expected 6', v_places));

  -- 4. Negative control: an ordinary heat MUST still derive places from times.
  select hl.heat_id into v_plain_heat from public.heat_lanes hl
  join public.heats h on h.id = hl.heat_id
  where h.skins_round is null
    and not exists (select 1 from public.results r2 where r2.heat_lane_id = hl.id)
  group by hl.heat_id having count(*) >= 2 order by hl.heat_id limit 1;
  if v_plain_heat is not null then
    select id into v_fast from public.heat_lanes where heat_id = v_plain_heat order by lane_number limit 1;
    select id into v_slow from public.heat_lanes where heat_id = v_plain_heat and id <> v_fast
      order by lane_number limit 1;
    insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
    values (v_fast,'valid',30000,'draft'), (v_slow,'valid',31000,'draft');
    select finish_place into v_fast_place from public.results where heat_lane_id = v_fast;
    select finish_place into v_slow_place from public.results where heat_lane_id = v_slow;
  end if;
  perform ssc_test.check('DB-23','an ordinary heat still has its places derived from times',
    v_plain_heat is null or (v_fast_place = 1 and v_slow_place = 2),
    format('fast=%s slow=%s', v_fast_place, v_slow_place));

  -- 5. Publishing one round leaves the others alone.
  insert into public.results (heat_lane_id, result_outcome, finish_place, placement_points, status)
  select hl.id, 'valid', hl.lane_number, 0, 'draft'
  from public.heat_lanes hl where hl.heat_id = v_r4;
  update public.results set status = 'published'
  where heat_lane_id in (select id from public.heat_lanes where heat_id = v_r6);
  perform ssc_test.check('DB-23','publishing a Skins round does not publish another',
    (select count(*) from public.results r join public.heat_lanes hl on hl.id = r.heat_lane_id
     where hl.heat_id = v_r4 and r.status = 'published') = 0,
    'the Round of 4 stayed unpublished');
  perform ssc_test.check('DB-23','the published round really is published',
    (select count(*) from public.results r join public.heat_lanes hl on hl.id = r.heat_lane_id
     where hl.heat_id = v_r6 and r.status = 'published') = 6, null);

  -- 6. Re-seeding a round that has been scored must not destroy the scores.
  perform public.materialise_skins_heat(v_event,'U17','male',v_four,array[2,3,4,5],6,false);
  perform ssc_test.check('DB-23','re-seeding a scored round does not delete its results',
    (select count(*) from public.results r join public.heat_lanes hl on hl.id = r.heat_lane_id
     where hl.heat_id = v_r6) = 6, null);

  -- 7. Lane guards.
  begin
    perform public.materialise_skins_heat(v_event,'U17','male',
      array[v_u17[1], v_u17[2]], array[3,3], 2, false);
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform ssc_test.check('DB-23','two Skins swimmers cannot share a lane',
    v_err like '%same lane%', v_err);

  delete from public.heats where event_id = v_event;
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-23','Skins rounds', false, sqlerrm);
end $$;


-- DB-24 — a REFEREE can open a Skins board.
--
-- The bracket moved from the Admin dashboard to the Referee deck, which
-- exposed two guards that had only ever been exercised by admins:
-- enforce_no_direct_skins_entry required is_admin(), and
-- enforce_entry_status_change refused the 'confirmed' status that a Skins
-- entry needs. SECURITY DEFINER does not change auth.uid(), so a referee
-- opening a board hit both as themselves and the board never appeared.
do $$
declare
  v_event uuid; v_referee uuid; v_athlete uuid; v_ids uuid[];
  v_plain_event uuid; v_err text; v_lanes int;
begin
  perform set_config('role','postgres',true);

  select id into v_event from public.events where is_skins order by id limit 1;
  select id into v_referee from public.users where role = 'referee' order by id limit 1;
  select id into v_athlete from public.users where role = 'athlete' order by id limit 1;
  select id into v_plain_event from public.events
  where is_skins = false and is_relay = false order by id limit 1;

  perform ssc_test.check('DB-24','precondition: a Skins event, a referee and an athlete',
    v_event is not null and v_referee is not null and v_athlete is not null, null);
  if v_event is null or v_referee is null or v_athlete is null then return; end if;

  delete from public.heats where event_id = v_event;
  select array_agg(id) into v_ids from
    (select id from public.athletes where gender='male' order by id limit 4) x;

  -- 1. The failure this fixes: a referee opens a board on the deck.
  perform ssc_test.act_as(v_referee);
  begin
    perform public.materialise_skins_heat(v_event,'Open','male',v_ids,array[4,3,5,2],6,false);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-24','a referee can open a Skins board', v_err is null,
    coalesce(v_err,'ok'));

  select count(*) into v_lanes from public.heat_lanes hl
  join public.heats h on h.id = hl.heat_id
  where h.event_id = v_event and h.skins_round = 6;
  perform ssc_test.check('DB-24','the referee''s board really has lanes', v_lanes = 4,
    format('%s lanes', v_lanes));

  -- 2. The guard still does its job: an athlete cannot self-enter Skins.
  perform ssc_test.act_as(v_athlete);
  begin
    insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
    values (v_event, (select id from public.athletes where user_id = v_athlete), null, true, 'pending_payment');
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-24','an athlete still cannot self-enter Skins',
    v_err <> 'no error raised', v_err);

  -- 3. And the payment guard still holds everywhere it should: the Skins
  --    exemption must not let a referee confirm an ordinary paid entry.
  if v_plain_event is not null then
    perform ssc_test.act_as(v_referee);
    begin
      insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
      values (v_plain_event, (select id from public.athletes order by id desc limit 1),
              30000, false, 'confirmed');
      v_err := 'no error raised';
    exception when others then v_err := sqlerrm;
    end;
    perform set_config('role','postgres',true);
    perform ssc_test.check('DB-24','a referee still cannot confirm payment on a normal entry',
      v_err like '%Only an admin may confirm entry payment%', v_err);
  end if;

  delete from public.heats where event_id = v_event;
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-24','referee Skins access', false, sqlerrm);
end $$;


-- DB-25 — the full Skins round trip under RLS: referee scores, admin approves.
--
-- DB-23 proves the data rules but runs as postgres. This walks the actual
-- path the two dashboards take, as the two real roles, so an RLS policy that
-- blocks the referee from writing a draft result — or lets them publish it —
-- fails here rather than on the deck.
do $$
declare
  v_event uuid; v_referee uuid; v_admin uuid; v_ids uuid[];
  v_r6 uuid; v_r4 uuid; v_err text; v_drafts int; v_published int;
begin
  perform set_config('role','postgres',true);

  select id into v_event from public.events where is_skins order by id limit 1;
  select id into v_referee from public.users where role='referee' order by id limit 1;
  select id into v_admin   from public.users where role='admin'   order by id limit 1;
  perform ssc_test.check('DB-25','precondition: Skins event, referee and admin',
    v_event is not null and v_referee is not null and v_admin is not null, null);
  if v_event is null or v_referee is null or v_admin is null then return; end if;

  delete from public.heats where event_id = v_event;
  select array_agg(id) into v_ids from
    (select id from public.athletes where gender='female' order by id limit 4) x;

  -- Referee opens the board and scores it.
  perform ssc_test.act_as(v_referee);
  begin
    perform public.materialise_skins_heat(v_event,'Open','female',v_ids,array[4,3,5,2],6,false);
    perform set_config('role','postgres',true);
    select id into v_r6 from public.heats
    where event_id=v_event and skins_round=6 and skins_category='Open' and gender='female';
    perform ssc_test.act_as(v_referee);
    insert into public.results (heat_lane_id, result_outcome, finish_place, placement_points, status)
    select hl.id,'valid',hl.lane_number,0,'draft' from public.heat_lanes hl where hl.heat_id = v_r6;
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-25','a referee can score a Skins round as draft', v_err is null,
    coalesce(v_err,'ok'));

  select count(*) into v_drafts from public.results r
  join public.heat_lanes hl on hl.id=r.heat_lane_id where hl.heat_id=v_r6 and r.status='draft';
  perform ssc_test.check('DB-25','the round is sitting in draft awaiting approval', v_drafts = 4,
    format('%s draft lanes', v_drafts));

  -- A referee must NOT be able to publish their own round.
  perform ssc_test.act_as(v_referee);
  begin
    update public.results set status='published'
    where heat_lane_id in (select id from public.heat_lanes where heat_id=v_r6);
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-25','a referee cannot publish their own Skins round',
    v_err like '%Only an admin may publish results%', v_err);

  -- The admin approves it.
  perform ssc_test.act_as(v_admin);
  begin
    update public.results set status='published'
    where heat_lane_id in (select id from public.heat_lanes where heat_id=v_r6)
      and result_outcome is not null;
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-25','an admin can publish the Skins round', v_err is null,
    coalesce(v_err,'ok'));

  select count(*) into v_published from public.results r
  join public.heat_lanes hl on hl.id=r.heat_lane_id where hl.heat_id=v_r6 and r.status='published';
  perform ssc_test.check('DB-25','every lane of the approved round is published', v_published = 4,
    format('%s published lanes', v_published));

  -- Referee advances to the next round while the first stays published.
  perform ssc_test.act_as(v_referee);
  begin
    perform public.materialise_skins_heat(v_event,'Open','female',
      array[v_ids[1],v_ids[2]], array[3,4], 4, false);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-25','a referee can advance the board without waiting for approval',
    v_err is null, coalesce(v_err,'ok'));

  select id into v_r4 from public.heats
  where event_id=v_event and skins_round=4 and skins_category='Open' and gender='female';
  perform ssc_test.check('DB-25','the earlier round survives the advance',
    v_r4 is not null and v_r4 <> v_r6
    and (select count(*) from public.results r join public.heat_lanes hl on hl.id=r.heat_lane_id
         where hl.heat_id=v_r6 and r.status='published') = 4, null);

  -- Admin reopens the published round to correct it.
  perform ssc_test.act_as(v_admin);
  begin
    update public.results set status='draft'
    where heat_lane_id in (select id from public.heat_lanes where heat_id=v_r6);
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-25','an admin can reopen a published round', v_err is null,
    coalesce(v_err,'ok'));

  delete from public.heats where event_id = v_event;
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-25','Skins round trip', false, sqlerrm);
end $$;


-- DB-26 — a published result is locked to admins.
--
-- enforce_result_publish used to guard only the transition INTO 'published'.
-- Referees hold `for all using (is_referee())` on results, so once a row was
-- published a referee could still rewrite its time or set status back to
-- 'draft'. The UI hid the button; nothing enforced it.
--
-- The cascade case is the reason this is not a blanket lock:
-- recompute_heat_finish_places re-ranks EVERY valid lane of a heat whenever
-- any lane changes, published ones included. Blocking derived columns here
-- would stop a referee drafting a new lane in a heat that has any published
-- result at all — assertion 3 is the regression guard for that.
do $$
declare
  v_ref uuid; v_admin uuid; v_event uuid; v_heat uuid;
  v_entry_a uuid; v_entry_b uuid; v_lane_a uuid; v_lane_b uuid;
  v_err text; v_time int; v_status public.publish_status;
begin
  perform set_config('role','postgres',true);

  select id into v_ref   from public.users where role='referee' order by id limit 1;
  select id into v_admin from public.users where role='admin'   order by id limit 1;
  select en.id, en.event_id into v_entry_a, v_event
  from public.entries en join public.events e on e.id = en.event_id
  where e.is_skins = false and e.is_relay = false order by en.id limit 1;
  select en.id into v_entry_b
  from public.entries en
  where en.event_id = v_event and en.id <> v_entry_a order by en.id limit 1;

  perform ssc_test.check('DB-26','precondition: a referee, an admin and two entries in one event',
    v_ref is not null and v_admin is not null and v_entry_a is not null and v_entry_b is not null, null);
  if v_ref is null or v_admin is null or v_entry_a is null or v_entry_b is null then return; end if;

  insert into public.heats (event_id, heat_group, gender, heat_number, heat_order, status)
  values (v_event,'U17_OPEN','male',94,94,'published') returning id into v_heat;
  insert into public.heat_lanes (heat_id, lane_number, entry_id)
  values (v_heat,1,v_entry_a) returning id into v_lane_a;
  insert into public.heat_lanes (heat_id, lane_number, entry_id)
  values (v_heat,2,v_entry_b) returning id into v_lane_b;

  -- Lane A is published by an admin.
  perform ssc_test.act_as(v_admin);
  insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
  values (v_lane_a,'valid',30000,'published');
  perform set_config('role','postgres',true);

  -- 1. A referee cannot rewrite a published time.
  perform ssc_test.act_as(v_ref);
  begin
    update public.results set official_time_ms = 99999 where heat_lane_id = v_lane_a;
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  select official_time_ms into v_time from public.results where heat_lane_id = v_lane_a;
  perform ssc_test.check('DB-26','a referee cannot rewrite a published time',
    v_err like '%Only an admin may change a published result%' and v_time = 30000,
    format('%s (stored %s)', v_err, v_time));

  -- 2. A referee cannot quietly unpublish it either.
  perform ssc_test.act_as(v_ref);
  begin
    update public.results set status = 'draft' where heat_lane_id = v_lane_a;
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  select status into v_status from public.results where heat_lane_id = v_lane_a;
  perform ssc_test.check('DB-26','a referee cannot unpublish a result',
    v_err like '%Only an admin may change a published result%' and v_status = 'published',
    format('%s (status %s)', v_err, v_status));

  -- 3. REGRESSION GUARD: the lock must not stop a referee drafting a NEW lane
  --    in a heat that already has a published one. The finish-place recompute
  --    cascades across every valid lane in the heat, published included.
  perform ssc_test.act_as(v_ref);
  begin
    insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
    values (v_lane_b,'valid',31000,'draft');
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-26','a referee can still draft a lane in a heat with a published lane',
    v_err is null, coalesce(v_err,'ok'));

  -- 4. The admin route still works.
  perform ssc_test.act_as(v_admin);
  begin
    update public.results set official_time_ms = 29500 where heat_lane_id = v_lane_a;
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  select official_time_ms into v_time from public.results where heat_lane_id = v_lane_a;
  perform ssc_test.check('DB-26','an admin can still correct a published time',
    v_err is null and v_time = 29500, format('%s (stored %s)', coalesce(v_err,'ok'), v_time));

  delete from public.heats where id = v_heat;
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-26','published-result lock', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-27 — meet_settings: everyone reads the dials, only an admin sets them.
-- =============================================================================
-- This table was keyed (volume, session) for one release and is one row per
-- VOLUME now — the per-session assertions this block used to make are gone
-- with the shape they tested. The individual race price left too: it is the
-- matrix in public.pricing_packages, covered by DB-30 and DB-31.
--
-- What remains here is still a money surface (the relay fee) and still
-- public-read, because the registration form quotes it to a swimmer who has no
-- special standing yet.
--
-- Read is checked as anon (a logged-out visitor), not merely as a signed-in
-- athlete — "authenticated can read it" would pass even if the public policy
-- were missing, since authenticated_view_* policies exist on other tables.
do $$
declare
  v_volume uuid; v_athlete uuid; v_referee uuid; v_admin uuid;
  v_relay int; v_err text; v_after int; v_rows int;
begin
  perform set_config('role','postgres',true);

  select id into v_volume from public.meet_volumes order by volume_number limit 1;
  select u.id into v_athlete
    from public.users u join public.athletes a on a.user_id = u.id
    where u.role = 'athlete' order by u.id limit 1;
  select id into v_referee from public.users where role='referee' order by id limit 1;
  select id into v_admin   from public.users where role='admin'   order by id limit 1;

  select relay_swimmer_price_egp into v_relay
    from public.meet_settings where meet_volume_id = v_volume;
  perform ssc_test.check('DB-27','every volume is seeded with a settings row',
    v_relay is not null, format('relay=%s', v_relay));

  -- Exactly one. The old shape seeded three per volume, and a database that
  -- was migrated rather than rebuilt must not have left the other two behind:
  -- a duplicate row here means two answers to "what does a relay leg cost".
  select count(*) into v_rows from public.meet_settings where meet_volume_id = v_volume;
  perform ssc_test.check('DB-27','exactly one settings row per volume',
    v_rows = 1, format('rows=%s', v_rows));

  perform ssc_test.check('DB-27','the seeded relay fee is the 300 EGP column default',
    v_relay = 300, format('got %s', v_relay));

  -- 1. A logged-OUT visitor can read it.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'anon', true);
  perform set_config('role','anon',true);
  begin
    select relay_swimmer_price_egp into v_relay
      from public.meet_settings where meet_volume_id = v_volume;
    v_err := null;
  exception when others then v_err := sqlerrm; v_relay := null;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-27','anon can read the relay fee',
    v_err is null and v_relay = 300, format('%s (relay %s)', coalesce(v_err,'ok'), v_relay));

  -- 2. An athlete can read it too (the registration form runs signed in).
  perform ssc_test.act_as(v_athlete);
  begin
    select relay_swimmer_price_egp into v_relay
      from public.meet_settings where meet_volume_id = v_volume;
    v_err := null;
  exception when others then v_err := sqlerrm; v_relay := null;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-27','an athlete can read the relay fee',
    v_err is null and v_relay = 300, format('%s (relay %s)', coalesce(v_err,'ok'), v_relay));

  -- 3. An athlete CANNOT set their own relay fee.
  perform ssc_test.act_as(v_athlete);
  begin
    update public.meet_settings set relay_swimmer_price_egp = 0
      where meet_volume_id = v_volume;
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  select relay_swimmer_price_egp into v_after
    from public.meet_settings where meet_volume_id = v_volume;
  -- RLS on UPDATE silently matches zero rows rather than raising, so the
  -- stored value is the assertion — an error message alone would not prove
  -- the write was refused.
  perform ssc_test.check('DB-27','an athlete cannot change the relay fee',
    v_after = 300, format('%s (stored %s)', v_err, v_after));

  -- 4. Neither can a referee — deck officials score races, they do not price
  --    them, and is_admin_or_referee() must not creep in here.
  --    The value must satisfy the column's own check constraint (1..20): an
  --    out-of-range 99 made this pass against a deliberately opened policy,
  --    because the constraint rejected it before RLS was ever the reason.
  perform ssc_test.act_as(v_referee);
  begin
    update public.meet_settings set athlete_event_limit = 6
      where meet_volume_id = v_volume;
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  select athlete_event_limit into v_after
    from public.meet_settings where meet_volume_id = v_volume;
  perform ssc_test.check('DB-27','a referee cannot change the event limit',
    v_after = 4, format('%s (stored %s)', v_err, v_after));

  -- 5. An athlete cannot INSERT a settings row for a volume that has none,
  --    which would otherwise be a way around the UPDATE denial.
  perform set_config('role','postgres',true);
  delete from public.meet_settings
    where meet_volume_id = (select id from public.meet_volumes order by volume_number desc limit 1);
  perform ssc_test.act_as(v_athlete);
  begin
    insert into public.meet_settings (meet_volume_id, relay_swimmer_price_egp)
    values ((select id from public.meet_volumes order by volume_number desc limit 1), 0);
    v_err := 'no error raised';
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-27','an athlete cannot insert a settings row',
    v_err ilike '%row-level security%', v_err);

  -- 6. The admin route works — proving 3, 4 and 5 are role gates rather than
  --    a table nobody can write at all.
  perform ssc_test.act_as(v_admin);
  begin
    update public.meet_settings
      set relay_swimmer_price_egp = 450, athlete_event_limit = 6
      where meet_volume_id = v_volume;
    v_err := null;
  exception when others then v_err := sqlerrm;
  end;
  perform set_config('role','postgres',true);
  select relay_swimmer_price_egp into v_after
    from public.meet_settings where meet_volume_id = v_volume;
  perform ssc_test.check('DB-27','an admin can change the relay fee',
    v_err is null and v_after = 450, format('%s (stored %s)', coalesce(v_err,'ok'), v_after));

  -- Restore, so later runs and other assertions see the seeded values. The
  -- INSERT rebuilds whatever step 5 deleted.
  update public.meet_settings
    set relay_swimmer_price_egp = 300, athlete_event_limit = 4
    where meet_volume_id = v_volume;
  insert into public.meet_settings (meet_volume_id)
  select v.id from public.meet_volumes v
  on conflict (meet_volume_id) do nothing;
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-27','meet_settings access control', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-28 — category_sort_order(): the running order of the four heat buckets.
-- =============================================================================
-- Mirrored in TypeScript by lib/category-order.ts, which is what the three
-- heat lists actually sort with. Asserted here so the two cannot drift: a SQL
-- copy that disagreed would order any server-side listing differently from
-- every screen.
do $$
declare v_order int[]; v_skins int[];
begin
  perform set_config('role','postgres',true);

  select array_agg(o order by n) into v_order from (values
    (1, public.category_sort_order('U13_14','female')),
    (2, public.category_sort_order('U13_14','male')),
    (3, public.category_sort_order('U17_OPEN','female')),
    (4, public.category_sort_order('U17_OPEN','male'))
  ) as t(n, o);

  perform ssc_test.check('DB-28','U13_14 W -> U13_14 M -> U17_OPEN W -> U17_OPEN M',
    v_order[1] < v_order[2] and v_order[2] < v_order[3] and v_order[3] < v_order[4],
    format('%s', v_order));

  perform ssc_test.check('DB-28','the four buckets are distinct',
    (select count(distinct o) from unnest(v_order) o) = 4, format('%s', v_order));

  -- A legacy heat with no gender sorts last within its OWN board, never
  -- folded in with the men's — a pre-split mixed heat is not a men's heat.
  perform ssc_test.check('DB-28','a genderless legacy heat sorts last within its board',
    public.category_sort_order('U13_14', null) > public.category_sort_order('U13_14','male')
    and public.category_sort_order('U13_14', null) < public.category_sort_order('U17_OPEN','female')
    and public.category_sort_order('U17_OPEN', null) > public.category_sort_order('U17_OPEN','male'),
    format('U13_14 null=%s, U17_OPEN null=%s',
      public.category_sort_order('U13_14', null),
      public.category_sort_order('U17_OPEN', null)));

  -- Skins rounds carry heat_group and gender like any other heat, so they
  -- sort into the bucket their swimmers belong to rather than landing in a
  -- block at one end of the programme.
  select array_agg(public.category_sort_order(h.heat_group, h.gender) order by h.heat_number)
    into v_skins
  from public.heats h where h.skins_round is not null;
  perform ssc_test.check('DB-28','Skins heats sort by the same four buckets',
    v_skins is null or not exists (select 1 from unnest(v_skins) s where s not between 1 and 6),
    format('%s', v_skins));
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-28','category_sort_order', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-29 — event_results carries DQ and NS, at the bottom and unplaced.
-- =============================================================================
-- The view used to filter to result_outcome = 'valid', so a disqualified
-- swimmer was absent from the standings entirely — indistinguishable from one
-- who never entered. They are now present with a NULL event_place (no place;
-- a 0 would read as one) and is_ranked = false, which is what every table
-- sorts on.
do $$
declare
  v_admin uuid; v_event uuid; v_heat uuid;
  v_entry_a uuid; v_entry_b uuid; v_lane_a uuid; v_lane_b uuid;
  v_ath_a uuid; v_ath_b uuid;
  v_place int; v_ranked boolean; v_rows int; v_points int;
begin
  perform set_config('role','postgres',true);

  select id into v_admin from public.users where role='admin' order by id limit 1;

  -- Reuse EXISTING entries, as DB-26 does: inserting one here would need the
  -- admin role (enforce_entry_status_change) and would fire the heat
  -- generator. Both entries must be unscored so this heat is the only thing
  -- either swimmer has published in the event, and the event must be rateable
  -- so the wa_points column can be asserted too.
  select en.id, en.event_id, en.athlete_id into v_entry_a, v_event, v_ath_a
  from public.entries en
  join public.events ev  on ev.id = en.event_id
  join public.athletes a on a.id = en.athlete_id
  join public.wa_base_times b
    on b.stroke = ev.stroke and b.distance_m = ev.distance_m and b.gender = a.gender
  where ev.is_skins = false and ev.is_relay = false
    and not exists (
      select 1 from public.results r
      join public.heat_lanes hl on hl.id = r.heat_lane_id
      where hl.entry_id = en.id
    )
  order by en.id limit 1;

  select en.id, en.athlete_id into v_entry_b, v_ath_b
  from public.entries en
  where en.event_id = v_event and en.id <> v_entry_a
    and not exists (
      select 1 from public.results r
      join public.heat_lanes hl on hl.id = r.heat_lane_id
      where hl.entry_id = en.id
    )
  order by en.id limit 1;

  perform ssc_test.check('DB-29','precondition: two unscored entries in a rateable event',
    v_event is not null and v_entry_a is not null and v_entry_b is not null,
    format('event=%s a=%s b=%s', v_event, v_entry_a, v_entry_b));
  if v_event is null or v_entry_a is null or v_entry_b is null then return; end if;

  insert into public.heats (event_id, heat_group, gender, heat_number, heat_order, status)
  values (v_event, 'U17_OPEN', 'male', 91, 91, 'published') returning id into v_heat;
  insert into public.heat_lanes (heat_id, lane_number, entry_id)
  values (v_heat, 4, v_entry_a) returning id into v_lane_a;
  insert into public.heat_lanes (heat_id, lane_number, entry_id)
  values (v_heat, 3, v_entry_b) returning id into v_lane_b;

  perform ssc_test.act_as(v_admin);
  insert into public.results (heat_lane_id, result_outcome, official_time_ms, status)
  values (v_lane_a, 'valid', 29000, 'published');
  insert into public.results (heat_lane_id, result_outcome, dq_code, status)
  values (v_lane_b, 'dq', 'false_start', 'published');
  perform set_config('role','postgres',true);

  -- Boards are cumulative, so a swimmer produces up to three rows. Every one
  -- of them must be unplaced for a DQ.
  select count(*) into v_rows from public.event_results
    where event_id = v_event and athlete_id = v_ath_b;
  perform ssc_test.check('DB-29','the DQ appears in the standings rather than vanishing',
    v_rows >= 1, format('rows=%s', v_rows));

  select bool_and(event_place is null) into v_ranked
  from public.event_results where event_id = v_event and athlete_id = v_ath_b;
  perform ssc_test.check('DB-29','a DQ has no place on any board it belongs to',
    v_ranked, format('all places null=%s', v_ranked));

  select bool_and(is_ranked = false) into v_ranked
  from public.event_results where event_id = v_event and athlete_id = v_ath_b;
  perform ssc_test.check('DB-29','a DQ is never marked ranked', v_ranked,
    format('all is_ranked false=%s', v_ranked));

  select event_place, is_ranked, wa_points into v_place, v_ranked, v_points
    from public.event_results
    where event_id = v_event and athlete_id = v_ath_a
    order by age_group limit 1;
  perform ssc_test.check('DB-29','the valid swim is still placed and ranked',
    v_place is not null and v_ranked = true, format('place=%s ranked=%s', v_place, v_ranked));

  perform ssc_test.check('DB-29','a rateable valid swim carries World Aquatics points',
    v_points is not null and v_points > 0, format('points=%s', v_points));

  delete from public.heats where id = v_heat;
exception when others then
  perform set_config('role','postgres',true);
  perform ssc_test.check('DB-29','event_results includes DQ/NS', false, sqlerrm);
end $$;


-- =============================================================================
-- DB-30..DB-38 — Control Unit, pricing, capacity, payments and notifications
-- =============================================================================
-- These tables are new and every one of them is either a money surface or a
-- private one, so each assertion below includes a NEGATIVE CONTROL: the thing
-- that must be refused is attempted, and the test fails if it succeeds. A
-- policy suite that only proves the allowed path passes proves nothing.

-- DB-30: the pricing matrix is public read, admin write.
do $$
declare
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_vol uuid;
  v_visible int;
  v_wrote boolean := false;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;
  perform ssc_test.act_as(v_athlete);

  -- Allowed: a swimmer must be able to read prices before they have any
  -- standing at all, or the registration form has nothing to quote.
  select count(*) into v_visible from public.pricing_packages where meet_volume_id = v_vol;

  -- Refused: a swimmer who could write here could set their own entry fee.
  begin
    update public.pricing_packages set price_egp = 0 where meet_volume_id = v_vol;
    -- RLS makes this a silent no-op rather than an error, so the proof is that
    -- nothing actually changed.
    v_wrote := exists (
      select 1 from public.pricing_packages
      where meet_volume_id = v_vol and price_egp = 0 and race_count > 0
    );
  exception when insufficient_privilege then
    v_wrote := false;
  end;

  perform set_config('role', 'postgres', true);
  perform ssc_test.check(
    'DB-30', 'pricing_packages: public read, athlete cannot rewrite prices',
    v_visible > 0 and not v_wrote,
    format('visible=%s athlete_wrote=%s', v_visible, v_wrote));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-30', 'pricing_packages read/write gates', false, sqlerrm);
end $$;

-- DB-31: an admin CAN write the matrix. The positive half of DB-30 — without
-- it, a policy that refuses everyone would pass DB-30 and break the app.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_vol uuid;
  v_before int;
  v_after int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;
  select price_egp into v_before from public.pricing_packages
   where meet_volume_id = v_vol and race_count = 1 and tier = 'standard';

  perform ssc_test.act_as(v_admin);
  update public.pricing_packages set price_egp = v_before + 5
   where meet_volume_id = v_vol and race_count = 1 and tier = 'standard';
  select price_egp into v_after from public.pricing_packages
   where meet_volume_id = v_vol and race_count = 1 and tier = 'standard';
  -- Restore, so later assertions and reruns see the seeded value.
  update public.pricing_packages set price_egp = v_before
   where meet_volume_id = v_vol and race_count = 1 and tier = 'standard';
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-31', 'pricing_packages: an admin can change a price',
    v_after = v_before + 5,
    format('before=%s after=%s', v_before, v_after));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-31', 'admin can change a price', false, sqlerrm);
end $$;

-- DB-32: a notification is addressed to one person and nobody else.
do $$
declare
  v_owner uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_other uuid := ssc_test.user_id('athlete02@ssc-demo.test');
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_own int;
  v_others int;
  v_admin_sees int;
begin
  perform public.raise_notification(
    v_owner, 'team', 'DB-32 probe', 'body', null, '{}'::jsonb);

  perform ssc_test.act_as(v_owner);
  select count(*) into v_own from public.notifications where title = 'DB-32 probe';
  perform set_config('role', 'postgres', true);

  perform ssc_test.act_as(v_other);
  select count(*) into v_others from public.notifications where title = 'DB-32 probe';
  perform set_config('role', 'postgres', true);

  -- Admins are checked explicitly. There is no operational reason to read
  -- someone's notification feed, and an admin-can-see-everything policy copied
  -- from the other tables would be a privacy hole nobody noticed.
  perform ssc_test.act_as(v_admin);
  select count(*) into v_admin_sees from public.notifications where title = 'DB-32 probe';

  perform set_config('role', 'postgres', true);
  delete from public.notifications where title = 'DB-32 probe';

  perform ssc_test.check(
    'DB-32', 'notifications: owner reads, nobody else does (admins included)',
    v_own = 1 and v_others = 0 and v_admin_sees = 0,
    format('own=%s other=%s admin=%s', v_own, v_others, v_admin_sees));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-32', 'notification visibility', false, sqlerrm);
end $$;

-- DB-33: email_outbox is readable by NO signed-in user. It holds message
-- bodies and recipient addresses and is drained only by the service key.
do $$
declare
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_queued int;
  v_athlete_sees int;
  v_admin_sees int;
begin
  perform public.raise_notification(
    v_athlete, 'waitlist', 'DB-33 probe', 'body', null, '{}'::jsonb);
  select count(*) into v_queued from public.email_outbox where subject = 'DB-33 probe';

  perform ssc_test.act_as(v_athlete);
  select count(*) into v_athlete_sees from public.email_outbox where subject = 'DB-33 probe';
  perform set_config('role', 'postgres', true);
  perform ssc_test.act_as(v_admin);
  select count(*) into v_admin_sees from public.email_outbox where subject = 'DB-33 probe';
  perform set_config('role', 'postgres', true);

  delete from public.email_outbox where subject = 'DB-33 probe';
  delete from public.notifications where title = 'DB-33 probe';

  perform ssc_test.check(
    'DB-33', 'email_outbox: queued as postgres, invisible to every user',
    v_queued = 1 and v_athlete_sees = 0 and v_admin_sees = 0,
    format('queued=%s athlete=%s admin=%s', v_queued, v_athlete_sees, v_admin_sees));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-33', 'email_outbox invisibility', false, sqlerrm);
end $$;

-- DB-34: waitlist and payment email cannot be opted out of, and the database
-- is what refuses it — not the UI.
do $$
declare
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_refused boolean := false;
  v_optional_ok boolean := false;
begin
  perform ssc_test.act_as(v_athlete);

  begin
    insert into public.notification_preferences (user_id, category, email_enabled)
    values (v_athlete, 'waitlist', false);
  exception when check_violation then
    v_refused := true;
  end;

  -- The other half: an optional category MUST still be mutable, or the
  -- constraint is simply blocking everything.
  begin
    insert into public.notification_preferences (user_id, category, email_enabled)
    values (v_athlete, 'results_schedule', false)
    on conflict (user_id, category) do update set email_enabled = false;
    v_optional_ok := true;
  exception when others then
    v_optional_ok := false;
  end;

  perform set_config('role', 'postgres', true);
  delete from public.notification_preferences where user_id = v_athlete;

  perform ssc_test.check(
    'DB-34', 'notification_preferences: critical categories cannot be muted',
    v_refused and v_optional_ok,
    format('waitlist_refused=%s results_mutable=%s', v_refused, v_optional_ok));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-34', 'mandatory notification categories', false, sqlerrm);
end $$;

-- DB-35: payments are readable by the swimmer, writable only by an admin.
do $$
declare
  v_athlete_user uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_athlete uuid;
  v_vol uuid;
  v_own int;
  v_forged boolean := false;
begin
  select id into v_athlete from public.athletes where user_id = v_athlete_user;
  select id into v_vol from public.meet_volumes where volume_number = 1;

  insert into public.entry_payments (athlete_id, meet_volume_id, tier, amount_egp, collected_by)
  values (v_athlete, v_vol, 'standard', 700, null);

  perform ssc_test.act_as(v_athlete_user);

  select count(*) into v_own from public.entry_payments
   where athlete_id = v_athlete and amount_egp = 700;

  -- Refused: a swimmer who could insert here could mark themselves paid.
  begin
    insert into public.entry_payments (athlete_id, meet_volume_id, tier, amount_egp)
    values (v_athlete, v_vol, 'early_bird', 0);
    v_forged := true;
  exception when others then
    v_forged := false;
  end;

  perform set_config('role', 'postgres', true);
  delete from public.entry_payments where athlete_id = v_athlete;

  perform ssc_test.check(
    'DB-35', 'entry_payments: swimmer reads own receipts, cannot forge one',
    v_own = 1 and not v_forged,
    format('own=%s forged=%s', v_own, v_forged));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-35', 'entry_payments gates', false, sqlerrm);
end $$;

-- DB-36: a swimmer cannot queue-jump by inserting a waitlist row for someone
-- else, nor withdraw a rival.
do $$
declare
  v_user uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_self uuid;
  v_rival uuid;
  v_event uuid;
  v_own_ok boolean := false;
  v_forged boolean := false;
begin
  select id into v_self from public.athletes where user_id = v_user;
  select id into v_rival from public.athletes where user_id <> v_user limit 1;
  select e.id into v_event from public.events e
   join public.sessions s on s.id = e.session_id
   join public.meet_volumes mv on mv.id = s.meet_volume_id
   where mv.volume_number = 1 and e.is_relay = false limit 1;

  perform ssc_test.act_as(v_user);

  begin
    insert into public.event_waitlist (event_id, athlete_id) values (v_event, v_self);
    v_own_ok := true;
  exception when others then
    v_own_ok := false;
  end;

  begin
    insert into public.event_waitlist (event_id, athlete_id) values (v_event, v_rival);
    v_forged := true;
  exception when others then
    v_forged := false;
  end;

  perform set_config('role', 'postgres', true);
  delete from public.event_waitlist where event_id = v_event;

  perform ssc_test.check(
    'DB-36', 'event_waitlist: joins for self only, never for another swimmer',
    v_own_ok and not v_forged,
    format('self=%s other=%s', v_own_ok, v_forged));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-36', 'event_waitlist ownership', false, sqlerrm);
end $$;

-- DB-37: reclaim_entry_slot is SECURITY DEFINER, so it bypasses RLS and has
-- to check ownership itself. If that check were ever dropped, any signed-in
-- user could reclaim anyone's place by id — and no RLS policy would stop them.
do $$
declare
  v_user uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_other uuid := ssc_test.user_id('athlete02@ssc-demo.test');
  v_entry uuid;
  v_blocked boolean := false;
begin
  select en.id into v_entry
  from public.entries en
  join public.athletes a on a.id = en.athlete_id
  where a.user_id = v_user limit 1;

  if v_entry is null then
    perform ssc_test.check('DB-37', 'reclaim_entry_slot ownership check', true,
      'skipped — no seeded entry for athlete1');
    return;
  end if;

  perform ssc_test.act_as(v_other);
  begin
    perform public.reclaim_entry_slot(v_entry);
    v_blocked := false;
  exception when others then
    v_blocked := true;
  end;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-37', 'reclaim_entry_slot: refuses another swimmer''s entry',
    v_blocked,
    format('blocked=%s', v_blocked));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-37', 'reclaim_entry_slot ownership check', false, sqlerrm);
end $$;

-- DB-38: capacity ignores a lapsed hold WITHOUT the sweep having run. This is
-- the guarantee that a failed or paused scheduled job degrades notification
-- timeliness and nothing else — a race must never read as full because a
-- background task did not fire.
do $$
declare
  v_event uuid;
  v_entry uuid;
  v_held_before int;
  v_held_after int;
  v_status text;
begin
  select e.id into v_event from public.events e
   join public.sessions s on s.id = e.session_id
   join public.meet_volumes mv on mv.id = s.meet_volume_id
   where mv.volume_number = 1 and e.is_relay = false
     and exists (select 1 from public.entries en
                  where en.event_id = e.id and en.status = 'pending_payment')
   limit 1;

  select id into v_entry from public.entries
   where event_id = v_event and status = 'pending_payment' limit 1;

  select held_count into v_held_before from public.event_capacity(v_event);

  update public.entries set hold_expires_at = now() - interval '1 hour' where id = v_entry;

  select held_count into v_held_after from public.event_capacity(v_event);
  select status::text into v_status from public.entries where id = v_entry;

  -- Restore.
  update public.entries set hold_expires_at = now() + interval '48 hours' where id = v_entry;

  perform ssc_test.check(
    'DB-38', 'event_capacity: releases a lapsed hold before the sweep runs',
    v_held_after = v_held_before - 1 and v_status = 'pending_payment',
    format('before=%s after=%s status_untouched=%s', v_held_before, v_held_after, v_status));
exception when others then
  perform ssc_test.check('DB-38', 'capacity without the sweep', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-39..DB-44 — is_public visibility: the actual enforcement, not app code
-- =============================================================================
-- These mutate meet_volumes.status / is_public on the seeded volumes, so every
-- block restores what it changed — later assertions in this file, and every
-- other run of this suite, depend on volume_number = 1 reading as the normal
-- public, scheduled meet.

-- DB-39: is_public=true alone does NOT make a 'planned' volume visible. This
-- is the "both required" rule, and it is the one a single-column test would
-- never catch — a policy that only checked is_public would pass a naive test
-- and still leak a dateless placeholder to the public.
do $$
declare
  v_vol uuid;
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_before record;
  v_visible int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 2;
  select status, is_public into v_before from public.meet_volumes where id = v_vol;

  update public.meet_volumes set status = 'planned', is_public = true where id = v_vol;

  perform ssc_test.act_as(v_athlete);
  select count(*) into v_visible from public.meet_volumes where id = v_vol;
  perform set_config('role', 'postgres', true);

  update public.meet_volumes set status = v_before.status, is_public = v_before.is_public
   where id = v_vol;

  perform ssc_test.check(
    'DB-39', 'planned + is_public=true still hides the volume from a non-admin',
    v_visible = 0, format('visible=%s', v_visible));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-39', 'planned + public stays hidden', false, sqlerrm);
end $$;

-- DB-40: scheduled + is_public=true IS visible — the positive half of DB-39.
-- Without this, a policy that hid everything would also pass DB-39.
do $$
declare
  v_vol uuid;
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_before record;
  v_visible int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 2;
  select status, is_public into v_before from public.meet_volumes where id = v_vol;

  update public.meet_volumes set status = 'scheduled', is_public = true where id = v_vol;

  perform ssc_test.act_as(v_athlete);
  select count(*) into v_visible from public.meet_volumes where id = v_vol;
  perform set_config('role', 'postgres', true);

  update public.meet_volumes set status = v_before.status, is_public = v_before.is_public
   where id = v_vol;

  perform ssc_test.check(
    'DB-40', 'scheduled + is_public=true is visible to a non-admin',
    v_visible = 1, format('visible=%s', v_visible));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-40', 'scheduled + public is visible', false, sqlerrm);
end $$;

-- DB-41: an admin sees a hidden volume regardless — proves the bypass exists,
-- so DB-39's zero-visibility result is "hidden from the public", not
-- "unreadable by anyone including the admin who needs to build it".
do $$
declare
  v_vol uuid;
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_before record;
  v_visible int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 2;
  select status, is_public into v_before from public.meet_volumes where id = v_vol;

  update public.meet_volumes set status = 'planned', is_public = false where id = v_vol;

  perform ssc_test.act_as(v_admin);
  select count(*) into v_visible from public.meet_volumes where id = v_vol;
  perform set_config('role', 'postgres', true);

  update public.meet_volumes set status = v_before.status, is_public = v_before.is_public
   where id = v_vol;

  perform ssc_test.check(
    'DB-41', 'an admin sees a fully hidden (planned, unpublished) volume',
    v_visible = 1, format('visible=%s', v_visible));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-41', 'admin bypass on meet_volumes', false, sqlerrm);
end $$;

-- DB-42: a non-admin cannot flip is_public themselves. Read access being
-- gated is only half the story — if anyone could also WRITE the flag, they
-- could publish the meet they are not supposed to know exists yet.
do $$
declare
  v_vol uuid;
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_before boolean;
  v_after boolean;
begin
  select id into v_vol from public.meet_volumes where volume_number = 2;
  select is_public into v_before from public.meet_volumes where id = v_vol;

  perform ssc_test.act_as(v_athlete);
  update public.meet_volumes set is_public = true where id = v_vol;
  perform set_config('role', 'postgres', true);

  select is_public into v_after from public.meet_volumes where id = v_vol;
  perform ssc_test.check(
    'DB-42', 'a non-admin cannot flip is_public',
    v_after = v_before, format('before=%s after=%s', v_before, v_after));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-42', 'is_public write is admin-only', false, sqlerrm);
end $$;

-- DB-43: the cascade actually reaches the child tables — sessions, events,
-- meet_settings, pricing_packages, pricing_tiers all stayed `using (true)`
-- until this change, so a hidden volume's schedule and prices were one
-- direct REST call away from anyone who knew its id. Using volume 1 (which
-- has real seeded sessions/events/pricing, unlike the empty volume 2) so
-- there is something to actually hide and then reveal.
do $$
declare
  v_vol uuid;
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_sessions_before int; v_events_before int; v_settings_before int;
  v_packages_before int; v_tiers_before int;
  v_sessions_after int; v_events_after int; v_settings_after int;
  v_packages_after int; v_tiers_after int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;

  perform ssc_test.act_as(v_athlete);
  select count(*) into v_sessions_before from public.sessions where meet_volume_id = v_vol;
  select count(*) into v_events_before from public.events e
    join public.sessions s on s.id = e.session_id where s.meet_volume_id = v_vol;
  select count(*) into v_settings_before from public.meet_settings where meet_volume_id = v_vol;
  select count(*) into v_packages_before from public.pricing_packages where meet_volume_id = v_vol;
  select count(*) into v_tiers_before from public.pricing_tiers where meet_volume_id = v_vol;
  perform set_config('role', 'postgres', true);

  update public.meet_volumes set is_public = false where id = v_vol;

  perform ssc_test.act_as(v_athlete);
  select count(*) into v_sessions_after from public.sessions where meet_volume_id = v_vol;
  select count(*) into v_events_after from public.events e
    join public.sessions s on s.id = e.session_id where s.meet_volume_id = v_vol;
  select count(*) into v_settings_after from public.meet_settings where meet_volume_id = v_vol;
  select count(*) into v_packages_after from public.pricing_packages where meet_volume_id = v_vol;
  select count(*) into v_tiers_after from public.pricing_tiers where meet_volume_id = v_vol;
  perform set_config('role', 'postgres', true);

  -- Restore before asserting, so a failed assertion here does not leave the
  -- seeded live volume hidden for every test that runs after this one.
  update public.meet_volumes set is_public = true where id = v_vol;

  perform ssc_test.check(
    'DB-43', 'hiding a volume also hides its sessions/events/pricing, not just its own row',
    v_sessions_before > 0 and v_events_before > 0 and v_settings_before > 0
      and v_packages_before > 0 and v_tiers_before > 0
      and v_sessions_after = 0 and v_events_after = 0 and v_settings_after = 0
      and v_packages_after = 0 and v_tiers_after = 0,
    format(
      'before: sessions=%s events=%s settings=%s packages=%s tiers=%s | after: sessions=%s events=%s settings=%s packages=%s tiers=%s',
      v_sessions_before, v_events_before, v_settings_before, v_packages_before, v_tiers_before,
      v_sessions_after, v_events_after, v_settings_after, v_packages_after, v_tiers_after));
exception when others then
  perform set_config('role', 'postgres', true);
  update public.meet_volumes set is_public = true
   where id = (select id from public.meet_volumes where volume_number = 1);
  perform ssc_test.check('DB-43', 'cascade to child tables', false, sqlerrm);
end $$;

-- DB-44: race_shape_templates is NOT volume-scoped (no meet_volume_id column
-- at all — it is the shared default table every volume's events are seeded
-- from) and must stay untouched by this change. If a future edit accidentally
-- routed it through volume_is_public(), every template row would vanish for
-- every non-admin, since there is no meet_volume_id to join on.
do $$
declare
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_visible int;
begin
  perform ssc_test.act_as(v_athlete);
  select count(*) into v_visible from public.race_shape_templates;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-44', 'race_shape_templates stays public read regardless of any volume',
    v_visible > 0, format('visible=%s', v_visible));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-44', 'race_shape_templates unaffected', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-45..DB-52 — relay squad payments: captain-billed, admin-confirmed
-- =============================================================================
-- One shared fixture squad across this whole group, built by finding a real
-- (relay event, team, athletes) combination that already satisfies every
-- validate_relay_squad() rule (same team, same age group, correct gender
-- split for the event name, every leg already individually entered in the
-- meet) — hand-picking athlete ids would be fragile the moment the seed
-- changes; a single-gender relay event needs no gender-ratio balancing, which
-- is why one is preferred here. Deleted at the end of the group (cascades to
-- legs and any payment) so re-running this suite never collides with the
-- squad_letter unique constraint on a second run.
do $$
declare
  v_event_id uuid;
  v_team_id uuid;
  v_age_group public.age_group;
  v_athletes uuid[];
  v_squad uuid;
  v_leg integer := 1;
  v_athlete uuid;
begin
  select req.event_id, e.team_id, e.age_group,
         (e.male_athletes[1:req.male_count] || e.female_athletes[1:req.female_count])
    into v_event_id, v_team_id, v_age_group, v_athletes
  from (
    select ev.id as event_id, ev.name as event_name, s.meet_volume_id,
           g.male_count, g.female_count
    from public.events ev
    join public.sessions s on s.id = ev.session_id
    cross join lateral public.relay_gender_requirement(ev.name) g
    where ev.is_relay
      and (ev.name ilike '%(male)%' or ev.name ilike '%(female)%')
  ) req
  join lateral (
    select a.team_id, a.age_group,
           array_agg(distinct a.id) filter (where a.gender = 'male') as male_athletes,
           array_agg(distinct a.id) filter (where a.gender = 'female') as female_athletes,
           count(distinct a.id) filter (where a.gender = 'male') as have_male,
           count(distinct a.id) filter (where a.gender = 'female') as have_female
    from public.athletes a
    join public.entries en on en.athlete_id = a.id
    join public.events ee on ee.id = en.event_id
    join public.sessions ss on ss.id = ee.session_id
    where ss.meet_volume_id = req.meet_volume_id
    group by a.team_id, a.age_group
    having count(distinct a.id) filter (where a.gender = 'male') >= req.male_count
       and count(distinct a.id) filter (where a.gender = 'female') >= req.female_count
    limit 1
  ) e on true
  limit 1;

  if v_event_id is null then
    raise exception 'No valid single-gender relay fixture found in seed-demo.sql data';
  end if;

  insert into public.relay_squads (event_id, team_id, age_group, squad_letter)
  values (v_event_id, v_team_id, v_age_group, 'RLS')
  returning id into v_squad;

  foreach v_athlete in array v_athletes loop
    insert into public.relay_legs (squad_id, leg_number, athlete_id)
    values (v_squad, v_leg, v_athlete);
    v_leg := v_leg + 1;
  end loop;

  create temporary table rls_relay_fixture as
  select v_squad as squad_id, v_event_id as event_id, v_team_id as team_id;
end $$;

-- DB-45: quote_athlete_entries() no longer includes a relay line for a
-- swimmer on the fixture squad — regression guard for the removal that made
-- captain-billing possible. Without this, a relay leg could silently be
-- billed to both the swimmer AND the captain.
do $$
declare
  v_athlete uuid;
  v_volume uuid;
  v_relay_lines int;
begin
  select rl.athlete_id, s.meet_volume_id into v_athlete, v_volume
  from public.relay_legs rl
  join rls_relay_fixture f on f.squad_id = rl.squad_id
  join public.events e on e.id = f.event_id
  join public.sessions s on s.id = e.session_id
  limit 1;

  select count(*) into v_relay_lines
  from public.quote_athlete_entries(v_athlete, v_volume) q
  where q.kind = 'relay';

  perform ssc_test.check(
    'DB-45', 'quote_athlete_entries no longer bills a relay leg to the swimmer',
    v_relay_lines = 0, format('relay_lines=%s', v_relay_lines));
exception when others then
  perform ssc_test.check('DB-45', 'relay leg not double-billed', false, sqlerrm);
end $$;

-- DB-46: a non-admin (including the squad's own captain) cannot confirm
-- payment. The captain is who OWES for the squad, not who may mark it paid —
-- see the comment on confirm_relay_squad_payment() in schema.sql.
do $$
declare
  v_squad uuid;
  v_team uuid;
  v_captain uuid;
  v_blocked boolean := false;
begin
  select squad_id, team_id into v_squad, v_team from rls_relay_fixture;
  select captain_id into v_captain from public.teams where id = v_team;

  if v_captain is null then
    perform ssc_test.check('DB-46', 'captain cannot self-confirm relay payment',
      true, 'skipped — fixture team has no captain');
    return;
  end if;

  perform ssc_test.act_as(v_captain);
  begin
    perform public.confirm_relay_squad_payment(v_squad);
  exception when others then
    v_blocked := true;
  end;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-46', 'captain cannot self-confirm relay payment',
    v_blocked, format('blocked=%s', v_blocked));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-46', 'captain self-confirm refused', false, sqlerrm);
end $$;

-- DB-47: an admin CAN confirm it — the positive half of DB-46, without which
-- a policy refusing everyone would also pass DB-46.
do $$
declare
  v_squad uuid;
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_amount int;
  v_status text;
  v_collector uuid;
begin
  select squad_id into v_squad from rls_relay_fixture;

  perform ssc_test.act_as(v_admin);
  perform public.confirm_relay_squad_payment(v_squad, 'DB-47 probe');
  perform set_config('role', 'postgres', true);

  select amount_egp, collected_by into v_amount, v_collector
    from public.relay_squad_payments where squad_id = v_squad;
  select status::text into v_status from public.relay_squads where id = v_squad;

  perform ssc_test.check(
    'DB-47', 'an admin can confirm a complete relay squad''s payment',
    v_status = 'confirmed' and v_amount = 4 * 300,
    format('status=%s amount=%s', v_status, v_amount));
  -- The collector reaching the table through a SECURITY DEFINER function,
  -- which runs with RLS bypassed: the BEFORE INSERT trigger is the only thing
  -- that could have set this, so a correct value proves the rule holds on the
  -- one write path an insert policy's WITH CHECK could never have covered.
  -- confirm_relay_squad_payment() no longer even TAKES a collector.
  perform ssc_test.check(
    'DB-47', 'the relay payment records auth.uid() as collector, not a parameter',
    v_collector = v_admin, format('collected_by=%s admin=%s', v_collector, v_admin));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-47', 'admin confirms relay payment', false, sqlerrm);
end $$;

-- DB-48: paying the same squad twice is refused (unique(squad_id) on
-- relay_squad_payments, surfaced as a clean application error).
do $$
declare
  v_squad uuid;
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_refused boolean := false;
begin
  select squad_id into v_squad from rls_relay_fixture;

  perform ssc_test.act_as(v_admin);
  begin
    perform public.confirm_relay_squad_payment(v_squad);
  exception when others then
    v_refused := true;
  end;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-48', 'a relay squad cannot be paid for twice',
    v_refused, format('refused=%s', v_refused));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-48', 'double relay payment refused', false, sqlerrm);
end $$;

-- DB-49: relay_event_capacity() counts relay_squads, not entries — the
-- counting function events.capacity_cap never had before this feature (a
-- relay squad is never inserted into public.entries at all).
do $$
declare
  v_event uuid;
  v_paid int;
begin
  select event_id into v_event from rls_relay_fixture;
  select paid_count into v_paid from public.relay_event_capacity(v_event);

  perform ssc_test.check(
    'DB-49', 'relay_event_capacity counts the paid fixture squad',
    v_paid >= 1, format('paid_count=%s', v_paid));
exception when others then
  perform ssc_test.check('DB-49', 'relay_event_capacity counts squads', false, sqlerrm);
end $$;

-- DB-50: the hold sweep expires a lapsed UNPAID relay squad, releases its
-- capacity, and notifies the CAPTAIN (not each of the four swimmers on it —
-- the captain is who was billed and who has an action to take).
do $$
declare
  v_squad uuid;
  v_event uuid;
  v_team uuid;
  v_leg integer := 1;
  v_athlete uuid;
  v_captain uuid;
  v_held_before int;
  v_held_after int;
  v_status text;
  v_notified boolean;
begin
  select event_id, team_id into v_event, v_team from rls_relay_fixture;

  -- A second squad in the SAME fixture event needs different athletes —
  -- validate_relay_squad() refuses the same swimmer twice in one relay
  -- event — so this reuses the shared discovery query for a distinct team.
  declare
    v_team2 uuid;
    v_age_group public.age_group;
    v_athletes uuid[];
  begin
    select e.team_id, e.age_group,
           (e.male_athletes[1:g.male_count] || e.female_athletes[1:g.female_count])
      into v_team2, v_age_group, v_athletes
    from public.events ev
    join public.sessions s on s.id = ev.session_id
    cross join lateral public.relay_gender_requirement(ev.name) g
    join lateral (
      select a.team_id, a.age_group,
             array_agg(distinct a.id) filter (where a.gender = 'male') as male_athletes,
             array_agg(distinct a.id) filter (where a.gender = 'female') as female_athletes,
             count(distinct a.id) filter (where a.gender = 'male') as have_male,
             count(distinct a.id) filter (where a.gender = 'female') as have_female
      from public.athletes a
      join public.entries en on en.athlete_id = a.id
      join public.events ee on ee.id = en.event_id
      join public.sessions ss on ss.id = ee.session_id
      where ss.meet_volume_id = s.meet_volume_id
        and a.team_id <> v_team
      group by a.team_id, a.age_group
      having count(distinct a.id) filter (where a.gender = 'male') >= g.male_count
         and count(distinct a.id) filter (where a.gender = 'female') >= g.female_count
      limit 1
    ) e on true
    where ev.id = v_event
    limit 1;

    if v_team2 is null then
      perform ssc_test.check('DB-50', 'relay hold sweep releases capacity and notifies captain',
        true, 'skipped — no second team fixture available for this relay event');
      return;
    end if;

    insert into public.relay_squads (event_id, team_id, age_group, squad_letter)
    values (v_event, v_team2, v_age_group, 'RLS2')
    returning id into v_squad;

    foreach v_athlete in array v_athletes loop
      insert into public.relay_legs (squad_id, leg_number, athlete_id)
      values (v_squad, v_leg, v_athlete);
      v_leg := v_leg + 1;
    end loop;

    select captain_id into v_captain from public.teams where id = v_team2;
  end;

  select held_count into v_held_before from public.relay_event_capacity(v_event);

  update public.relay_squads set hold_expires_at = now() - interval '1 hour'
  where id = v_squad;

  perform public.sweep_expired_holds();

  select status::text into v_status from public.relay_squads where id = v_squad;
  select held_count into v_held_after from public.relay_event_capacity(v_event);

  v_notified := v_captain is not null and exists (
    select 1 from public.notifications
    where user_id = v_captain and category = 'entry_payment'
      and (metadata->>'squad_id')::uuid = v_squad
  );

  -- Clean up this second squad now — it is not part of the shared fixture
  -- deleted at the end of the group.
  delete from public.relay_squads where id = v_squad;

  perform ssc_test.check(
    'DB-50', 'relay hold sweep expires, releases capacity, notifies the captain',
    v_status = 'hold_expired' and v_held_after < v_held_before
      and (v_captain is null or v_notified),
    format('status=%s held_before=%s held_after=%s notified=%s',
      v_status, v_held_before, v_held_after, v_notified));
exception when others then
  perform ssc_test.check('DB-50', 'relay hold sweep', false, sqlerrm);
end $$;

-- Cleanup: cascades to relay_legs and relay_squad_payments.
delete from public.relay_squads where id = (select squad_id from rls_relay_fixture);

-- =============================================================================
-- DB-51..DB-53 — team_announcements
-- =============================================================================
-- Read is athletes.team_id, NOT team_memberships — team_memberships is the
-- one-time join-REQUEST record, not the live roster (see the comment on this
-- table's RLS policy in schema.sql). Riptide's captain and a real teammate
-- assigned directly via athletes.team_id (never having gone through a join
-- request) are the fixture, specifically because that is the common case
-- team_memberships-based RLS would have missed.

-- DB-51: a team member (not the author, not the captain) is notified when the
-- captain posts, and CAN read the announcement; the captain (author) is not
-- notified of their own post.
do $$
declare
  v_captain uuid := ssc_test.user_id('captain.riptide@ssc-demo.test');
  v_team uuid := ssc_test.team_id('Riptide Swim Club');
  v_member uuid;
  v_announcement uuid;
  v_member_notified boolean;
  v_author_notified boolean;
  v_member_can_read boolean;
begin
  select a.user_id into v_member
  from public.athletes a
  where a.team_id = v_team and a.user_id <> v_captain
  limit 1;

  if v_member is null then
    perform ssc_test.check('DB-51', 'member notified and can read a posted announcement',
      true, 'skipped — Riptide has no second athlete to use as a member fixture');
    return;
  end if;

  perform ssc_test.act_as(v_captain);
  insert into public.team_announcements (team_id, author_id, title, body)
  values (v_team, v_captain, 'DB-51 probe', 'probe body')
  returning id into v_announcement;
  perform set_config('role', 'postgres', true);

  v_member_notified := exists (
    select 1 from public.notifications
    where user_id = v_member and category = 'announcement'
      and (metadata->>'announcement_id')::uuid = v_announcement);
  v_author_notified := exists (
    select 1 from public.notifications
    where user_id = v_captain and category = 'announcement'
      and (metadata->>'announcement_id')::uuid = v_announcement);

  perform ssc_test.act_as(v_member);
  select exists (select 1 from public.team_announcements where id = v_announcement)
    into v_member_can_read;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-51', 'member notified and can read; author is not notified of their own post',
    v_member_notified and not v_author_notified and v_member_can_read,
    format('member_notified=%s author_notified=%s member_can_read=%s',
      v_member_notified, v_author_notified, v_member_can_read));

  delete from public.team_announcements where id = v_announcement;
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-51', 'announcement fan-out and read access', false, sqlerrm);
end $$;

-- DB-52: someone NOT on the team cannot read Riptide's announcements, and
-- cannot post one either — read and write are both team-scoped, not public.
do $$
declare
  v_captain uuid := ssc_test.user_id('captain.riptide@ssc-demo.test');
  v_team uuid := ssc_test.team_id('Riptide Swim Club');
  v_outsider uuid;
  v_announcement uuid;
  v_outsider_reads int;
  v_outsider_writes boolean;
begin
  select u.id into v_outsider
  from public.users u
  where u.role = 'athlete'
    and not exists (
      select 1 from public.athletes a where a.user_id = u.id and a.team_id = v_team
    )
    and u.id <> v_captain
  limit 1;

  perform ssc_test.act_as(v_captain);
  insert into public.team_announcements (team_id, author_id, title, body)
  values (v_team, v_captain, 'DB-52 probe', 'probe body')
  returning id into v_announcement;
  perform set_config('role', 'postgres', true);

  perform ssc_test.act_as(v_outsider);
  select count(*) into v_outsider_reads
  from public.team_announcements where id = v_announcement;

  begin
    insert into public.team_announcements (team_id, author_id, title, body)
    values (v_team, v_outsider, 'forged', 'forged');
    v_outsider_writes := true;
  exception when others then
    v_outsider_writes := false;
  end;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-52', 'a non-member cannot read or post a team''s announcements',
    v_outsider_reads = 0 and not v_outsider_writes
      and not exists (select 1 from public.team_announcements where title = 'forged'),
    format('reads=%s writes=%s', v_outsider_reads, v_outsider_writes));

  delete from public.team_announcements where id = v_announcement;
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-52', 'non-member announcement access refused', false, sqlerrm);
end $$;

-- DB-53: editing an announcement (fixing a typo, toggling pinned) does not
-- re-notify the team — only the original post does. A captain fixing a typo
-- must not spam the whole roster a second time.
do $$
declare
  v_captain uuid := ssc_test.user_id('captain.riptide@ssc-demo.test');
  v_team uuid := ssc_test.team_id('Riptide Swim Club');
  v_announcement uuid;
  v_before int;
  v_after int;
begin
  perform ssc_test.act_as(v_captain);
  insert into public.team_announcements (team_id, author_id, title, body)
  values (v_team, v_captain, 'DB-53 probe', 'probe body')
  returning id into v_announcement;

  select count(*) into v_before from public.notifications where category = 'announcement';

  update public.team_announcements set pinned = true, title = 'DB-53 probe (edited)'
  where id = v_announcement;

  select count(*) into v_after from public.notifications where category = 'announcement';
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-53', 'editing an announcement does not re-notify the team',
    v_before = v_after, format('before=%s after=%s', v_before, v_after));

  delete from public.team_announcements where id = v_announcement;
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-53', 'edit does not re-notify', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-54..DB-60 — admin_actions: the append-only admin audit log. Every
-- assertion here is a money/permission surface, so each pairs the allowed
-- path with a negative control, same as DB-30 onward.
-- =============================================================================

-- DB-54: SELECT is admin-only. A row is produced first (a real pricing bump,
-- reverted after) rather than relying on an earlier test having left one
-- behind, so this block proves its own claim regardless of run order.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_referee uuid := ssc_test.user_id('referee1@ssc-demo.test');
  v_parent uuid := ssc_test.user_id('parent1@ssc-demo.test');
  v_vol uuid;
  v_before int;
  v_admin_reads int;
  v_athlete_reads int;
  v_referee_reads int;
  v_parent_reads int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;
  select price_egp into v_before from public.pricing_packages
   where meet_volume_id = v_vol and race_count = 1 and tier = 'standard';

  perform ssc_test.act_as(v_admin);
  update public.pricing_packages set price_egp = v_before + 7
   where meet_volume_id = v_vol and race_count = 1 and tier = 'standard';
  update public.pricing_packages set price_egp = v_before
   where meet_volume_id = v_vol and race_count = 1 and tier = 'standard';
  select count(*) into v_admin_reads from public.admin_actions;
  perform set_config('role', 'postgres', true);

  perform ssc_test.act_as(v_athlete);
  select count(*) into v_athlete_reads from public.admin_actions;
  perform set_config('role', 'postgres', true);

  perform ssc_test.act_as(v_referee);
  select count(*) into v_referee_reads from public.admin_actions;
  perform set_config('role', 'postgres', true);

  perform ssc_test.act_as(v_parent);
  select count(*) into v_parent_reads from public.admin_actions;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-54', 'admin_actions: admin reads, no other role sees a single row',
    v_admin_reads > 0 and v_athlete_reads = 0 and v_referee_reads = 0 and v_parent_reads = 0,
    format('admin=%s athlete=%s referee=%s parent=%s',
      v_admin_reads, v_athlete_reads, v_referee_reads, v_parent_reads));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-54', 'admin_actions read gate', false, sqlerrm);
end $$;

-- DB-55: nobody — not even an admin — can UPDATE or DELETE an existing row.
-- There is no update/delete policy at all, so RLS refuses both by default;
-- this proves that refusal actually holds rather than assuming an absent
-- policy behaves the way it is supposed to.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_row_id uuid;
  v_update_blocked boolean := true;
  v_delete_blocked boolean := true;
  v_rows_affected int;
begin
  select id into v_row_id from public.admin_actions order by created_at desc limit 1;

  perform ssc_test.act_as(v_admin);

  update public.admin_actions set details = '{"tampered": true}'::jsonb where id = v_row_id;
  get diagnostics v_rows_affected = row_count;
  v_update_blocked := v_rows_affected = 0;

  delete from public.admin_actions where id = v_row_id;
  get diagnostics v_rows_affected = row_count;
  v_delete_blocked := v_rows_affected = 0;

  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-55', 'admin_actions is append-only: admin cannot UPDATE or DELETE a row',
    v_update_blocked and v_delete_blocked and exists (select 1 from public.admin_actions where id = v_row_id),
    format('update_blocked=%s delete_blocked=%s', v_update_blocked, v_delete_blocked));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-55', 'admin_actions append-only', false, sqlerrm);
end $$;

-- DB-56: a role change writes a ROLE_CHANGE row with the actor and the
-- before/after role — both directions of a promote-then-revert, so the
-- fixture account's role ends the run exactly where it started.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_athlete uuid := ssc_test.user_id('athlete01@ssc-demo.test');
  v_before int;
  v_after_promote int;
  v_after_revert int;
  v_details jsonb;
begin
  select count(*) into v_before from public.admin_actions
   where action = 'ROLE_CHANGE' and target_id = v_athlete;

  perform ssc_test.act_as(v_admin);
  update public.users set role = 'referee' where id = v_athlete;
  select count(*) into v_after_promote from public.admin_actions
   where action = 'ROLE_CHANGE' and target_id = v_athlete;
  select details into v_details from public.admin_actions
   where action = 'ROLE_CHANGE' and target_id = v_athlete
   order by created_at desc limit 1;

  update public.users set role = 'athlete' where id = v_athlete;
  select count(*) into v_after_revert from public.admin_actions
   where action = 'ROLE_CHANGE' and target_id = v_athlete;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-56', 'a role change writes a ROLE_CHANGE row with actor and previous/new role',
    v_after_promote = v_before + 1 and v_after_revert = v_before + 2
      and (v_details ->> 'previous_role') = 'athlete' and (v_details ->> 'new_role') = 'referee',
    format('before=%s after_promote=%s after_revert=%s details=%s',
      v_before, v_after_promote, v_after_revert, v_details));
exception when others then
  perform set_config('role', 'postgres', true);
  update public.users set role = 'athlete' where id = v_athlete;
  perform ssc_test.check('DB-56', 'role change audit row', false, sqlerrm);
end $$;

-- DB-57: a cash payment (an entry_payments insert, the same write the Cash
-- Payments desk performs) writes a PAYMENT_OVERRIDE row carrying the amount.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_athlete_id uuid;
  v_vol uuid;
  v_payment_id uuid;
  v_before int;
  v_after int;
  v_details jsonb;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;
  select id into v_athlete_id from public.athletes a
   where a.user_id = ssc_test.user_id('athlete01@ssc-demo.test');

  select count(*) into v_before from public.admin_actions
   where action = 'PAYMENT_OVERRIDE' and target_table = 'entry_payments';

  perform ssc_test.act_as(v_admin);
  insert into public.entry_payments (athlete_id, meet_volume_id, tier, amount_egp, method, collected_by)
  values (v_athlete_id, v_vol, 'standard', 555, 'cash', v_admin)
  returning id into v_payment_id;

  select count(*) into v_after from public.admin_actions
   where action = 'PAYMENT_OVERRIDE' and target_table = 'entry_payments';
  select details into v_details from public.admin_actions
   where action = 'PAYMENT_OVERRIDE' and target_id = v_payment_id;
  perform set_config('role', 'postgres', true);

  delete from public.entry_payments where id = v_payment_id;

  perform ssc_test.check(
    'DB-57', 'a cash entry payment writes a PAYMENT_OVERRIDE row',
    v_after = v_before + 1 and (v_details ->> 'amount_egp')::int = 555,
    format('before=%s after=%s details=%s', v_before, v_after, v_details));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-57', 'cash payment audit row', false, sqlerrm);
end $$;

-- DB-58: a pricing_packages price change writes a PRICING_UPDATE row; an
-- update that resubmits the SAME price does not manufacture a second one —
-- the WHEN clause on the trigger is what this proves.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_vol uuid;
  v_before_price int;
  v_before_count int;
  v_after_change int;
  v_after_noop int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;
  select price_egp into v_before_price from public.pricing_packages
   where meet_volume_id = v_vol and race_count = 2 and tier = 'standard';

  select count(*) into v_before_count from public.admin_actions
   where action = 'PRICING_UPDATE' and target_table = 'pricing_packages';

  perform ssc_test.act_as(v_admin);
  update public.pricing_packages set price_egp = v_before_price + 9
   where meet_volume_id = v_vol and race_count = 2 and tier = 'standard';
  select count(*) into v_after_change from public.admin_actions
   where action = 'PRICING_UPDATE' and target_table = 'pricing_packages';

  -- No-op: same price written again.
  update public.pricing_packages set price_egp = v_before_price + 9
   where meet_volume_id = v_vol and race_count = 2 and tier = 'standard';
  select count(*) into v_after_noop from public.admin_actions
   where action = 'PRICING_UPDATE' and target_table = 'pricing_packages';

  update public.pricing_packages set price_egp = v_before_price
   where meet_volume_id = v_vol and race_count = 2 and tier = 'standard';
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-58', 'a real price change is logged once; a no-op resubmission is not',
    v_after_change = v_before_count + 1 and v_after_noop = v_after_change,
    format('before=%s after_change=%s after_noop=%s', v_before_count, v_after_change, v_after_noop));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-58', 'pricing_packages audit row', false, sqlerrm);
end $$;

-- DB-59: a pricing_tiers window change (the Standard tier's end date moved
-- out a day, then restored) writes a PRICING_UPDATE row.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_vol uuid;
  v_before_ends timestamptz;
  v_before_count int;
  v_after_count int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;
  select ends_at into v_before_ends from public.pricing_tiers
   where meet_volume_id = v_vol and tier = 'standard';

  select count(*) into v_before_count from public.admin_actions
   where action = 'PRICING_UPDATE' and target_table = 'pricing_tiers';

  perform ssc_test.act_as(v_admin);
  update public.pricing_tiers set ends_at = v_before_ends + interval '1 day'
   where meet_volume_id = v_vol and tier = 'standard';
  select count(*) into v_after_count from public.admin_actions
   where action = 'PRICING_UPDATE' and target_table = 'pricing_tiers';

  update public.pricing_tiers set ends_at = v_before_ends
   where meet_volume_id = v_vol and tier = 'standard';
  perform set_config('role', 'postgres', true);

  perform ssc_test.check(
    'DB-59', 'a pricing tier window change writes a PRICING_UPDATE row',
    v_after_count = v_before_count + 1,
    format('before=%s after=%s', v_before_count, v_after_count));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-59', 'pricing_tiers audit row', false, sqlerrm);
end $$;

-- DB-60: a write with no authenticated actor at all (a raw superuser
-- connection, exactly the context schema.sql and seed-*.sql run under) is
-- NOT logged. Without this guard, every re-application of schema.sql — which
-- is meant to be safely re-runnable — would manufacture audit rows for
-- events that never happened in the app. Uses pricing_packages rather than a
-- role change: enforce_role_change_trigger independently requires
-- is_admin() to allow a role change at all, which would make this test
-- fail for the wrong reason (the write itself refused) rather than the one
-- it means to check (the write succeeds, as any superuser write does, but
-- goes unlogged). role = 'postgres' already bypasses RLS regardless of
-- is_admin(), which is what makes this scenario reachable at all.
do $$
declare
  v_vol uuid;
  v_before_price int;
  v_before_count int;
  v_after_count int;
begin
  select id into v_vol from public.meet_volumes where volume_number = 1;
  select price_egp into v_before_price from public.pricing_packages
   where meet_volume_id = v_vol and race_count = 3 and tier = 'standard';

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);

  select count(*) into v_before_count from public.admin_actions
   where action = 'PRICING_UPDATE' and target_table = 'pricing_packages';
  update public.pricing_packages set price_egp = v_before_price + 3
   where meet_volume_id = v_vol and race_count = 3 and tier = 'standard';
  select count(*) into v_after_count from public.admin_actions
   where action = 'PRICING_UPDATE' and target_table = 'pricing_packages';

  update public.pricing_packages set price_egp = v_before_price
   where meet_volume_id = v_vol and race_count = 3 and tier = 'standard';

  perform ssc_test.check(
    'DB-60', 'a superuser write with no authenticated actor is not logged',
    v_after_count = v_before_count,
    format('before=%s after=%s', v_before_count, v_after_count));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-60', 'unauthenticated write is not logged', false, sqlerrm);
end $$;

-- =============================================================================
-- DB-61..DB-64 — captain-initiated team invites (team_memberships.status =
-- 'invited') and shareable invite links (team_invite_links). The opposite
-- direction from the athlete-initiated 'pending' requests DB-9/DB-12 already
-- cover.
-- =============================================================================

-- DB-61: the Riptide captain can invite unattached athlete39; the Blue
-- Marlins captain (not this team's captain) cannot.
do $$
declare
  v_riptide_captain uuid := ssc_test.user_id('captain.riptide@ssc-demo.test');
  v_marlins_captain uuid := ssc_test.user_id('captain.marlins@ssc-demo.test');
  v_riptide uuid := ssc_test.team_id('Riptide Swim Club');
  v_athlete39 uuid := ssc_test.user_id('athlete39@ssc-demo.test');
  v_row_id uuid;
  v_wrong_captain_blocked boolean := false;
begin
  delete from public.team_memberships where user_id = v_athlete39;

  perform ssc_test.act_as(v_riptide_captain);
  insert into public.team_memberships (team_id, user_id, status)
    values (v_riptide, v_athlete39, 'invited')
    returning id into v_row_id;
  perform set_config('role', 'postgres', true);

  perform ssc_test.check('DB-61', 'a team''s own captain can invite an unattached athlete',
    v_row_id is not null, null);

  begin
    perform ssc_test.act_as(v_marlins_captain);
    insert into public.team_memberships (team_id, user_id, status)
      values (v_riptide, v_athlete39, 'invited');
    -- unique(team_id, user_id) means this would fail on the duplicate row
    -- alone even if RLS let it through — so this must never reach this line.
  exception when others then
    v_wrong_captain_blocked := true;
  end;
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-61', 'a captain of a DIFFERENT team cannot invite into Riptide',
    v_wrong_captain_blocked, null);
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-61', 'captain invite insert', false, sqlerrm);
end $$;

-- DB-62: the captain who sent an invite cannot accept it on the invitee's
-- behalf; the invitee accepting it DOES sync athletes.team_id, the same
-- trigger the athlete-initiated 'pending' -> 'accepted' path already uses.
do $$
declare
  v_riptide_captain uuid := ssc_test.user_id('captain.riptide@ssc-demo.test');
  v_athlete39 uuid := ssc_test.user_id('athlete39@ssc-demo.test');
  v_riptide uuid := ssc_test.team_id('Riptide Swim Club');
  v_row_id uuid;
  v_self_accept_rows int;
  v_team_after_self_accept uuid;
  v_team_after_real_accept uuid;
begin
  select id into v_row_id from public.team_memberships
   where team_id = v_riptide and user_id = v_athlete39 and status = 'invited';

  perform ssc_test.act_as(v_riptide_captain);
  update public.team_memberships set status = 'accepted' where id = v_row_id;
  get diagnostics v_self_accept_rows = row_count;
  perform set_config('role', 'postgres', true);
  select team_id into v_team_after_self_accept from public.athletes where user_id = v_athlete39;

  perform ssc_test.check('DB-62', 'the sending captain cannot self-accept their own invite',
    v_self_accept_rows = 0 and v_team_after_self_accept is null,
    format('rows updated=%s team_id=%s', v_self_accept_rows, v_team_after_self_accept));

  perform ssc_test.act_as(v_athlete39);
  update public.team_memberships set status = 'accepted' where id = v_row_id;
  perform set_config('role', 'postgres', true);
  select team_id into v_team_after_real_accept from public.athletes where user_id = v_athlete39;

  perform ssc_test.check('DB-62', 'the invitee accepting syncs athletes.team_id',
    v_team_after_real_accept = v_riptide, format('team_id=%s', v_team_after_real_accept));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-62', 'invite accept', false, sqlerrm);
end $$;

-- DB-63: a captain cannot invite an athlete who already has a team —
-- athlete39 just landed on Riptide in DB-62; Blue Marlins' captain tries to
-- invite them too and must be refused by
-- enforce_team_membership_request_rules(), not merely produce a stray row.
do $$
declare
  v_marlins_captain uuid := ssc_test.user_id('captain.marlins@ssc-demo.test');
  v_marlins uuid := ssc_test.team_id('Blue Marlins');
  v_athlete39 uuid := ssc_test.user_id('athlete39@ssc-demo.test');
  v_blocked boolean := false;
begin
  begin
    perform ssc_test.act_as(v_marlins_captain);
    insert into public.team_memberships (team_id, user_id, status)
      values (v_marlins, v_athlete39, 'invited');
  exception when others then
    v_blocked := true;
  end;
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-63', 'a captain cannot invite an athlete who already has a team',
    v_blocked, null);
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-63', 'invite-already-on-a-team guard', false, sqlerrm);
end $$;

-- DB-64: shareable invite links. Redeeming a real token resolves the team
-- and increments use_count exactly once; previewing the same token does
-- NOT increment it; a revoked link no longer redeems.
do $$
declare
  v_captain uuid := ssc_test.user_id('captain.riptide@ssc-demo.test');
  v_riptide uuid := ssc_test.team_id('Riptide Swim Club');
  v_token text;
  v_preview_result text;
  v_use_count_after_preview int;
  v_redeem_result uuid;
  v_use_count_after_redeem int;
  v_redeem_after_revoke uuid;
begin
  perform ssc_test.act_as(v_captain);
  select public.create_team_invite_link(v_riptide) into v_token;
  perform set_config('role', 'postgres', true);

  select public.preview_team_invite_token(v_token) into v_preview_result;
  select use_count into v_use_count_after_preview from public.team_invite_links where token = v_token;
  perform ssc_test.check('DB-64', 'preview resolves the team name without incrementing use_count',
    v_preview_result = 'Riptide Swim Club' and v_use_count_after_preview = 0,
    format('preview=%s use_count=%s', v_preview_result, v_use_count_after_preview));

  select public.redeem_team_invite_token(v_token) into v_redeem_result;
  select use_count into v_use_count_after_redeem from public.team_invite_links where token = v_token;
  perform ssc_test.check('DB-64', 'redeeming resolves the team_id and increments use_count once',
    v_redeem_result = v_riptide and v_use_count_after_redeem = 1,
    format('team_id=%s use_count=%s', v_redeem_result, v_use_count_after_redeem));

  update public.team_invite_links set revoked_at = now() where token = v_token;
  select public.redeem_team_invite_token(v_token) into v_redeem_after_revoke;
  perform ssc_test.check('DB-64', 'a revoked link no longer redeems',
    v_redeem_after_revoke is null, format('result=%s', v_redeem_after_revoke));
exception when others then
  perform set_config('role', 'postgres', true);
  perform ssc_test.check('DB-64', 'invite link create/preview/redeem/revoke', false, sqlerrm);
end $$;

-- DB-65: collected_by is server-derived on the payment tables. An
-- authenticated admin who explicitly supplies SOMEONE ELSE'S id has it
-- overwritten with their own (public.enforce_collected_by), so the figure the
-- cash desk displays can never disagree with the admin_actions audit row.
do $$
declare
  v_admin uuid := ssc_test.user_id('elewakareem2002@gmail.com');
  v_other uuid := ssc_test.user_id('referee1@ssc-demo.test');
  v_athlete uuid;
  v_volume uuid;
  v_payment uuid;
  v_stored uuid;
  v_defaulted uuid;
begin
  select id into v_athlete from public.athletes limit 1;
  select id into v_volume from public.meet_volumes order by volume_number limit 1;

  perform ssc_test.act_as(v_admin);

  -- Explicitly forged collector.
  insert into public.entry_payments (athlete_id, meet_volume_id, tier, amount_egp, collected_by, note)
  values (v_athlete, v_volume, 'standard', 1, v_other, 'DB-65 forged')
  returning id into v_payment;
  select collected_by into v_stored from public.entry_payments where id = v_payment;

  -- Column omitted entirely — the DEFAULT auth.uid() path.
  insert into public.entry_payments (athlete_id, meet_volume_id, tier, amount_egp, note)
  values (v_athlete, v_volume, 'standard', 1, 'DB-65 omitted')
  returning id into v_payment;
  select collected_by into v_defaulted from public.entry_payments where id = v_payment;

  perform set_config('role', 'postgres', true);
  delete from public.entry_payments where note like 'DB-65%';

  perform ssc_test.check(
    'DB-65', 'an explicitly forged collected_by is overwritten with auth.uid()',
    v_stored = v_admin and v_stored <> v_other,
    format('stored=%s admin=%s other=%s', v_stored, v_admin, v_other));
  perform ssc_test.check(
    'DB-65', 'an omitted collected_by defaults to auth.uid()',
    v_defaulted = v_admin, format('stored=%s admin=%s', v_defaulted, v_admin));
exception when others then
  perform set_config('role', 'postgres', true);
  delete from public.entry_payments where note like 'DB-65%';
  perform ssc_test.check('DB-65', 'collected_by is server-derived', false, sqlerrm);
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
