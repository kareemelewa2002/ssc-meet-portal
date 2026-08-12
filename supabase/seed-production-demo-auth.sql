-- =============================================================================
-- Quick-login demo accounts for a LIVE database.
-- =============================================================================
-- Apply with: paste into Supabase Dashboard → SQL Editor → Run.
-- Idempotent: re-runnable any number of times.
--
-- WHAT THIS IS FOR
-- ----------------
-- supabase/seed-demo.sql cannot be run on production — it DELETES AND REBUILDS
-- every entry, heat and result belonging to a demo athlete. This script only
-- ADDS. It creates no entries, no heats and no results, and touches no
-- existing athlete, team or user other than the ones it creates itself.
--
-- The one team it does create is 'SSC Demo Squad', captained by
-- captain@ssc.com. That is deliberately a NEW team rather than an existing
-- one: captaincy is public.teams.captain_id, so adopting a real team would
-- demote whoever actually captains it.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- --------------------------------
-- It does not change elewakareem2002@gmail.com's password or any of its auth
-- records. It only guarantees that account is an admin (task 1). Your real
-- sign-in keeps working exactly as it does today.
--
-- It does not repoint app_settings.superadmin_email at admin@ssc.com. That
-- setting is what self-bootstraps the first admin on a fresh database, and
-- moving it would demote the real account.
--
-- =============================================================================
-- CORRECTIONS TO THE BRIEF THIS WAS WRITTEN FROM — please read
-- =============================================================================
-- Four of the tables named in the request do not exist in this schema, and
-- the supplied password hash is not a working hash. Both were verified
-- against the database rather than assumed.
--
-- 1. public.user_roles      -> does not exist. Roles live on public.users.role
--                              (enum user_role: admin|referee|athlete|parent).
--    public.profiles        -> does not exist. The profile table is
--                              public.users.
--    public.parents         -> does not exist. A parent is a public.users row
--                              with role = 'parent'.
--    public.parent_athletes -> does not exist. The link is a single column,
--                              public.athletes.parent_id.
--
-- 2. The hash given in the brief,
--      $2a$10$wT8K8U1h9M9Y5m.E8/E8/eJ.Z.1.1.1.1.1.1.1.1.1.1.1
--    is 54 characters. A bcrypt hash is exactly 60, and crypt() rejects this
--    one as malformed — it does NOT validate 'password123'. Hardcoding it
--    would have created eight accounts on production that nobody could sign
--    in to. This script calls crypt('password123', gen_salt('bf')) instead,
--    the same way supabase/seed-demo.sql already does, so the hash is
--    generated correctly and freshly on every run.
--
-- =============================================================================
-- TWO TRIGGERS THIS SCRIPT HAS TO WORK WITH
-- =============================================================================
-- public.handle_new_auth_user() fires on every auth.users insert and creates
-- the public.users row. It CLAMPS the requested role — a client can never ask
-- for 'admin' — so admin/referee/parent roles are applied afterwards.
--
-- public.enforce_role_change() rejects any role change unless is_admin().
-- The SQL Editor runs as postgres with no JWT, so auth.uid() is NULL and
-- is_admin() is FALSE. Section 1 promotes the real superadmin with the
-- trigger briefly disabled for that one row, then adopts that identity via
-- set_config. Section 2 does NOT rely on that having worked — on a database
-- where the superadmin has no public.users row yet there is no identity to
-- adopt, and every role update fails. (Found by running this script against
-- a schema-only database: it errored outright.) The role pass is therefore
-- guarded on its own, inside the same transaction.
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Preserve and guarantee primary admin access.
-- ---------------------------------------------------------------------------
do $$
declare
  v_superadmin_email text;
  v_id uuid;
begin
  select superadmin_email into v_superadmin_email from public.app_settings limit 1;
  v_superadmin_email := coalesce(v_superadmin_email, 'elewakareem2002@gmail.com');

  select id into v_id from public.users where lower(email) = lower(v_superadmin_email);

  if v_id is null then
    raise notice
      'Superadmin % has no public.users row yet — sign in once, then re-run. Continuing.',
      v_superadmin_email;
  else
    -- Password and auth records untouched. Role only.
    if not exists (select 1 from public.users where id = v_id and role = 'admin') then
      alter table public.users disable trigger enforce_role_change_trigger;
      update public.users set role = 'admin' where id = v_id;
      alter table public.users enable trigger enforce_role_change_trigger;
      raise notice 'Promoted % to admin.', v_superadmin_email;
    end if;

    -- Become that admin for the remainder of the transaction, so the role
    -- updates below pass enforce_role_change() without disabling anything.
    perform set_config('request.jwt.claim.sub', v_id::text, true);
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_id, 'role', 'authenticated')::text,
      true
    );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The quick-login accounts.
-- ---------------------------------------------------------------------------
-- Ages are expressed as an OFFSET FROM THE CURRENT YEAR, not as fixed dates.
-- This platform assigns age groups by the birth-year rule
-- (public.age_turning_this_year -> public.age_group_for_age), so a hardcoded
-- 2013 birthday silently drifts out of U14 as years pass. Computing the year
-- keeps each account in its intended band whenever the script is run.
--   U14  = turns 13 this year
--   U17  = turns 16 this year
--   Open = turns 22 this year
-- ---------------------------------------------------------------------------
do $$
declare
  rec record;
  v_id uuid;
  v_age integer;
  v_parent uuid;
  v_parent_multi uuid;
  v_captain uuid;
  v_team uuid;
  v_year integer := extract(year from current_date)::int;
begin
  for rec in
    select * from (values
      ('admin@ssc.com',        'SSC Admin',        'admin',   null::date,             null::text),
      ('referee@ssc.com',      'SSC Referee',      'referee', null::date,             null::text),
      ('captain@ssc.com',      'SSC Captain',      'athlete', make_date(v_year - 22, 4, 12),  'female'),
      ('athlete-u14@ssc.com',  'SSC Athlete U14',  'athlete', make_date(v_year - 13, 3, 18),  'male'),
      ('athlete-u14b@ssc.com', 'SSC Athlete U14 II','athlete', make_date(v_year - 14, 7, 4),   'female'),
      ('athlete-u17@ssc.com',  'SSC Athlete U17',  'athlete', make_date(v_year - 16, 5, 21),  'male'),
      ('athlete-open@ssc.com', 'SSC Athlete Open', 'athlete', make_date(v_year - 22, 11, 9),  'female'),
      ('parent@ssc.com',       'SSC Parent',       'parent',  null::date,             null::text),
      ('parent-multi@ssc.com', 'SSC Parent Multi', 'parent',  null::date,             null::text)
    ) as t(email, full_name, role, dob, gender)
  loop
    select id into v_id from auth.users where lower(email) = rec.email;

    if v_id is null then
      v_id := gen_random_uuid();
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at,
        -- GoTrue treats NULL token columns as broken on some versions;
        -- empty strings are what the Auth admin API writes.
        confirmation_token, recovery_token, email_change_token_new, email_change
      ) values (
        '00000000-0000-0000-0000-000000000000',
        v_id, 'authenticated', 'authenticated', rec.email,
        crypt('password123', gen_salt('bf')),
        now(),
        '{"provider":"email","providers":["email"]}'::jsonb,
        jsonb_strip_nulls(jsonb_build_object('full_name', rec.full_name, 'role', rec.role)),
        now(), now(), '', '', '', ''
      );
    else
      -- Re-run: realign the password and confirmation, leave everything else.
      update auth.users
      set encrypted_password = crypt('password123', gen_salt('bf')),
          email_confirmed_at = coalesce(email_confirmed_at, now()),
          confirmation_token = coalesce(confirmation_token, ''),
          recovery_token = coalesce(recovery_token, ''),
          email_change_token_new = coalesce(email_change_token_new, ''),
          email_change = coalesce(email_change, ''),
          updated_at = now()
      where id = v_id;
    end if;

    -- GoTrue will not authenticate an email/password user without this row.
    insert into auth.identities (
      id, user_id, identity_data, provider, provider_id,
      last_sign_in_at, created_at, updated_at
    )
    select
      gen_random_uuid(), v_id,
      jsonb_build_object('sub', v_id::text, 'email', rec.email, 'email_verified', true),
      'email', v_id::text, now(), now(), now()
    where not exists (
      select 1 from auth.identities i where i.user_id = v_id and i.provider = 'email'
    );

    -- public.users is created by handle_new_auth_user(); this covers a row
    -- that predates the trigger, and keeps the display name aligned.
    insert into public.users (id, email, full_name, role)
    values (v_id, rec.email, rec.full_name, 'athlete')
    on conflict (id) do update set full_name = excluded.full_name;

    if rec.dob is not null then
      v_age := public.age_turning_this_year(rec.dob, current_date);
      insert into public.athletes (
        user_id, date_of_birth, age, age_group, gender,
        specialty_events, parent_link_status, approved_by_admin
      ) values (
        v_id, rec.dob, greatest(v_age, 13),
        public.age_group_for_age(greatest(v_age, 13)),
        rec.gender::public.gender,
        array['Freestyle'], 'none', true
      )
      on conflict (user_id) do update
        set date_of_birth = excluded.date_of_birth,
            age = excluded.age,
            age_group = excluded.age_group,
            gender = excluded.gender;

      -- canSubmitEntries() (lib/register.ts) blocks entry when
      -- safety_accepted_at is null — for EVERY athlete, not only under-15s.
      -- Without this the captain, U17 and Open demo accounts could sign in
      -- and then be refused at registration, which is not much of a demo.
      -- The U14s are re-stamped as parent-accepted further down, which is
      -- the route their age group actually requires.
      update public.athletes
      set safety_accepted_at = coalesce(safety_accepted_at, now()),
          safety_accepted_by = coalesce(safety_accepted_by, v_id)
      where user_id = v_id;
    end if;
  end loop;

  -- -------------------------------------------------------------------------
  -- Roles, in one guarded pass.
  --
  -- handle_new_auth_user() clamps every requested role, so admin / referee /
  -- parent have to be applied afterwards — and enforce_role_change() rejects
  -- that unless is_admin(). Adopting the superadmin identity in section 1
  -- covers the normal case, but NOT a database where that account has no
  -- public.users row yet: is_admin() is then false and every update below
  -- fails with "Only an admin may change a user's role." (Caught by running
  -- this script against a schema-only database — it failed outright.)
  --
  -- So the guard does not depend on it. The trigger is disabled around this
  -- one statement and re-enabled immediately. It is inside the surrounding
  -- transaction, so a failure anywhere rolls the whole thing back rather
  -- than leaving the trigger off.
  -- -------------------------------------------------------------------------
  alter table public.users disable trigger enforce_role_change_trigger;
  update public.users u
  set role = v.role::public.user_role
  from (values
    ('admin@ssc.com', 'admin'),
    ('referee@ssc.com', 'referee'),
    ('parent@ssc.com', 'parent'),
    ('parent-multi@ssc.com', 'parent')
  ) as v(email, role)
  where u.email = v.email and u.role is distinct from v.role::public.user_role;
  alter table public.users enable trigger enforce_role_change_trigger;

  -- -------------------------------------------------------------------------
  -- Parent links. One column, public.athletes.parent_id — there is no
  -- parent_athletes join table in this schema.
  -- -------------------------------------------------------------------------
  select id into v_parent from public.users where email = 'parent@ssc.com';
  select id into v_parent_multi from public.users where email = 'parent-multi@ssc.com';

  -- parent@ssc.com -> the U14 swimmer.
  update public.athletes a
  set parent_id = v_parent,
      parent_link_status = 'verified',
      -- Under-15s cannot enter a meet without this on file, so a demo parent
      -- account that could not actually be used to enter would be no demo.
      safety_accepted_at = coalesce(a.safety_accepted_at, now()),
      safety_accepted_by = v_parent
  from public.users u
  where u.id = a.user_id and u.email = 'athlete-u14@ssc.com';

  -- parent-multi@ssc.com -> a U14, a U17 and an Open swimmer. Spanning all
  -- three bands matters: the under-15 gates (parent linkage, parent-accepted
  -- safety) only exist for U14, so a multi-child parent without one cannot
  -- exercise the case their dashboard is really for.
  update public.athletes a
  set parent_id = v_parent_multi,
      parent_link_status = 'verified',
      safety_accepted_by = case
        when a.age_group = 'U14' then v_parent_multi
        else a.safety_accepted_by
      end
  from public.users u
  where u.id = a.user_id
    and u.email in ('athlete-u14b@ssc.com', 'athlete-u17@ssc.com', 'athlete-open@ssc.com');

  -- -------------------------------------------------------------------------
  -- Captaincy for captain@ssc.com.
  --
  -- WITHOUT THIS THE CAPTAIN ACCOUNT IS NOT A CAPTAIN. Captaincy in this
  -- schema is a relationship — public.teams.captain_id — not a role, and
  -- nothing above sets it. The account signed in fine and looked correct in
  -- every listing, but:
  --
  --   * useMyPortals() found no captained team, so neither the header nor the
  --     home page ever offered a "Captain Portal" link, and
  --   * /captain itself, if reached by typing the URL, showed "No team
  --     currently lists you as its captain".
  --
  -- The visible symptom was a captain account that only ever had an athlete
  -- dashboard.
  --
  -- A DEDICATED TEAM, NOT AN EXISTING ONE. This runs on production, where
  -- real teams have real captains. Pointing captain_id at whichever team came
  -- back first would silently demote a real person from their own team, so
  -- this creates a team that belongs to the demo accounts and touches no
  -- other row.
  -- -------------------------------------------------------------------------
  select id into v_captain from public.users where email = 'captain@ssc.com';

  if v_captain is not null then
    -- approved_by_admin is set on INSERT, where no trigger guards it.
    -- enforce_team_approval_change() only fires on UPDATE, and only when the
    -- value actually changes — so the conflict branch deliberately leaves it
    -- alone rather than needing the trigger disabled.
    insert into public.teams (name, abbreviation, captain_id, approved_by_admin)
    values ('SSC Demo Squad', 'DEMO', v_captain, true)
    on conflict (name) do update set captain_id = excluded.captain_id
    returning id into v_team;

    if v_team is null then
      select id into v_team from public.teams where name = 'SSC Demo Squad';
    end if;

    -- A captain competes too, so put them on their own roster: /captain
    -- renders their entries and fees alongside the team's.
    update public.athletes set team_id = v_team where user_id = v_captain;

    -- The demo swimmers join the squad, so Roster & Contacts, the relay
    -- builder and the join-request queue all have something real to show. A
    -- captain dashboard whose every panel is empty is indistinguishable from
    -- a broken one. Scoped to accounts this script created — no existing
    -- athlete is moved off their own team.
    update public.athletes a
    set team_id = v_team
    from public.users u
    where u.id = a.user_id
      and u.email in (
        'athlete-u14@ssc.com', 'athlete-u14b@ssc.com',
        'athlete-u17@ssc.com', 'athlete-open@ssc.com'
      )
      and a.team_id is distinct from v_team;
  end if;
end $$;

commit;

-- =============================================================================
-- Verification — every row should read as expected.
-- =============================================================================
select
  u.email,
  u.role                                   as app_role,
  coalesce(a.age_group::text, '—')         as age_group,
  coalesce(t.name, '—')                    as team,
  -- The column that decides whether /captain works at all.
  (ct.id is not null)                      as captains_a_team,
  coalesce(p.email, '—')                   as parent,
  (i.id is not null)                       as has_identity,
  (au.encrypted_password = crypt('password123', au.encrypted_password)) as password_ok
from public.users u
left join public.athletes a on a.user_id = u.id
left join public.teams t on t.id = a.team_id
left join public.teams ct on ct.captain_id = u.id
left join public.users p on p.id = a.parent_id
left join auth.users au on au.id = u.id
left join auth.identities i on i.user_id = u.id and i.provider = 'email'
where u.email like '%@ssc.com'
order by u.email;

-- The real admin, untouched apart from its role.
select email, role as app_role from public.users
where lower(email) = lower(coalesce(
  (select superadmin_email from public.app_settings limit 1),
  'elewakareem2002@gmail.com'
));
