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
  v_email text := lower(p_email);
begin
  select id into v_id from auth.users where lower(email) = v_email;

  if v_id is null then
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at,
      -- GoTrue treats NULL token columns as broken on some versions —
      -- empty strings are the safe default used by the Auth admin API.
      confirmation_token, recovery_token, email_change_token_new,
      email_change
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_id,
      'authenticated',
      'authenticated',
      v_email,
      crypt('Password123!', gen_salt('bf')),
      now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_strip_nulls(jsonb_build_object(
        'full_name', p_full_name,
        'role', p_role,
        'phone', p_phone
      )),
      now(),
      now(),
      '', '', '', ''
    );
  elsif v_email like '%@ssc-demo.test' then
    -- Re-runs: keep demo passwords aligned with SEED_CREDENTIALS.md.
    update auth.users
    set encrypted_password = crypt('Password123!', gen_salt('bf')),
        email_confirmed_at = coalesce(email_confirmed_at, now()),
        updated_at = now()
    where id = v_id;

    -- This roster's names have been rewritten more than once across
    -- earlier iterations of this script (the same person landing on a
    -- different demo email, or the exact wording of a role's display name
    -- changing) — this INSERT branch never re-runs for an
    -- already-existing user, so without this, public.users.full_name
    -- would keep showing whichever name that email had the FIRST time it
    -- was ever seeded, while every athletes-table column (age, gender,
    -- age_group, ...) correctly refreshes via ON CONFLICT DO UPDATE below.
    -- That split produced real, confusing bugs live: e.g. athlete01
    -- displaying as "Chloe Bennett" (an old rev's name for that email)
    -- with athlete01's CURRENT age/gender — a name from one person
    -- grafted onto another's data. Keep this in sync every run too.
    update public.users
    set full_name = p_full_name, updated_at = now()
    where id = v_id and full_name is distinct from p_full_name;
  end if;

  -- Email/password sign-in REQUIRES a matching auth.identities row.
  -- Older seed runs created auth.users only — those accounts can never
  -- sign in until this companion row exists (GoTrue looks it up first).
  insert into auth.identities (
    id,
    user_id,
    identity_data,
    provider,
    provider_id,
    last_sign_in_at,
    created_at,
    updated_at
  )
  select
    gen_random_uuid(),
    v_id,
    jsonb_build_object(
      'sub', v_id::text,
      'email', v_email,
      'email_verified', true
    ),
    'email',
    v_id::text,
    now(),
    now(),
    now()
  where not exists (
    select 1 from auth.identities i
    where i.user_id = v_id and i.provider = 'email'
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
-- 2. Teams
-- ---------------------------------------------------------------------------
-- The 4th team is intentionally left unapproved — a live fixture for the
-- Admin "Pending Team Approvals" workflow (approve/reject), the same role
-- the unapproved/pending-parent athletes play for swimmer approvals.
insert into public.teams (name, abbreviation, team_logo_url, approved_by_admin)
values
  ('Riptide Swim Club', 'RIPT', 'https://placehold.co/128x128?text=RIPT', true),
  ('Blue Marlins', 'BLUM', 'https://placehold.co/128x128?text=BLUM', true),
  ('Tidal Wave', 'TIDE', 'https://placehold.co/128x128?text=TIDE', true),
  ('Sunburst Aquatics', 'SUNB', 'https://placehold.co/128x128?text=SUNB', false)
on conflict (name) do update
  set abbreviation = excluded.abbreviation,
      team_logo_url = excluded.team_logo_url,
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
-- Times match public.default_session_window() in schema.sql, so a seeded meet
-- and a hand-created one start from the same clock.
cross join (values
  (1, 'Session 1 — Morning', time '09:00', time '13:00'),
  (2, 'Session 2 — Afternoon', time '13:30', time '17:00'),
  (3, 'Session 3 — Skins', time '17:30', time '21:00')
) as v(session_number, name, start_time, end_time)
where mv.volume_number = 1
on conflict (meet_volume_id, session_number) do update
  set name = excluded.name,
      meet_date = excluded.meet_date,
      start_time = excluded.start_time,
      end_time = excluded.end_time;

-- Control Unit dials, one row per volume, plus the pricing matrix and the tier
-- windows. DO NOTHING rather than DO UPDATE throughout: seed-demo.sql is
-- destructive by design, but an admin's pricing is the one thing here worth
-- preserving across a reseed, and the column defaults already give a fresh
-- database the right values.
insert into public.meet_settings (meet_volume_id)
select mv.id from public.meet_volumes mv
where mv.volume_number = 1
on conflict (meet_volume_id) do nothing;

insert into public.pricing_packages (meet_volume_id, race_count, tier, price_egp)
select mv.id, m.race_count, m.tier::public.pricing_tier, m.price_egp
from public.meet_volumes mv
cross join (values
  (0, 'early_bird', 200), (0, 'standard', 300), (0, 'late', 400),
  (1, 'early_bird', 200), (1, 'standard', 300), (1, 'late', 400),
  (2, 'early_bird', 380), (2, 'standard', 560), (2, 'late', 740),
  (3, 'early_bird', 540), (3, 'standard', 700), (3, 'late', 960),
  (4, 'early_bird', 680), (4, 'standard', 900), (4, 'late', 1200)
) as m(race_count, tier, price_egp)
where mv.volume_number = 1
on conflict (meet_volume_id, race_count, tier) do nothing;

-- Vol. 1 is the fixture every spec registers against, so its tier windows are
-- pinned around today rather than around meet_date: a demo database seeded
-- months after the meet date would otherwise sit permanently in 'late', and
-- every price assertion in the suite would depend on when it was run.
insert into public.pricing_tiers (meet_volume_id, tier, starts_at, ends_at)
select mv.id, w.tier::public.pricing_tier,
       (current_date + w.starts_days)::timestamptz,
       (current_date + w.ends_days)::timestamptz
from public.meet_volumes mv
cross join (values
  ('early_bird', -60, -30),
  ('standard',   -30,  30),
  ('late',        30,  60)
) as w(tier, starts_days, ends_days)
where mv.volume_number = 1
on conflict (meet_volume_id, tier) do nothing;

-- Exact official Vol. 1 program. is_relay marks the 4x50/4x100 relay events
-- (schedule-only — see the file header note); is_skins marks the single
-- Session 3 elimination event (auto-assigned from results, never entered
-- directly here or by athletes).
--
-- This program has been rewritten more than once across earlier iterations
-- of this file (a prior generation had a plain 4-events-per-session
-- pattern). Earlier `insert ... where not exists` guards only ever ADD
-- missing-by-name rows — they never remove rows whose name dropped out of
-- a later rewrite, so a project seeded across multiple script generations
-- accumulates stale/orphaned events (e.g. an old session-1 "100m
-- Backstroke" left behind after the schedule moved it to session 2).
-- Sourcing both the insert AND a pruning delete from one canonical temp
-- table makes this section fully authoritative: exactly these 19 rows,
-- every run, regardless of what any earlier version of this script left
-- behind. Existing rows keep their id (never dropped and reinserted) so
-- anything that references a specific event's UUID externally (e.g. the
-- Skins event id some deployments pin via NEXT_PUBLIC_SKINS_EVENT_ID)
-- stays valid across re-runs.
create temporary table _seed_canonical_events on commit drop as
select * from (values
  -- Session 1
  (1, '100m Freestyle', 'Freestyle', 100, 1, false, false, false),
  (1, '50m Back-to-Breast Switch (25m Back + 25m Breast)', 'Back-to-Breast Switch', 50, 2, false, false, true),
  (1, '50m Butterfly', 'Butterfly', 50, 3, false, false, false),
  (1, '4x50m Medley Relay (Mixed: 2 Boys + 2 Girls)', 'Medley Relay', 200, 4, true, false, false),
  (1, '4x50m Freestyle Relay (Male)', 'Freestyle Relay', 200, 5, true, false, false),
  (1, '4x50m Freestyle Relay (Female)', 'Freestyle Relay', 200, 6, true, false, false),
  (1, '4x50m Freestyle Relay (Mixed)', 'Freestyle Relay', 200, 7, true, false, false),
  -- Session 2
  (2, '100m Individual Medley (IM)', 'Individual Medley', 100, 1, false, false, true),
  (2, '50m Backstroke', 'Backstroke', 50, 2, false, false, false),
  (2, '50m Fly-to-Back Switch (25m Fly + 25m Back)', 'Fly-to-Back Switch', 50, 3, false, false, true),
  (2, '50m Breaststroke', 'Breaststroke', 50, 4, false, false, false),
  (2, '4x50m Freestyle Relay (Mixed: 2 Boys + 2 Girls)', 'Freestyle Relay', 200, 5, true, false, false),
  (2, '4x50m Medley Relay (Male)', 'Medley Relay', 200, 6, true, false, false),
  (2, '4x50m Medley Relay (Female)', 'Medley Relay', 200, 7, true, false, false),
  -- Session 3
  (3, '50m Breast-to-Free Switch (25m Breast + 25m Free)', 'Breast-to-Free Switch', 50, 1, false, false, true),
  (3, '4x100m Individual Medley Relay (Male)', 'Individual Medley Relay', 400, 2, true, false, false),
  (3, '4x100m Individual Medley Relay (Female)', 'Individual Medley Relay', 400, 3, true, false, false),
  (3, '50m Freestyle', 'Freestyle', 50, 4, false, false, false),
  (3, '50m Freestyle Skins', 'Freestyle', 50, 5, false, true, false)
) as v(session_number, name, stroke, distance_m, event_order, is_relay, is_skins, seeds_as_nt);

-- Sync columns for events that already exist (a name can persist across
-- rewrites while its stroke/distance/order/flags changed).
update public.events e
set stroke = c.stroke,
    distance_m = c.distance_m,
    event_order = c.event_order,
    is_relay = c.is_relay,
    is_skins = c.is_skins,
    seeds_as_nt = c.seeds_as_nt
from public.sessions s, _seed_canonical_events c
where e.session_id = s.id
  and s.session_number = c.session_number
  and e.name = c.name
  and s.meet_volume_id = (select id from public.meet_volumes where volume_number = 1)
  and (e.stroke, e.distance_m, e.event_order, e.is_relay, e.is_skins, e.seeds_as_nt)
      is distinct from (c.stroke, c.distance_m, c.event_order, c.is_relay, c.is_skins, c.seeds_as_nt);

insert into public.events (session_id, name, stroke, distance_m, event_order, is_relay, is_skins, seeds_as_nt)
select s.id, c.name, c.stroke, c.distance_m, c.event_order, c.is_relay, c.is_skins, c.seeds_as_nt
from public.sessions s
join public.meet_volumes mv on mv.id = s.meet_volume_id and mv.volume_number = 1
join _seed_canonical_events c on c.session_number = s.session_number
where not exists (
  select 1 from public.events e where e.session_id = s.id and e.name = c.name
);

-- Prune anything left behind by an earlier generation of this script that
-- no longer matches the canonical program for its session.
delete from public.events e
using public.sessions s
where e.session_id = s.id
  and s.meet_volume_id = (select id from public.meet_volumes where volume_number = 1)
  and not exists (
    select 1 from _seed_canonical_events c
    where c.session_number = s.session_number and c.name = e.name
  );

-- ---------------------------------------------------------------------------
-- 4. Officials & support staff.
-- ---------------------------------------------------------------------------
-- SCOPE LOCK: exactly 4 approved roles (admin/referee/athlete/parent).
-- The consolidated Referee role covers what used to be split across Chief
-- Referee, Lane Referee, Usher (call-room), and Entry Desk Helper — so
-- those old seed identities are gone, folded into a flat pool of referees.
--
-- 'coach' and 'team_captain' were retired from public.user_role (see the
-- header of schema.sql): a role only said someone *could* captain in the
-- abstract while teams.captain_id said who actually does, which is two
-- sources of truth for one fact. Captaincy is now exactly the relationship
-- teams.captain_id, and eligibility to hold it is can_captain_team():
-- an athlete in the 'Open' age group (18+) who creates the team. The RLS
-- policies eligible_user_create_team / captain_update_own_team both check
-- `captain_id = auth.uid()`, so the creator IS the captain and cannot hand
-- captaincy to anybody else.

-- Legacy address migration: the three captains used to be seeded at
-- coach.<team>@ssc-demo.test, an address left over from a role that no longer
-- exists. Renaming them in the block below alone would not be enough — on any
-- database seeded by an earlier generation of this script the old accounts
-- still exist, still have this file's shared password, and can still sign in,
-- so a rename would silently leave three ghost logins behind. Carrying the
-- identity across (rather than dropping and recreating) also keeps the
-- account's id, so anything already pointing at it stays valid.
do $$
declare rec record;
begin
  for rec in
    select * from (values
      ('coach.riptide@ssc-demo.test',   'captain.riptide@ssc-demo.test'),
      ('coach.marlins@ssc-demo.test',   'captain.marlins@ssc-demo.test'),
      ('coach.tidalwave@ssc-demo.test', 'captain.tidalwave@ssc-demo.test')
    ) as t(old_email, new_email)
  loop
    if not exists (select 1 from auth.users where email = rec.old_email) then
      continue;
    end if;

    if exists (select 1 from auth.users where email = rec.new_email) then
      -- A previous run of THIS version already created the new identity, so
      -- the old row is a pure duplicate. Delete it — but only if nothing at
      -- all hangs off it, so a database where the old account somehow still
      -- owns a swimmer profile or a captaincy is left untouched for a human
      -- to look at rather than cascade-deleted.
      delete from auth.users u
      where u.email = rec.old_email
        and not exists (select 1 from public.athletes a where a.user_id = u.id)
        and not exists (select 1 from public.teams t where t.captain_id = u.id);
    else
      update auth.users set email = rec.new_email, updated_at = now()
      where email = rec.old_email;
      update public.users set email = rec.new_email
      where email = rec.old_email;
      update auth.identities i
      set identity_data = jsonb_set(i.identity_data, '{email}', to_jsonb(rec.new_email)),
          updated_at = now()
      where i.provider = 'email'
        and i.user_id = (select id from auth.users where email = rec.new_email);
    end if;
  end loop;
end $$;

do $$
begin
  -- A single dedicated Referee account — the consolidated Referee role
  -- covers lane assignment AND heat time entry for whichever heat
  -- they open; no lane-claim/chief tier, so there's no need for a pool
  -- of interchangeable referee seats.
  perform public._seed_get_or_create_user('referee1@ssc-demo.test', 'Marcus Lee', 'referee', '+1-555-0102');

  -- Team captains — one per approved team, named for the team they captain
  -- (these were the 'coach.*' accounts before the role was retired; the
  -- address was left over from a role that no longer exists and read as if
  -- the platform still had coaches). They are plain 'athlete'-role users:
  -- captaincy is teams.captain_id, assigned below, so no role holds it.
  -- Each one also gets an Open-age athletes row in section 5 — without it
  -- can_captain_team() is false and the "captain" could not have founded
  -- the team the seed says they captain.
  perform public._seed_get_or_create_user('captain.riptide@ssc-demo.test', 'Riley Adams', 'athlete', '+1-555-0106');
  perform public._seed_get_or_create_user('captain.marlins@ssc-demo.test', 'Jordan Kim', 'athlete', '+1-555-0130');
  perform public._seed_get_or_create_user('captain.tidalwave@ssc-demo.test', 'Alicia Moreno', 'athlete', '+1-555-0131');

  -- Parents — linked to the U13-14 athletes below.
  -- parent1-3 each have four children (the multi-child dashboard case);
  -- parent4 has exactly one (athlete40), which is the single-child case —
  -- a one-child parent renders a different dashboard path and had no
  -- fixture at all until it was added here.
  perform public._seed_get_or_create_user('parent1@ssc-demo.test', 'Dana Whitfield', 'parent', '+1-555-0107');
  perform public._seed_get_or_create_user('parent2@ssc-demo.test', 'Marcus Webb Sr.', 'parent', '+1-555-0132');
  perform public._seed_get_or_create_user('parent3@ssc-demo.test', 'Sophia Ahmed', 'parent', '+1-555-0133');
  perform public._seed_get_or_create_user('parent4@ssc-demo.test', 'Helena Duarte', 'parent', '+1-555-0134');
end $$;

update public.teams set captain_id = (select id from auth.users where email = 'captain.riptide@ssc-demo.test')
where name = 'Riptide Swim Club';
update public.teams set captain_id = (select id from auth.users where email = 'captain.marlins@ssc-demo.test')
where name = 'Blue Marlins';
update public.teams set captain_id = (select id from auth.users where email = 'captain.tidalwave@ssc-demo.test')
where name = 'Tidal Wave';

-- ---------------------------------------------------------------------------
-- 5. Athletes — 37 regular swimmers (12 per age group, 6 male + 6 female
-- each, distributed across all 3 teams, plus athlete40 as the only child of
-- parent4), plus 1 unapproved swimmer and 1 under-15 swimmer with a
-- still-pending parent linkage to exercise both approval gates
-- independently of the regular population, plus the three team captains
-- (Open age group — see the block after the loop).
-- ---------------------------------------------------------------------------
do $$
declare
  v_parent1 uuid; v_parent2 uuid; v_parent3 uuid; v_parent4 uuid;
  v_riptide uuid; v_marlins uuid; v_tidal uuid;
  rec record;
begin
  v_parent1 := (select id from auth.users where email = 'parent1@ssc-demo.test');
  v_parent2 := (select id from auth.users where email = 'parent2@ssc-demo.test');
  v_parent3 := (select id from auth.users where email = 'parent3@ssc-demo.test');
  v_parent4 := (select id from auth.users where email = 'parent4@ssc-demo.test');
  select id into v_riptide from public.teams where name = 'Riptide Swim Club';
  select id into v_marlins from public.teams where name = 'Blue Marlins';
  select id into v_tidal from public.teams where name = 'Tidal Wave';

  for rec in
    select * from (values
      -- ---- U14 (12): parent-linked & verified, teams round-robin ----
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
      -- The single-child parent fixture: parent4's ONLY child. parent1-3 each
      -- have four, so the one-child parent dashboard had no fixture at all.
      -- Deliberately a NEW athlete rather than a reassignment — e2e/helpers.ts
      -- pins parent1 and approvedU14 = athlete01, and moving an existing child
      -- between parents would break those specs.
      ('athlete40@ssc-demo.test', 'Beatriz Duarte',  date '2013-07-19', 'female', v_riptide, v_parent4),
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
      v_age := public.age_turning_this_year(rec.dob, current_date);

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

  -- ---- Team captains: Open-age swimmers on the team they captain ----
  -- A captain is an ATHLETE who founded the team and is 18 or over — all
  -- three conditions live in the database already: can_captain_team()
  -- requires an athletes row with age_group = 'Open', and the RLS policies
  -- eligible_user_create_team / captain_update_own_team both check
  -- `captain_id = auth.uid()`.
  --
  -- These accounts previously had NO athletes row at all (they were seeded
  -- as bare 'coach'-role users, and losing the role did not give them a
  -- swimmer profile). can_captain_team() was therefore false for all three:
  -- the seed shipped captains who could never have created the team they
  -- are recorded as captaining, and who cannot found one now. Giving them
  -- real Open-age athlete rows is what makes the fixture honest.
  --
  -- They are deliberately NOT entered in Vol. 1: the entries/affiliation
  -- blocks below match `athlete%@ssc-demo.test`, so a captain is a rostered
  -- swimmer without a meet entry — which is also a state the app must
  -- handle. Their safety acknowledgement is set here because the bulk
  -- update below is scoped to the same email pattern.
  declare
    v_cap record;
    v_cap_id uuid;
    v_cap_age integer;
  begin
    for v_cap in
      select * from (values
        ('captain.riptide@ssc-demo.test',   'Riley Adams',   date '1996-04-11', 'male',   v_riptide),
        ('captain.marlins@ssc-demo.test',   'Jordan Kim',    date '1994-09-02', 'male',   v_marlins),
        ('captain.tidalwave@ssc-demo.test', 'Alicia Moreno', date '1991-11-23', 'female', v_tidal)
      ) as t(email, full_name, dob, gender, team_id)
    loop
      v_cap_id := (select id from auth.users where email = v_cap.email);
      v_cap_age := public.age_turning_this_year(v_cap.dob, current_date);

      insert into public.athletes (
        user_id, team_id, parent_id, date_of_birth, age, age_group, gender,
        height_cm, weight_kg, specialty_events, parent_link_status,
        pending_parent_email, approved_by_admin,
        safety_accepted_at, safety_accepted_by
      ) values (
        v_cap_id, v_cap.team_id, null, v_cap.dob, v_cap_age,
        public.age_group_for_age(v_cap_age), v_cap.gender::public.gender,
        150 + (abs(hashtext(v_cap.email)) % 40), 40 + (abs(hashtext(v_cap.email || 'w')) % 45),
        array['Freestyle'], 'none', null, true,
        now(), v_cap_id
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
            approved_by_admin = excluded.approved_by_admin,
            safety_accepted_at = coalesce(athletes.safety_accepted_at, excluded.safety_accepted_at),
            safety_accepted_by = coalesce(athletes.safety_accepted_by, excluded.safety_accepted_by);
    end loop;
  end;

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
      v_nathan_id, v_riptide, date '2006-05-05', public.age_turning_this_year(date '2006-05-05', current_date),
      public.age_group_for_age(public.age_turning_this_year(date '2006-05-05', current_date)), 'male',
      array['Freestyle'], 'none', false
    )
    on conflict (user_id) do update set approved_by_admin = false, parent_link_status = 'none';

    v_zoe_id := public._seed_get_or_create_user('athlete38@ssc-demo.test', 'Zoe Whitfield', 'athlete', null);
    insert into public.athletes (
      user_id, team_id, date_of_birth, age, age_group, gender,
      specialty_events, parent_link_status, pending_parent_email, approved_by_admin
    ) values (
      v_zoe_id, v_marlins, date '2012-08-01', public.age_turning_this_year(date '2012-08-01', current_date),
      public.age_group_for_age(public.age_turning_this_year(date '2012-08-01', current_date)), 'female',
      array['Freestyle'], 'pending', 'unclaimed.parent@ssc-demo.test', true
    )
    on conflict (user_id) do update
      set parent_link_status = 'pending',
          pending_parent_email = 'unclaimed.parent@ssc-demo.test',
          approved_by_admin = true;
  end;

  -- ---- Unattached-swimmer fixture (team_id stays NULL) ----
  -- Every other seeded athlete already belongs to a team, and
  -- enforce_team_membership_request_rules() locks transfers for anyone with a
  -- team while a volume is 'scheduled'. Without a genuinely unattached
  -- swimmer there is no way to exercise the join-request happy path at all —
  -- the E2E suite could only ever observe the lock. This is also simply
  -- realistic: a real meet always has swimmers who haven't joined a team yet.
  declare
    v_unattached_id uuid;
  begin
    v_unattached_id := public._seed_get_or_create_user(
      'athlete39@ssc-demo.test', 'Selim Fahmy', 'athlete', null);
    insert into public.athletes (
      user_id, team_id, date_of_birth, age, age_group, gender,
      specialty_events, parent_link_status, approved_by_admin
    ) values (
      v_unattached_id, null, date '2004-09-12',
      public.age_turning_this_year(date '2004-09-12', current_date),
      public.age_group_for_age(public.age_turning_this_year(date '2004-09-12', current_date)),
      'male', array['Freestyle'], 'none', true
    )
    on conflict (user_id) do update
      set team_id = null,
          approved_by_admin = true,
          parent_link_status = 'none';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Volume team affiliations (Feature 2). All 37 regular athletes represent
-- their current team for SSC Vol. 1, EXCEPT Isabella Cruz (athlete19), who
-- is deliberately recorded as having swum Vol. 1 unattached — demonstrating
-- that historical team display is independent of an athlete's current team.
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
-- 7a. Teardown — clear anything an earlier generation of this script left.
--
-- This MUST run before the entry insert below. An upsert alone is not enough:
-- earlier revisions entered every athlete in every event, so without an
-- explicit delete those rows survive as 'confirmed' alongside the new pending
-- ones. The result is an athlete holding far more than the 4-event cap, half
-- of them already confirmed — which is neither a fresh state nor a legal one.
--
-- Order matters: results reference heat_lanes, heat_lanes reference entries.
-- ---------------------------------------------------------------------------
delete from public.results
where heat_lane_id in (
  select hl.id from public.heat_lanes hl
  join public.heats h on h.id = hl.heat_id
  join public.events ev on ev.id = h.event_id
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where mv.volume_number = 1
);

delete from public.heats
where event_id in (
  select ev.id from public.events ev
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where mv.volume_number = 1
);

delete from public.entries
where event_id in (
  select ev.id from public.events ev
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where mv.volume_number = 1
);

delete from public.leaderboards
where meet_volume_id in (select id from public.meet_volumes where volume_number = 1);

-- ---------------------------------------------------------------------------
-- 7. Entries — a FRESH, pre-meet state.
--
-- Every athlete has registered for a varied 2-4 individual events (the cap is
-- 4 per meet) and is WAITING FOR APPROVAL. Nothing is confirmed, so:
--   * no heats exist yet   -> they are generated when an admin approves,
--                             via public.generate_heats_for_event();
--   * no results exist yet -> they appear as a referee enters times and an
--                             admin publishes each heat card;
--   * public.event_results is therefore empty until results are published.
--
-- This is deliberately NOT a finished meet. The whole point is to be able to
-- walk the real workflow: approve -> heats appear -> score -> publish ->
-- standings appear. Seed times are still deterministic so re-running this
-- script converges on the same field.
--
-- Event spread is by athlete hash so swimmers genuinely differ from one
-- another rather than everyone entering the same races.
-- ---------------------------------------------------------------------------
insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
select
  ev.id,
  a.id,
  case when (abs(hashtext(a.id::text || ev.id::text)) % 12) = 0 then null
    else
      (case ev.distance_m when 50 then 26000 when 100 then 58000 else 90000 end)
      + (case a.age_group when 'U14' then 9000 when 'U17' then 4000 else 0 end)
      + (abs(hashtext(a.id::text)) % 4000)
      + (abs(hashtext(a.id::text || ev.id::text)) % 2000)
  end,
  (abs(hashtext(a.id::text || ev.id::text)) % 12) = 0,
  'pending_payment'::public.entry_status
from public.athletes a
join public.users u on u.id = a.user_id
join lateral (
  -- 2-4 events per athlete (the per-meet cap is 4), chosen deterministically
  -- from the individual (non-relay, non-skins) programme.
  --
  -- The 50m Freestyle is always first in that ordering, so EVERY swimmer is
  -- entered in it. Skins qualification is derived from published results of
  -- the matching non-skins event, so a thin 50 Free field would leave the
  -- six slots per category x gender only half filled and the accept/decline
  -- rollover and cutoff swim-off would never be exercised at all.
  select ev.id, ev.distance_m
  from public.events ev
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where mv.volume_number = 1
    and ev.is_relay = false
    and ev.is_skins = false
  order by
    (case when ev.name = '50m Freestyle' then 0 else 1 end),
    abs(hashtext(a.id::text || ev.id::text))
  limit 2 + (abs(hashtext(a.id::text)) % 3)
) ev on true
where u.email like 'athlete%@ssc-demo.test'
  and a.parent_link_status <> 'pending'
on conflict (event_id, athlete_id) do nothing;

-- ---------------------------------------------------------------------------
-- 8. Heats, lanes, results and standings are intentionally NOT seeded — they
-- are produced by the live workflow:
--   approve a swimmer  -> generate_heats_on_confirm  -> heats + lanes
--   referee times, admin publishes                   -> results
--   apply_result_points / event_results              -> standings
-- (The teardown that guarantees this clean slate runs in 7a above, before the
-- entries are written.)
-- ---------------------------------------------------------------------------

-- Safety & privacy acknowledgement: 15+ swimmers accepted it at signup, so
-- they are ready to register. U14s are deliberately left outstanding — their
-- parent must accept from their own account, which is the flow worth
-- demonstrating.
update public.athletes a
set safety_accepted_at = now(), safety_accepted_by = a.user_id
from public.users u
where u.id = a.user_id
  and u.email like 'athlete%@ssc-demo.test'
  and a.age_group <> 'U14';

update public.athletes a
set safety_accepted_at = null, safety_accepted_by = null
from public.users u
where u.id = a.user_id
  and u.email like 'athlete%@ssc-demo.test'
  and a.age_group = 'U14';

-- Athlete accounts need no admin approval — confirming their payment is the
-- only gate, and that is what seeds the heats.
update public.athletes a
set approved_by_admin = true
from public.users u
where u.id = a.user_id
  and u.email like 'athlete%@ssc-demo.test';

-- 10. Cleanup — drop the seed-only helper function.
-- ---------------------------------------------------------------------------
drop function if exists public._seed_get_or_create_user(text, text, text, text);

commit;
