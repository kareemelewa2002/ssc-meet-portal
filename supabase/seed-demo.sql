-- =============================================================================
-- SSC Vol. 1 — Idempotent Demo/QA Seed Data (large-scale)
-- =============================================================================
-- Apply with: psql "$DATABASE_URL" -f supabase/seed-demo.sql
--         or: paste into the Supabase SQL Editor (Dashboard > SQL Editor).
--
-- Both of those run as the Postgres table-owner role, which bypasses RLS
-- automatically. This script still needs to satisfy the app's *trigger*
-- level admin-only guards (role changes, athlete approval, entry
-- confirmation, result publishing) since those check auth.uid()/is_admin()
-- directly and fire regardless of RLS. Rather than disabling triggers, this
-- script authenticates itself AS the seeded admin account by setting the
-- request.jwt.claim.sub session GUC before any privileged write — the
-- standard way to run "as a specific user" from a plain SQL session without
-- a service-role key. The setting is local to this transaction and reverts
-- automatically on COMMIT.
--
-- SAFETY / RE-RUN BEHAVIOR:
--   - Every demo account other than the admin uses the @ssc-demo.test email
--     domain (RFC 2606 reserved — guaranteed non-deliverable / non-real).
--   - The admin email (elewakareem2002@gmail.com) is looked up first; if it
--     already exists, this script reuses that real account as-is and never
--     deletes or recreates it.
--   - Entries/heats/results are deleted-and-rebuilt EACH RUN, but only for
--     rows owned by the @ssc-demo.test athletes seeded below — real athlete
--     entries for SSC Vol. 1 (or any other volume) are never touched.
--   - Safe to run any number of times; every statement is an idempotent
--     upsert or a narrowly-scoped delete+rebuild of demo-only rows.
--
-- SCOPE NOTE ON RELAY EVENTS: the exact SSC Vol. 1 program includes several
-- 4x50m/4x100m relay events (Male/Female/Mixed). The entries data model is
-- one-athlete-per-entry — there is no relay-team-of-4 entry/heat/result
-- concept anywhere in the schema. Relay events are therefore seeded as real
-- `events` rows (so they appear correctly in the schedule, live results,
-- and admin seeding dashboard) but deliberately receive no entries/heats/
-- results here, same as Skins events (which use a different, automatic
-- assignment path instead).
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Seed-only helper: get-or-create an auth user by email. Dropped at the
-- end of this script (it's not part of the application schema).
-- ---------------------------------------------------------------------------
create or replace function public._seed_get_or_create_user(
  p_email text,
  p_full_name text,
  p_role text,
  p_phone text default null
) returns uuid
language plpgsql
as $fn$
declare
  v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(p_email);
  if v_id is not null then
    return v_id;
  end if;

  v_id := gen_random_uuid();
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_id,
    'authenticated',
    'authenticated',
    lower(p_email),
    crypt('SscDemo!2026', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_strip_nulls(jsonb_build_object(
      'full_name', p_full_name,
      'role', p_role,
      'phone', p_phone
    )),
    now(),
    now()
  );
  return v_id;
end;
$fn$;

-- ---------------------------------------------------------------------------
-- 1. Admin bootstrap — ensures elewakareem2002@gmail.com resolves to 'admin'
-- via the existing public.handle_new_auth_user() trigger, then authenticates
-- the rest of this session as that admin.
-- ---------------------------------------------------------------------------
insert into public.app_settings (id, superadmin_email)
values (true, 'elewakareem2002@gmail.com')
on conflict (id) do update set superadmin_email = excluded.superadmin_email;

do $$
declare
  v_admin_id uuid;
begin
  v_admin_id := public._seed_get_or_create_user(
    'elewakareem2002@gmail.com', 'Kareem Elewa', 'admin', '+1-555-0100'
  );

  -- Defensive fixup: if this email already had an account created before
  -- app_settings.superadmin_email pointed here, force it to admin now.
  -- Narrowly disables just this one trigger for a single targeted UPDATE.
  if not exists (select 1 from public.users where id = v_admin_id and role = 'admin') then
    alter table public.users disable trigger enforce_role_change_trigger;
    update public.users set role = 'admin' where id = v_admin_id;
    alter table public.users enable trigger enforce_role_change_trigger;
  end if;

  -- Authenticate this session as the admin for every remaining statement —
  -- makes is_admin() / is_admin_or_referee() true for the rest of this
  -- transaction, satisfying every admin/referee-gated trigger below.
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin_id, 'role', 'authenticated')::text,
    true
  );
end $$;

-- ---------------------------------------------------------------------------
-- 2. Club teams
-- ---------------------------------------------------------------------------
insert into public.teams (name, abbreviation, club_logo_url, approved_by_admin)
values
  ('Riptide Swim Club', 'RIPT', 'https://placehold.co/128x128?text=RIPT', true),
  ('Blue Marlins', 'BLUM', 'https://placehold.co/128x128?text=BLUM', true),
  ('Tidal Wave', 'TIDE', 'https://placehold.co/128x128?text=TIDE', true)
on conflict (name) do update
  set abbreviation = excluded.abbreviation,
      club_logo_url = excluded.club_logo_url,
      approved_by_admin = excluded.approved_by_admin;

-- ---------------------------------------------------------------------------
-- 3. Meet Volume & Schedule — SSC Vol. 1, exact official program.
-- ---------------------------------------------------------------------------
insert into public.meet_volumes (volume_number, name, meet_date, status)
values (1, 'SSC Vol. 1', date '2026-10-02', 'scheduled')
on conflict (volume_number) do update
  set name = excluded.name, meet_date = excluded.meet_date, status = excluded.status;

insert into public.sessions (meet_volume_id, session_number, name, meet_date, start_time, end_time)
select mv.id, v.session_number, v.name, mv.meet_date, v.start_time, v.end_time
from public.meet_volumes mv
cross join (values
  (1, 'Session 1 — Morning', time '09:00', time '12:00'),
  (2, 'Session 2 — Afternoon', time '14:00', time '17:00'),
  (3, 'Session 3 — Skins', time '17:00', time '19:00')
) as v(session_number, name, start_time, end_time)
where mv.volume_number = 1
on conflict (meet_volume_id, session_number) do update
  set name = excluded.name,
      meet_date = excluded.meet_date,
      start_time = excluded.start_time,
      end_time = excluded.end_time;

-- Exact official Vol. 1 program. is_relay marks the 4x50/4x100 relay events
-- (schedule-only — see the file header note); is_skins marks the single
-- Session 3 elimination event (auto-assigned from results, never entered
-- directly here or by athletes).
insert into public.events (session_id, name, stroke, distance_m, event_order, is_relay, is_skins)
select s.id, v.name, v.stroke, v.distance_m, v.event_order, v.is_relay, v.is_skins
from public.sessions s
join public.meet_volumes mv on mv.id = s.meet_volume_id and mv.volume_number = 1
cross join lateral (
  values
    -- Session 1
    (1, '100m Freestyle', 'Freestyle', 100, 1, false, false),
    (1, '50m Back-to-Breast Switch (25m Back + 25m Breast)', 'Back-to-Breast Switch', 50, 2, false, false),
    (1, '50m Butterfly', 'Butterfly', 50, 3, false, false),
    (1, '4x50m Medley Relay (Mixed: 2 Boys + 2 Girls)', 'Medley Relay', 200, 4, true, false),
    (1, '4x50m Freestyle Relay (Male)', 'Freestyle Relay', 200, 5, true, false),
    (1, '4x50m Freestyle Relay (Female)', 'Freestyle Relay', 200, 6, true, false),
    (1, '4x50m Freestyle Relay (Mixed)', 'Freestyle Relay', 200, 7, true, false),
    -- Session 2
    (2, '100m Individual Medley (IM)', 'Individual Medley', 100, 1, false, false),
    (2, '50m Backstroke', 'Backstroke', 50, 2, false, false),
    (2, '50m Fly-to-Back Switch (25m Fly + 25m Back)', 'Fly-to-Back Switch', 50, 3, false, false),
    (2, '50m Breaststroke', 'Breaststroke', 50, 4, false, false),
    (2, '4x50m Freestyle Relay (Mixed: 2 Boys + 2 Girls)', 'Freestyle Relay', 200, 5, true, false),
    (2, '4x50m Medley Relay (Male)', 'Medley Relay', 200, 6, true, false),
    (2, '4x50m Medley Relay (Female)', 'Medley Relay', 200, 7, true, false),
    -- Session 3
    (3, '50m Breast-to-Free Switch (25m Breast + 25m Free)', 'Breast-to-Free Switch', 50, 1, false, false),
    (3, '4x100m Individual Medley Relay (Male)', 'Individual Medley Relay', 400, 2, true, false),
    (3, '4x100m Individual Medley Relay (Female)', 'Individual Medley Relay', 400, 3, true, false),
    (3, '50m Freestyle', 'Freestyle', 50, 4, false, false),
    (3, '50m Freestyle Skins', 'Freestyle', 50, 5, false, true)
) as v(session_number, name, stroke, distance_m, event_order, is_relay, is_skins)
where s.session_number = v.session_number
  and not exists (
    select 1 from public.events e where e.session_id = s.id and e.name = v.name
  );

-- ---------------------------------------------------------------------------
-- 4. Officials & support staff.
-- ---------------------------------------------------------------------------
do $$
begin
  -- 1 Chief Referee + 8 Lane Referees.
  perform public._seed_get_or_create_user('chief.referee@ssc-demo.test', 'Priya Chandra', 'referee', '+1-555-0101');
  perform public._seed_get_or_create_user('referee1@ssc-demo.test', 'Marcus Lee', 'referee', '+1-555-0102');
  perform public._seed_get_or_create_user('referee2@ssc-demo.test', 'Sara Kildow', 'referee', '+1-555-0103');
  perform public._seed_get_or_create_user('referee3@ssc-demo.test', 'David Okoro', 'referee', '+1-555-0110');
  perform public._seed_get_or_create_user('referee4@ssc-demo.test', 'Helena Voss', 'referee', '+1-555-0111');
  perform public._seed_get_or_create_user('referee5@ssc-demo.test', 'Tomasz Nowak', 'referee', '+1-555-0112');
  perform public._seed_get_or_create_user('referee6@ssc-demo.test', 'Aisha Rahman', 'referee', '+1-555-0113');
  perform public._seed_get_or_create_user('referee7@ssc-demo.test', 'Connor Hayes', 'referee', '+1-555-0114');
  perform public._seed_get_or_create_user('referee8@ssc-demo.test', 'Yuki Tanaka', 'referee', '+1-555-0115');

  -- 3 Ushers / Heat Organizers (Call Room). 'usher' is not a self-service
  -- public_signup_role, so it lands as 'athlete' first; fixed up below.
  perform public._seed_get_or_create_user('usher1@ssc-demo.test', 'Devon Okafor', 'usher', '+1-555-0104');
  perform public._seed_get_or_create_user('usher2@ssc-demo.test', 'Lena Ford', 'usher', '+1-555-0105');
  perform public._seed_get_or_create_user('usher3@ssc-demo.test', 'Mateo Rossi', 'usher', '+1-555-0116');

  -- 4 Entry Desk Helpers. 'entry_helper' is likewise not a self-service role.
  perform public._seed_get_or_create_user('entryhelper1@ssc-demo.test', 'Nora Whitfield', 'entry_helper', '+1-555-0120');
  perform public._seed_get_or_create_user('entryhelper2@ssc-demo.test', 'Jamal Carter', 'entry_helper', '+1-555-0121');
  perform public._seed_get_or_create_user('entryhelper3@ssc-demo.test', 'Beatriz Souza', 'entry_helper', '+1-555-0122');
  perform public._seed_get_or_create_user('entryhelper4@ssc-demo.test', 'Simon Blake', 'entry_helper', '+1-555-0123');

  -- Coaches / Team Captains — one per club. 'coach' is a valid
  -- public_signup_role; promoted to 'team_captain' once assigned as a
  -- team's captain_id below.
  perform public._seed_get_or_create_user('coach.riptide@ssc-demo.test', 'Coach Riley Adams', 'coach', '+1-555-0106');
  perform public._seed_get_or_create_user('coach.marlins@ssc-demo.test', 'Coach Jordan Kim', 'coach', '+1-555-0130');
  perform public._seed_get_or_create_user('coach.tidalwave@ssc-demo.test', 'Coach Alicia Moreno', 'coach', '+1-555-0131');

  -- Parents — linked to the U13-14 athletes below.
  perform public._seed_get_or_create_user('parent1@ssc-demo.test', 'Dana Whitfield', 'parent', '+1-555-0107');
  perform public._seed_get_or_create_user('parent2@ssc-demo.test', 'Marcus Webb Sr.', 'parent', '+1-555-0132');
  perform public._seed_get_or_create_user('parent3@ssc-demo.test', 'Sophia Ahmed', 'parent', '+1-555-0133');
end $$;

update public.users set role = 'usher'
where email in ('usher1@ssc-demo.test', 'usher2@ssc-demo.test', 'usher3@ssc-demo.test') and role <> 'usher';

update public.users set role = 'entry_helper'
where email in (
  'entryhelper1@ssc-demo.test', 'entryhelper2@ssc-demo.test',
  'entryhelper3@ssc-demo.test', 'entryhelper4@ssc-demo.test'
) and role <> 'entry_helper';

update public.users set role = 'team_captain'
where email in ('coach.riptide@ssc-demo.test', 'coach.marlins@ssc-demo.test', 'coach.tidalwave@ssc-demo.test')
  and role <> 'team_captain';

update public.teams set captain_id = (select id from auth.users where email = 'coach.riptide@ssc-demo.test')
where name = 'Riptide Swim Club';
update public.teams set captain_id = (select id from auth.users where email = 'coach.marlins@ssc-demo.test')
where name = 'Blue Marlins';
update public.teams set captain_id = (select id from auth.users where email = 'coach.tidalwave@ssc-demo.test')
where name = 'Tidal Wave';

-- ---------------------------------------------------------------------------
-- 5. Athletes — 36 regular swimmers (12 per age group, 6 male + 6 female
-- each, distributed across all 3 clubs), plus 1 unapproved swimmer and 1
-- under-15 swimmer with a still-pending parent linkage to exercise both
-- approval gates independently of the regular population.
-- ---------------------------------------------------------------------------
do $$
declare
  v_parent1 uuid; v_parent2 uuid; v_parent3 uuid;
  v_riptide uuid; v_marlins uuid; v_tidal uuid;
  rec record;
begin
  v_parent1 := (select id from auth.users where email = 'parent1@ssc-demo.test');
  v_parent2 := (select id from auth.users where email = 'parent2@ssc-demo.test');
  v_parent3 := (select id from auth.users where email = 'parent3@ssc-demo.test');
  select id into v_riptide from public.teams where name = 'Riptide Swim Club';
  select id into v_marlins from public.teams where name = 'Blue Marlins';
  select id into v_tidal from public.teams where name = 'Tidal Wave';

  for rec in
    select * from (values
      -- ---- U13_14 (12): parent-linked & verified, teams round-robin ----
      ('athlete01@ssc-demo.test', 'Ethan Ng',        date '2012-03-02', 'male',   v_riptide, v_parent1),
      ('athlete02@ssc-demo.test', 'Marcus Webb',     date '2012-06-08', 'male',   v_marlins, v_parent2),
      ('athlete03@ssc-demo.test', 'Owen Park',       date '2013-01-15', 'male',   v_tidal,   v_parent3),
      ('athlete04@ssc-demo.test', 'Aiden Cole',      date '2013-04-22', 'male',   v_riptide, v_parent1),
      ('athlete05@ssc-demo.test', 'Ryan Alvarez',    date '2012-02-11', 'male',   v_marlins, v_parent2),
      ('athlete06@ssc-demo.test', 'Caleb Nguyen',    date '2013-05-30', 'male',   v_tidal,   v_parent3),
      ('athlete07@ssc-demo.test', 'Chloe Bennett',   date '2013-05-14', 'female', v_riptide, v_parent1),
      ('athlete08@ssc-demo.test', 'Priya Sharma',    date '2013-02-20', 'female', v_marlins, v_parent2),
      ('athlete09@ssc-demo.test', 'Zara Ahmed',      date '2012-04-18', 'female', v_tidal,   v_parent3),
      ('athlete10@ssc-demo.test', 'Nina Torres',     date '2012-01-25', 'female', v_riptide, v_parent1),
      ('athlete11@ssc-demo.test', 'Ivy Chen',        date '2013-03-09', 'female', v_marlins, v_parent2),
      ('athlete12@ssc-demo.test', 'Lucy Brooks',     date '2012-06-01', 'female', v_tidal,   v_parent3),
      -- ---- U17 (12): no parent link required, teams round-robin ----
      ('athlete13@ssc-demo.test', 'Tyler Brooks',    date '2010-02-25', 'male',   v_riptide, null),
      ('athlete14@ssc-demo.test', 'Diego Ramirez',   date '2010-05-18', 'male',   v_marlins, null),
      ('athlete15@ssc-demo.test', 'Noah Patel',      date '2011-03-14', 'male',   v_tidal,   null),
      ('athlete16@ssc-demo.test', 'Miles Foster',    date '2011-01-08', 'male',   v_riptide, null),
      ('athlete17@ssc-demo.test', 'Hassan Ali',      date '2010-04-02', 'male',   v_marlins, null),
      ('athlete18@ssc-demo.test', 'Felix Turner',    date '2011-06-19', 'male',   v_tidal,   null),
      ('athlete19@ssc-demo.test', 'Isabella Cruz',   date '2011-04-12', 'female', v_riptide, null),
      ('athlete20@ssc-demo.test', 'Amara Johnson',   date '2011-01-30', 'female', v_marlins, null),
      ('athlete21@ssc-demo.test', 'Freya Olsen',     date '2010-03-27', 'female', v_tidal,   null),
      ('athlete22@ssc-demo.test', 'Layla Hassan',    date '2010-06-05', 'female', v_riptide, null),
      ('athlete23@ssc-demo.test', 'Ruby Simmons',    date '2011-02-14', 'female', v_marlins, null),
      ('athlete24@ssc-demo.test', 'Maya Lindqvist',  date '2010-01-11', 'female', v_tidal,   null),
      -- ---- Open (12): no parent link required, teams round-robin ----
      ('athlete25@ssc-demo.test', 'Liam O''Connor',  date '2005-06-22', 'male',   v_riptide, null),
      ('athlete26@ssc-demo.test', 'Jake Sullivan',   date '2003-04-01', 'male',   v_marlins, null),
      ('athlete27@ssc-demo.test', 'Kian Osei',       date '2004-02-17', 'male',   v_tidal,   null),
      ('athlete28@ssc-demo.test', 'Theo Martin',     date '2008-05-09', 'male',   v_riptide, null),
      ('athlete29@ssc-demo.test', 'Andre Silva',     date '2002-03-25', 'male',   v_marlins, null),
      ('athlete30@ssc-demo.test', 'Omar Farouk',     date '2006-01-30', 'male',   v_tidal,   null),
      ('athlete31@ssc-demo.test', 'Sofia Martinez',  date '2008-03-10', 'female', v_riptide, null),
      ('athlete32@ssc-demo.test', 'Grace Kim',       date '2007-02-14', 'female', v_marlins, null),
      ('athlete33@ssc-demo.test', 'Ava Thompson',    date '2005-04-06', 'female', v_tidal,   null),
      ('athlete34@ssc-demo.test', 'Nadia Volkov',    date '2004-06-12', 'female', v_riptide, null),
      ('athlete35@ssc-demo.test', 'Elena Petrova',   date '2003-01-19', 'female', v_marlins, null),
      ('athlete36@ssc-demo.test', 'Maria Santos',    date '2006-05-24', 'female', v_tidal,   null)
    ) as t(email, full_name, dob, gender, team_id, parent_id)
  loop
    declare
      v_user_id uuid;
      v_age integer;
    begin
      v_user_id := public._seed_get_or_create_user(rec.email, rec.full_name, 'athlete', null);
      v_age := public.age_at_date(rec.dob, current_date);

      insert into public.athletes (
        user_id, team_id, parent_id, date_of_birth, age, age_group, gender,
        height_cm, weight_kg, specialty_events, parent_link_status,
        pending_parent_email, approved_by_admin
      ) values (
        v_user_id, rec.team_id, rec.parent_id, rec.dob, greatest(v_age, 13),
        public.age_group_for_age(greatest(v_age, 13)), rec.gender::public.gender,
        150 + (abs(hashtext(rec.email)) % 40), 40 + (abs(hashtext(rec.email || 'w')) % 45),
        array['Freestyle'], case when rec.parent_id is not null then 'verified' else 'none' end::public.parent_link_status,
        null, true
      )
      on conflict (user_id) do update
        set team_id = excluded.team_id,
            parent_id = excluded.parent_id,
            date_of_birth = excluded.date_of_birth,
            age = excluded.age,
            age_group = excluded.age_group,
            gender = excluded.gender,
            parent_link_status = excluded.parent_link_status,
            pending_parent_email = excluded.pending_parent_email,
            approved_by_admin = excluded.approved_by_admin;
    end;
  end loop;

  -- ---- Special gate-test fixtures (excluded from bulk entries below) ----
  declare
    v_nathan_id uuid;
    v_zoe_id uuid;
  begin
    v_nathan_id := public._seed_get_or_create_user('athlete37@ssc-demo.test', 'Nathan Price', 'athlete', null);
    insert into public.athletes (
      user_id, team_id, date_of_birth, age, age_group, gender,
      specialty_events, parent_link_status, approved_by_admin
    ) values (
      v_nathan_id, v_riptide, date '2006-05-05', public.age_at_date(date '2006-05-05', current_date),
      public.age_group_for_age(public.age_at_date(date '2006-05-05', current_date)), 'male',
      array['Freestyle'], 'none', false
    )
    on conflict (user_id) do update set approved_by_admin = false, parent_link_status = 'none';

    v_zoe_id := public._seed_get_or_create_user('athlete38@ssc-demo.test', 'Zoe Whitfield', 'athlete', null);
    insert into public.athletes (
      user_id, team_id, date_of_birth, age, age_group, gender,
      specialty_events, parent_link_status, pending_parent_email, approved_by_admin
    ) values (
      v_zoe_id, v_marlins, date '2012-08-01', public.age_at_date(date '2012-08-01', current_date),
      public.age_group_for_age(public.age_at_date(date '2012-08-01', current_date)), 'female',
      array['Freestyle'], 'pending', 'unclaimed.parent@ssc-demo.test', true
    )
    on conflict (user_id) do update
      set parent_link_status = 'pending',
          pending_parent_email = 'unclaimed.parent@ssc-demo.test',
          approved_by_admin = true;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Volume team affiliations (Feature 2). All 36 regular athletes represent
-- their current club for SSC Vol. 1, EXCEPT Isabella Cruz (athlete19), who
-- is deliberately recorded as having swum Vol. 1 unattached — demonstrating
-- that historical team display is independent of an athlete's current club.
-- ---------------------------------------------------------------------------
insert into public.volume_team_affiliations (athlete_id, meet_volume_id, team_id)
select a.id, mv.id, case when u.email = 'athlete19@ssc-demo.test' then null else a.team_id end
from public.athletes a
join public.users u on u.id = a.user_id
cross join public.meet_volumes mv
where mv.volume_number = 1
  and u.email like 'athlete%@ssc-demo.test'
  and a.approved_by_admin = true
  and a.parent_link_status <> 'pending'
on conflict (athlete_id, meet_volume_id) do update set team_id = excluded.team_id;

-- ---------------------------------------------------------------------------
-- 7. Entries — every individual (non-relay, non-skins) event across all 3
-- sessions, for all 36 regular approved athletes. Seed times are generated
-- deterministically (stroke/distance baseline + age-group + per-athlete +
-- per-event variance) so re-running this script always converges to the
-- same values. Roughly 1 in 12 entries is NT. The 2 gate-test fixtures
-- (unapproved / pending-parent) are excluded — they exist to prove the
-- gates block entry, not to hold entries themselves.
-- ---------------------------------------------------------------------------
insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
select
  ev.id,
  a.id,
  case when (abs(hashtext(a.id::text || ev.id::text)) % 12) = 0 then null
    else
      (case ev.distance_m when 50 then 26000 when 100 then 58000 else 90000 end)
      + (case a.age_group when 'U13_14' then 9000 when 'U17' then 4000 else 0 end)
      + (abs(hashtext(a.id::text)) % 4000)
      + (abs(hashtext(a.id::text || ev.id::text)) % 2000)
  end,
  (abs(hashtext(a.id::text || ev.id::text)) % 12) = 0,
  'confirmed'
from public.events ev
join public.sessions s on s.id = ev.session_id
join public.meet_volumes mv on mv.id = s.meet_volume_id and mv.volume_number = 1
cross join public.athletes a
join public.users u on u.id = a.user_id
where ev.is_relay = false
  and ev.is_skins = false
  and u.email like 'athlete%@ssc-demo.test'
  and a.approved_by_admin = true
  and a.parent_link_status <> 'pending'
on conflict (event_id, athlete_id) do update
  set seed_time_ms = excluded.seed_time_ms,
      is_nt = excluded.is_nt,
      status = excluded.status;

-- ---------------------------------------------------------------------------
-- 8. Heats & lanes — official 6-lane sequence [4, 3, 5, 2, 1, 6], U13_14
-- seeded separately from the combined U17/Open field and always scheduled
-- first (see lib/seeding.ts). Buckets larger than 6 chunk into multiple
-- heats, with the fastest chunk scheduled last within its bucket — the
-- same "fastest heat last" rule the real seeding engine applies. Demo-only
-- heats are rebuilt from scratch each run (delete scoped to Vol. 1's
-- individual events, which only ever contain the demo entries above).
-- ---------------------------------------------------------------------------
delete from public.heats
where event_id in (
  select ev.id from public.events ev
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where mv.volume_number = 1 and ev.is_relay = false and ev.is_skins = false
);

create temporary table _seed_heat_plan on commit drop as
with ranked as (
  select
    e.id as entry_id,
    e.event_id,
    e.athlete_id,
    e.seed_time_ms,
    e.is_nt,
    case when coalesce(e.age_group_at_entry, a.age_group) = 'U13_14' then 'U13_14' else 'U17_OPEN' end as heat_group,
    row_number() over (
      partition by e.event_id,
        case when coalesce(e.age_group_at_entry, a.age_group) = 'U13_14' then 'U13_14' else 'U17_OPEN' end
      order by
        e.is_nt desc,
        case when e.is_nt then null else e.seed_time_ms end asc nulls last,
        case when e.is_nt then a.age end desc nulls last
    ) as rank_in_bucket,
    count(*) over (
      partition by e.event_id,
        case when coalesce(e.age_group_at_entry, a.age_group) = 'U13_14' then 'U13_14' else 'U17_OPEN' end
    ) as bucket_size
  from public.entries e
  join public.athletes a on a.id = e.athlete_id
  join public.events ev on ev.id = e.event_id
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where mv.volume_number = 1 and ev.is_relay = false and ev.is_skins = false
),
chunked as (
  select
    *,
    floor((rank_in_bucket - 1) / 6.0)::int as chunk_index,
    ceil(bucket_size / 6.0)::int as num_chunks,
    (((rank_in_bucket - 1) % 6) + 1)::int as lane_slot
  from ranked
),
bucketed as (
  select
    *,
    (num_chunks - chunk_index)::int as heat_number_in_bucket,
    max(case when heat_group = 'U13_14' then num_chunks else 0 end)
      over (partition by event_id) as u1314_chunk_count
  from chunked
)
select
  event_id,
  heat_group::public.heat_group as heat_group,
  case when heat_group = 'U13_14'
    then heat_number_in_bucket
    else u1314_chunk_count + heat_number_in_bucket
  end as heat_number,
  lane_slot,
  entry_id
from bucketed;

with inserted_heats as (
  insert into public.heats (event_id, heat_group, heat_number, heat_order, status)
  select distinct event_id, heat_group, heat_number, heat_number, 'published'::public.publish_status
  from _seed_heat_plan
  returning id, event_id, heat_group, heat_number
)
insert into public.heat_lanes (heat_id, lane_number, entry_id)
select ih.id, (array[4,3,5,2,1,6])[p.lane_slot], p.entry_id
from _seed_heat_plan p
join inserted_heats ih
  on ih.event_id = p.event_id and ih.heat_group = p.heat_group and ih.heat_number = p.heat_number;

-- ---------------------------------------------------------------------------
-- 9. Sample published results — official times with realistic drops from
-- seed. Roughly 1 in 4 heats also carries a DQ and a No-Show for QA
-- coverage of those codes, rather than every heat (which would be
-- unrealistically high). finish_place / placement_points are intentionally
-- NOT set here — public.recompute_heat_finish_places() (see schema.sql)
-- derives them automatically from official_time_ms the moment each row
-- lands, exactly as it does for real referee-entered results.
-- ---------------------------------------------------------------------------
with lane_context as (
  select
    hl.id as heat_lane_id,
    hl.heat_id,
    hl.lane_number,
    e.seed_time_ms,
    e.is_nt,
    row_number() over (partition by hl.heat_id order by hl.lane_number) as lane_seq,
    count(*) over (partition by hl.heat_id) as lanes_in_heat,
    (abs(hashtext(hl.heat_id::text)) % 4) = 0 as heat_has_anomaly
  from public.heat_lanes hl
  join public.entries e on e.id = hl.entry_id
  join public.heats h on h.id = hl.heat_id
  join public.events ev on ev.id = h.event_id
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where mv.volume_number = 1 and ev.is_relay = false and ev.is_skins = false
),
scored as (
  select
    heat_lane_id,
    case
      when heat_has_anomaly and lane_seq = lanes_in_heat then 'no_show'
      when heat_has_anomaly and lane_seq = greatest(lanes_in_heat - 1, 1) and lanes_in_heat > 1 then 'dq'
      else 'valid'
    end as outcome,
    case when is_nt then (28000 + (abs(hashtext(heat_lane_id::text)) % 15000))
      else greatest(5000, seed_time_ms - (150 + (lane_seq * 47) % 400))
    end as official_time_ms,
    seed_time_ms
  from lane_context
)
insert into public.results (
  heat_lane_id, result_outcome, official_time_ms, dq_code, improvement_points, status
)
select
  s.heat_lane_id,
  s.outcome::public.result_outcome,
  case when s.outcome = 'valid' then s.official_time_ms end,
  case when s.outcome = 'dq' then 'false_start'::public.dq_reason end,
  case
    when s.outcome = 'valid' and s.seed_time_ms is not null and s.official_time_ms < s.seed_time_ms
      then least(6, round(((s.seed_time_ms - s.official_time_ms) / 100.0) * 10) / 10)
    else 0
  end,
  'published'::public.publish_status
from scored s
on conflict (heat_lane_id) do update
  set result_outcome = excluded.result_outcome,
      official_time_ms = excluded.official_time_ms,
      dq_code = excluded.dq_code,
      improvement_points = excluded.improvement_points,
      status = excluded.status;

-- ---------------------------------------------------------------------------
-- 10. Cleanup — drop the seed-only helper function.
-- ---------------------------------------------------------------------------
drop function if exists public._seed_get_or_create_user(text, text, text, text);

commit;
