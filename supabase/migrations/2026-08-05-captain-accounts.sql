-- =============================================================================
-- Captain account migration — safe to run on a LIVE meet database.
-- =============================================================================
-- Apply with: psql "$DATABASE_URL" -f supabase/migrations/2026-08-05-captain-accounts.sql
--         or: paste into the Supabase SQL Editor.
--
-- WHY THIS EXISTS SEPARATELY FROM seed-demo.sql
-- --------------------------------------------
-- The captain rename and the captain/parent fixtures live in seed-demo.sql,
-- but that file DELETES AND REBUILDS every entry, heat and result belonging to
-- an @ssc-demo.test athlete. On a database with a meet already swum on it,
-- running it to pick up an account rename would destroy the results.
--
-- This script does the account changes and NOTHING else. It touches no entry,
-- no heat, no result, and no athlete other than the five named below. It is
-- idempotent: run it as many times as you like.
--
-- WHAT IT DOES
-- ------------
--   1. Renames coach.<team>@ssc-demo.test -> captain.<team>@ssc-demo.test,
--      carrying the SAME user id across so teams.captain_id, and anything else
--      already pointing at those accounts, stays valid.
--   2. Gives each captain an Open-age athletes row. They had none, which meant
--      public.can_captain_team() was FALSE for all three: the data said they
--      captained a team they could never have founded, and they could not
--      create one now.
--   3. Adds parent4@ssc-demo.test with exactly one child, athlete40 — the
--      single-child parent case, which had no fixture (parent1-3 have four
--      each). athlete40 gets NO meet entries; this script does not enter
--      anyone in anything.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 0. Local get-or-create helper. seed-demo.sql has its own copy and drops it
-- at the end, so this script cannot borrow it — this one is dropped below too
-- and never becomes part of the application schema.
-- ---------------------------------------------------------------------------
create or replace function public._ssc_get_or_create_demo_user(
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
      -- GoTrue treats NULL token columns as broken on some versions.
      confirmation_token, recovery_token, email_change_token_new, email_change
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated',
      v_email, crypt('Password123!', gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_strip_nulls(jsonb_build_object(
        'full_name', p_full_name, 'role', p_role, 'phone', p_phone)),
      now(), now(), '', '', '', ''
    );
  end if;

  -- Email/password sign-in REQUIRES a matching auth.identities row; an
  -- auth.users row on its own can never log in.
  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  )
  select
    gen_random_uuid(), v_id,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', v_id::text, now(), now(), now()
  where not exists (
    select 1 from auth.identities i where i.user_id = v_id and i.provider = 'email'
  );

  return v_id;
end;
$fn$;

-- Authenticate as the configured superadmin so the admin-only triggers on
-- public.users / public.athletes accept these writes. Local to this
-- transaction; reverts on commit.
do $$
declare v_admin_id uuid;
begin
  select u.id into v_admin_id
  from auth.users u
  join public.app_settings s on s.id
  where lower(u.email) = lower(s.superadmin_email);

  if v_admin_id is null then
    raise exception
      'No superadmin account found — set app_settings.superadmin_email first.';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_admin_id::text, 'role', 'authenticated')::text,
    true
  );
end $$;

-- ---------------------------------------------------------------------------
-- 1. Rename the three captain accounts, preserving their user ids.
-- ---------------------------------------------------------------------------
-- Renaming in place rather than creating new accounts is the whole point: a
-- drop-and-recreate would orphan teams.captain_id and silently un-captain
-- every team.
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
    if not exists (select 1 from auth.users where lower(email) = rec.old_email) then
      continue;  -- already renamed, or never existed
    end if;

    if exists (select 1 from auth.users where lower(email) = rec.new_email) then
      -- Both exist: the new one is authoritative and the old is a leftover
      -- that can still be signed into with the shared demo password. Remove
      -- it, but ONLY if nothing hangs off it — a stale row that somehow still
      -- owns a swimmer or a captaincy is left alone for a human to look at
      -- rather than cascade-deleted.
      delete from auth.users u
      where lower(u.email) = rec.old_email
        and not exists (select 1 from public.athletes a where a.user_id = u.id)
        and not exists (select 1 from public.teams t where t.captain_id = u.id);
    else
      update auth.users set email = rec.new_email, updated_at = now()
      where lower(email) = rec.old_email;

      update public.users set email = rec.new_email
      where lower(email) = rec.old_email;

      -- Sign-in reads auth.identities, not auth.users — miss this and the
      -- account renames but can no longer log in.
      update auth.identities i
      set identity_data = jsonb_set(i.identity_data, '{email}', to_jsonb(rec.new_email)),
          updated_at = now()
      where i.provider = 'email'
        and i.user_id = (select id from auth.users where lower(email) = rec.new_email);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Give each captain the Open-age athletes row they never had.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cap record;
  v_cap_id uuid;
  v_cap_age integer;
  v_team_id uuid;
begin
  for v_cap in
    select * from (values
      ('captain.riptide@ssc-demo.test',   date '1996-04-11', 'male',   'Riptide Swim Club'),
      ('captain.marlins@ssc-demo.test',   date '1994-09-02', 'male',   'Blue Marlins'),
      ('captain.tidalwave@ssc-demo.test', date '1991-11-23', 'female', 'Tidal Wave')
    ) as t(email, dob, gender, team_name)
  loop
    select id into v_cap_id from auth.users where lower(email) = v_cap.email;
    select id into v_team_id from public.teams where name = v_cap.team_name;
    continue when v_cap_id is null or v_team_id is null;

    v_cap_age := public.age_turning_this_year(v_cap.dob, current_date);

    insert into public.athletes (
      user_id, team_id, parent_id, date_of_birth, age, age_group, gender,
      height_cm, weight_kg, specialty_events, parent_link_status,
      pending_parent_email, approved_by_admin,
      safety_accepted_at, safety_accepted_by
    ) values (
      v_cap_id, v_team_id, null, v_cap.dob, v_cap_age,
      public.age_group_for_age(v_cap_age), v_cap.gender::public.gender,
      150 + (abs(hashtext(v_cap.email)) % 40), 40 + (abs(hashtext(v_cap.email || 'w')) % 45),
      array['Freestyle'], 'none', null, true,
      now(), v_cap_id
    )
    on conflict (user_id) do update
      set team_id = excluded.team_id,
          date_of_birth = excluded.date_of_birth,
          age = excluded.age,
          age_group = excluded.age_group,
          gender = excluded.gender,
          approved_by_admin = excluded.approved_by_admin,
          safety_accepted_at = coalesce(athletes.safety_accepted_at, excluded.safety_accepted_at),
          safety_accepted_by = coalesce(athletes.safety_accepted_by, excluded.safety_accepted_by);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The single-child parent fixture: parent4 -> athlete40, and nothing else.
-- ---------------------------------------------------------------------------
-- Deliberately a NEW parent and a NEW swimmer rather than moving one of
-- parent1-3's four children: reassigning an existing child would change data
-- other fixtures and specs already depend on.
do $$
declare
  v_parent_id uuid;
  v_child_id uuid;
  v_team_id uuid;
  v_age integer;
  v_dob date := date '2013-07-19';
begin
  select id into v_team_id from public.teams where name = 'Riptide Swim Club';
  if v_team_id is null then
    raise notice 'Riptide Swim Club not found — skipping the parent4 fixture.';
    return;
  end if;

  v_parent_id := public._ssc_get_or_create_demo_user(
    'parent4@ssc-demo.test', 'Helena Duarte', 'parent', '+1-555-0134');
  v_child_id := public._ssc_get_or_create_demo_user(
    'athlete40@ssc-demo.test', 'Beatriz Duarte', 'athlete', null);

  v_age := public.age_turning_this_year(v_dob, current_date);

  insert into public.athletes (
    user_id, team_id, parent_id, date_of_birth, age, age_group, gender,
    height_cm, weight_kg, specialty_events, parent_link_status,
    pending_parent_email, approved_by_admin,
    safety_accepted_at, safety_accepted_by
  ) values (
    v_child_id, v_team_id, v_parent_id, v_dob, v_age,
    public.age_group_for_age(v_age), 'female',
    152, 44, array['Freestyle'], 'verified', null, true,
    now(), v_parent_id
  )
  on conflict (user_id) do update
    set team_id = excluded.team_id,
        parent_id = excluded.parent_id,
        date_of_birth = excluded.date_of_birth,
        age = excluded.age,
        age_group = excluded.age_group,
        parent_link_status = excluded.parent_link_status,
        approved_by_admin = excluded.approved_by_admin;
end $$;

-- The helper is scaffolding, not schema — leaving it behind would put a
-- password-setting function on the live database permanently.
drop function if exists public._ssc_get_or_create_demo_user(text, text, text, text);

commit;

-- ---------------------------------------------------------------------------
-- Verification — read this output before trusting the run.
-- ---------------------------------------------------------------------------
-- Every team must show a captain.* email with age_group 'Open'. An empty
-- age_group means can_captain_team() is still false for that account.
select
  t.name                            as team,
  coalesce(u.email, '(no captain)') as captain,
  case
    -- A team with no captain at all is a normal state (an unapproved team
    -- nobody has founded yet), not a failure — say so, rather than reporting
    -- an eligibility problem for a person who does not exist.
    when u.id is null then 'n/a — team has no captain'
    when a.id is null then 'NO ATHLETE ROW — can_captain_team() is FALSE'
    else a.age_group::text
  end                               as eligibility
from public.teams t
left join public.users u    on u.id = t.captain_id
left join public.athletes a on a.user_id = u.id
order by t.name;

-- parent4 must have exactly one child; parent1-3 keep theirs untouched.
select p.email as parent, count(a.id) as children
from public.users p
left join public.athletes a on a.parent_id = p.id
where p.email like 'parent%@ssc-demo.test'
group by p.email
order by p.email;
