-- =============================================================================
-- Sprint Swimming Challenge (SSC) — Production Schema & RLS
-- Target: Supabase (PostgreSQL 15+)
-- =============================================================================
-- Apply with: supabase db push  /  psql -f supabase/schema.sql
-- =============================================================================

create extension if not exists pgcrypto;

-- =============================================================================
-- 1. ENUM TYPES
-- =============================================================================

-- SCOPE LOCK: exactly 5 approved roles. Older databases may still carry
-- 'usher', 'entry_helper', or 'team_captain' from a prior schema generation
-- (Postgres enums can only ever grow via ALTER TYPE ... ADD VALUE, never
-- shrink) — the migration block below downgrades any user still on one of
-- those to its replacement (usher/entry_helper -> referee, team_captain ->
-- coach, since teams.captain_id already carries "who manages this team"
-- independently of the role column) before the type is rebuilt clean.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_role') then
    create type public.user_role as enum (
      'admin',
      'referee',
      'coach',
      'athlete',
      'parent'
    );
  else
    if exists (
      select 1 from pg_enum
      where enumtypid = (select oid from pg_type where typname = 'user_role')
        and enumlabel in ('usher', 'entry_helper', 'team_captain')
    ) then
      -- Every RLS policy on public.users is recreated later in this script
      -- (idempotent drop-if-exists/create pattern) — safe to drop them all
      -- here rather than track down exactly which ones reference role
      -- directly (ALTER COLUMN TYPE refuses to run while any do).
      declare pol record;
      begin
        for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'users' loop
          execute format('drop policy if exists %I on public.users', pol.policyname);
        end loop;
      end;
      alter type public.user_role rename to user_role_old;
      create type public.user_role as enum ('admin', 'referee', 'coach', 'athlete', 'parent');
      alter table public.users alter column role drop default;
      alter table public.users alter column role type public.user_role using (
        case role::text
          when 'usher' then 'referee'
          when 'entry_helper' then 'referee'
          when 'team_captain' then 'coach'
          else role::text
        end
      )::public.user_role;
      alter table public.users alter column role set default 'athlete';
      -- cascade: current_role()/is_admin()/etc. still return the old type
      -- at this point — all of them are recreated later in this script.
      drop type public.user_role_old cascade;
    end if;
  end if;
end $$;

-- Roles a member of the public may select for themselves at sign-up.
-- 'admin' is intentionally excluded — grantable only by an existing admin.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'public_signup_role') then
    create type public.public_signup_role as enum (
      'athlete',
      'parent',
      'coach',
      'referee'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'age_group') then
    create type public.age_group as enum (
      'U14',
      'U17',
      'Open'
    );
  end if;
end $$;

-- Idempotent rename for databases created before this bracket was renamed
-- from 'U13_14' to 'U14' (same ages, 13-14 — cosmetic rename only).
do $$
begin
  if exists (
    select 1 from pg_enum
    where enumlabel = 'U13_14'
      and enumtypid = (select oid from pg_type where typname = 'age_group')
  ) then
    alter type public.age_group rename value 'U13_14' to 'U14';
  end if;
end $$;

-- Used for heats.status and results.status
do $$
begin
  if not exists (select 1 from pg_type where typname = 'publish_status') then
    create type public.publish_status as enum (
      'draft',
      'published'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_status') then
    create type public.membership_status as enum (
      'pending',
      'accepted'
    );
  end if;
end $$;

-- The two heat-scheduling phases: U13-14 swims first, U17 + Open swim
-- together afterward (see lib/seeding.ts).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'heat_group') then
    create type public.heat_group as enum (
      'U13_14',
      'U17_OPEN'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'dq_reason') then
    create type public.dq_reason as enum (
      'false_start',
      'stroke_infraction',
      'turn_infraction',
      'turn_stroke_violation',
      'finish_infraction',
      'unsporting_conduct',
      'other'
    );
  end if;
end $$;

-- Explicit outcome for a recorded heat result. DQ and NS both score 0
-- placement/improvement points; NS is additionally excluded from Skins
-- qualification ranking.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'result_outcome') then
    create type public.result_outcome as enum (
      'valid',
      'dq',
      'no_show'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'skins_response') then
    create type public.skins_response as enum (
      'pending',
      'accepted',
      'declined'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'gender') then
    create type public.gender as enum (
      'male',
      'female'
    );
  end if;
end $$;

-- 'planned'   -> future volume with no confirmed date yet ("Coming Soon").
-- 'scheduled' -> has a real meet_date, not yet completed.
-- 'completed' -> the meet has happened; results are historical.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'volume_status') then
    create type public.volume_status as enum (
      'planned',
      'scheduled',
      'completed'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'attendance_status') then
    create type public.attendance_status as enum (
      'pending',
      'present',
      'absent'
    );
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'award_type') then
    create type public.award_type as enum (
      'best_swimmer',
      'most_improved'
    );
  end if;
end $$;

-- Under-15 athletes require a parent/guardian on file before they can enter
-- any meet volume. 'none' = athlete is 15+, no linkage required.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'parent_link_status') then
    create type public.parent_link_status as enum (
      'none',
      'pending',
      'verified'
    );
  end if;
end $$;

-- Meet event registration entries start unpaid; only an admin (payment
-- webhook / manual confirmation) may move one to 'confirmed'.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'entry_status') then
    create type public.entry_status as enum (
      'pending_payment',
      'confirmed'
    );
  end if;
end $$;

-- =============================================================================
-- 2. CORE TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- app_settings — single-row configuration table. Holds the email of the
-- system creator (the only account allowed to self-bootstrap as 'admin').
-- ---------------------------------------------------------------------------
create table if not exists public.app_settings (
  id boolean primary key default true constraint app_settings_singleton check (id),
  superadmin_email text not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_settings is
  'Singleton config row. superadmin_email is the ONLY email allowed to '
  'self-bootstrap into the admin role on sign-up.';

-- ---------------------------------------------------------------------------
-- users — extends auth.users with SSC-specific profile & role data.
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  phone text,
  -- Optional deck credential / public profile photo (ushers, athletes, officials).
  profile_image_url text,
  role public.user_role not null default 'athlete',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.users.role is
  'CRITICAL: admin can only be set by (a) the configured superadmin email '
  'at first sign-up, or (b) an existing admin updating another user''s row. '
  'Enforced by public.enforce_role_change() below — never trust client input.';

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------
create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  abbreviation text,
  team_logo_url text,
  captain_id uuid references public.users (id) on delete set null,
  -- Teams exist permanently on the platform, independent of any meet volume.
  -- Pending admin approval in /admin before they can be selected for entries.
  approved_by_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Terminology sweep: "Club" -> "Team" everywhere, including this column
-- (idempotent — only runs if an older database still has the old name).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'teams' and column_name = 'club_logo_url'
  ) then
    alter table public.teams rename column club_logo_url to team_logo_url;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- team_memberships
-- ---------------------------------------------------------------------------
create table if not exists public.team_memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  status public.membership_status not null default 'pending',
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  unique (team_id, user_id)
);

-- ---------------------------------------------------------------------------
-- athletes
-- ---------------------------------------------------------------------------
create table if not exists public.athletes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  parent_id uuid references public.users (id) on delete set null,
  date_of_birth date not null,
  -- The age the swimmer turns in the signup calendar year (see
  -- public.age_turning_this_year()), not their exact chronological age —
  -- this is what age_group is derived from, and what owns_athlete()'s
  -- parent-linkage window checks. NEVER used for historical performance
  -- display (see public.age_at_date() and the All-Time views, which always
  -- derive age from date_of_birth + the meet's actual date).
  age integer not null check (age >= 13 and age < 120),
  age_group public.age_group not null,
  gender public.gender not null,
  height_cm numeric(5, 1) check (height_cm is null or height_cm > 0),
  weight_kg numeric(5, 1) check (weight_kg is null or weight_kg > 0),
  specialty_events text[] not null default '{}',
  -- Under-15 parent/guardian linkage (see public.parent_link_status).
  parent_link_status public.parent_link_status not null default 'none',
  pending_parent_email text,
  -- New swimmer profiles stay unapproved until an admin reviews them.
  -- Unapproved athletes may edit their profile but cannot submit meet entries.
  approved_by_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent column add for databases that already had athletes without approval.
alter table public.athletes
  add column if not exists approved_by_admin boolean not null default false;

comment on column public.athletes.parent_id is
  'Optional. Grants that parent RLS management rights over this athlete''s '
  'entries when age < 15 (see entries RLS policies).';

comment on column public.athletes.pending_parent_email is
  'Set when a swimmer under 15 names a parent/guardian email that has no '
  'account yet. Cleared once that email signs up and parent_id is linked '
  '(parent_link_status moves pending -> verified).';

-- ---------------------------------------------------------------------------
-- meet_volumes — the SSC series is a numbered sequence of meets ("SSC Vol.
-- 1", "SSC Vol. 2", ...). Each volume gets its own isolated leaderboard;
-- the series standing is the sum across every volume (see
-- public.series_leaderboards below).
-- ---------------------------------------------------------------------------
create table if not exists public.meet_volumes (
  id uuid primary key default gen_random_uuid(),
  volume_number integer not null unique check (volume_number >= 1),
  name text not null,
  meet_date date,
  status public.volume_status not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- volume_team_affiliations — which team an athlete represented for a given
-- SSC volume. An athlete's "current" team (athletes.team_id) can change
-- between volumes, but historical result ledgers must keep showing the team
-- they actually swam for at the time — this table is that permanent record,
-- one row per athlete per volume (null team_id = competed unattached).
-- ---------------------------------------------------------------------------
create table if not exists public.volume_team_affiliations (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (athlete_id, meet_volume_id)
);

create index if not exists volume_team_affiliations_athlete_idx
  on public.volume_team_affiliations (athlete_id);
create index if not exists volume_team_affiliations_volume_idx
  on public.volume_team_affiliations (meet_volume_id);

-- ---------------------------------------------------------------------------
-- sessions — the 3 sessions of a single meet volume.
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,
  session_number integer not null check (session_number in (1, 2, 3)),
  name text not null,
  meet_date date not null,
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  unique (meet_volume_id, session_number)
);

create index if not exists sessions_meet_volume_id_idx on public.sessions (meet_volume_id);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  name text not null,
  stroke text not null,
  distance_m integer not null check (distance_m > 0),
  event_order integer not null default 0,
  is_skins boolean not null default false,
  -- Relay events (4x50m/4x100m, Male/Female/Mixed) are scheduled and
  -- displayed like any other event, but individual athletes never
  -- self-register for them the way they do 1-per-lane races — there is no
  -- relay-team-of-4 entry model. Kept distinct from is_skins (which DOES
  -- have an auto-assignment pipeline) so seeding/registration UIs can tell
  -- "no direct entries by design" apart from "not yet seeded."
  is_relay boolean not null default false,
  created_at timestamptz not null default now()
);

-- Idempotent column add for databases created before is_relay existed.
alter table public.events
  add column if not exists is_relay boolean not null default false;

create index if not exists events_session_id_idx on public.events (session_id);

-- ---------------------------------------------------------------------------
-- entries — event registrations
-- ---------------------------------------------------------------------------
create table if not exists public.entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  seed_time_ms integer,
  is_nt boolean not null default false,
  status public.entry_status not null default 'pending_payment',
  -- Snapshot of the athlete's age group AS OF this volume's meet_date,
  -- computed by public.set_entry_age_group() below. This — not the athlete's
  -- (mutable, current) age_group column — is what heat seeding and
  -- leaderboard categorization use, so a swimmer aging into a new bracket
  -- never rewrites which bracket their past entries competed in.
  age_group_at_entry public.age_group,
  created_at timestamptz not null default now(),
  unique (event_id, athlete_id),
  constraint entries_seed_time_consistency check (
    (is_nt = true and seed_time_ms is null) or
    (is_nt = false and seed_time_ms is not null and seed_time_ms > 0)
  )
);

create index if not exists entries_event_id_idx on public.entries (event_id);
create index if not exists entries_athlete_id_idx on public.entries (athlete_id);
create index if not exists entries_status_idx on public.entries (status);

-- ---------------------------------------------------------------------------
-- heats & heat_lanes — 6 lanes per heat.
-- ---------------------------------------------------------------------------
create table if not exists public.heats (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  heat_group public.heat_group not null,
  heat_number integer not null,
  heat_order integer not null default 0,
  status public.publish_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, heat_number)
);

create index if not exists heats_event_id_idx on public.heats (event_id);
create index if not exists heats_status_idx on public.heats (status);

create table if not exists public.heat_lanes (
  id uuid primary key default gen_random_uuid(),
  heat_id uuid not null references public.heats (id) on delete cascade,
  lane_number integer not null check (lane_number between 1 and 6),
  entry_id uuid references public.entries (id) on delete cascade,
  -- Call-room check-in by Ushers before the heat starts behind the blocks.
  attendance_status public.attendance_status not null default 'pending',
  attendance_marked_at timestamptz,
  attendance_marked_by uuid references public.users (id) on delete set null,
  unique (heat_id, lane_number),
  unique (heat_id, entry_id)
);

create index if not exists heat_lanes_heat_id_idx on public.heat_lanes (heat_id);
create index if not exists heat_lanes_attendance_idx on public.heat_lanes (attendance_status);

-- ---------------------------------------------------------------------------
-- results
-- ---------------------------------------------------------------------------
create table if not exists public.results (
  id uuid primary key default gen_random_uuid(),
  heat_lane_id uuid not null unique references public.heat_lanes (id) on delete cascade,
  -- null while still an incomplete draft; required once published.
  result_outcome public.result_outcome,
  official_time_ms integer,
  finish_place integer check (finish_place is null or finish_place between 1 and 6),
  dq_code public.dq_reason,
  is_no_show boolean generated always as (result_outcome = 'no_show') stored,
  placement_points numeric(6, 2) not null default 0,
  improvement_points numeric(6, 2) not null default 0,
  status public.publish_status not null default 'draft',
  recorded_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint results_outcome_consistency check (
    (
      result_outcome is null
      and status = 'draft'
      and official_time_ms is null
      and dq_code is null
      and finish_place is null
    ) or (
      result_outcome = 'valid'
      and dq_code is null
      and (official_time_ms is not null or finish_place is not null)
    ) or (
      result_outcome = 'dq'
      and dq_code is not null
      and official_time_ms is null
      and finish_place is null
    ) or (
      result_outcome = 'no_show'
      and dq_code is null
      and official_time_ms is null
      and finish_place is null
    )
  )
);

create index if not exists results_status_idx on public.results (status);
create index if not exists results_outcome_idx on public.results (result_outcome);

-- ---------------------------------------------------------------------------
-- skins_qualifications — accept / decline responses for Session 3 Skins.
-- Athletes never self-register for skins events; invitations are created
-- from published meet results and roll over when a qualifier declines.
-- ---------------------------------------------------------------------------
create table if not exists public.skins_qualifications (
  id uuid primary key default gen_random_uuid(),
  skins_event_id uuid not null references public.events (id) on delete cascade,
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  category public.age_group not null,
  source_rank integer not null check (source_rank >= 1),
  best_time_ms integer not null check (best_time_ms > 0),
  response public.skins_response not null default 'pending',
  responded_at timestamptz,
  responded_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (skins_event_id, athlete_id, category)
);

create index if not exists skins_qualifications_event_idx
  on public.skins_qualifications (skins_event_id, category, source_rank);

-- ---------------------------------------------------------------------------
-- leaderboards — dual tracking of Placement Points & Improvement Points.
--
-- category = 'U14' | 'U17'     -> only athletes native to that age group.
-- category = 'Open'           -> ALL athletes across every age group,
--                                 ranked together (per Results Filter rule).
-- Every athlete accumulates points into their native-age-group category AND
-- into 'Open' (see public.apply_result_points() below).
-- ---------------------------------------------------------------------------
create table if not exists public.leaderboards (
  id uuid primary key default gen_random_uuid(),
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  category public.age_group not null,
  placement_points numeric(8, 2) not null default 0,
  improvement_points numeric(8, 2) not null default 0,
  total_points numeric(8, 2) generated always as (placement_points + improvement_points) stored,
  updated_at timestamptz not null default now(),
  unique (meet_volume_id, athlete_id, category)
);

create index if not exists leaderboards_volume_category_idx
  on public.leaderboards (meet_volume_id, category, total_points desc);

-- ---------------------------------------------------------------------------
-- awards — Best Swimmer / Most Improved per volume × category × gender.
-- ---------------------------------------------------------------------------
create table if not exists public.awards (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,
  award_type public.award_type not null,
  category public.age_group not null,
  gender public.gender not null,
  created_at timestamptz not null default now(),
  unique (meet_volume_id, award_type, category, gender)
);

create index if not exists awards_athlete_id_idx on public.awards (athlete_id);
create index if not exists awards_volume_idx on public.awards (meet_volume_id);

-- =============================================================================
-- HISTORICAL AGE — performance displays (leaderboards, All-Time views, career
-- ledgers, profile race cards) must show the swimmer's age AT THE TIME they
-- swam, never their current live age. Both helpers derive strictly from the
-- immutable date_of_birth, so results never silently drift as a swimmer ages.
-- Defined here (ahead of the views below that use them, and ahead of
-- section 3's other helper functions) purely so this file runs top-to-bottom
-- without forward references.
-- =============================================================================

create or replace function public.age_at_date(p_dob date, p_on_date date)
returns integer
language sql
immutable
as $$
  select floor(
    (extract(year from age(p_on_date, p_dob)) * 12
      + extract(month from age(p_on_date, p_dob))) / 12
  )::integer;
$$;

create or replace function public.age_group_for_age(p_age integer)
returns public.age_group
language sql
immutable
as $$
  select case
    when p_age <= 14 then 'U14'::public.age_group
    when p_age <= 17 then 'U17'::public.age_group
    else 'Open'::public.age_group
  end;
$$;

-- The age a swimmer turns during p_on_date's calendar year — the swim-
-- federation convention used for age-group brackets, signup eligibility, and
-- the parent-link gate (see athletes.age's comment below), so a swimmer's
-- bracket never flips mid-season around their birthday. Distinct from
-- age_at_date() above, which is exact/calendar-aware and reserved for
-- historical performance display.
create or replace function public.age_turning_this_year(p_dob date, p_on_date date)
returns integer
language sql
immutable
as $$
  select (extract(year from p_on_date) - extract(year from p_dob))::integer;
$$;

-- =============================================================================
-- series_leaderboards — sums every volume's leaderboard rows per athlete, so
-- the series standing accumulates automatically as new volumes publish
-- results. Read-only: it's a derived view over public.leaderboards, and
-- inherits that table's RLS (public can already SELECT all leaderboard rows).
-- =============================================================================
create or replace view public.series_leaderboards as
select
  athlete_id,
  category,
  sum(placement_points) as placement_points,
  sum(improvement_points) as improvement_points,
  sum(total_points) as total_points,
  count(distinct meet_volume_id) as volumes_counted
from public.leaderboards
group by athlete_id, category;

-- =============================================================================
-- All-Time SSC Record Book views
-- =============================================================================

-- Best Performances: every valid race time ranked (one athlete may appear
-- multiple times). Partitioned by stroke / distance / age group / gender.
create or replace view public.all_time_best_performances as
select
  r.id as result_id,
  a.id as athlete_id,
  u.full_name as athlete_name,
  u.profile_image_url,
  -- Historical team representation for THIS volume, not the athlete's
  -- current team — a swimmer who's since transferred still shows the team
  -- they actually swam for when this race happened.
  -- vta.id (row existence), not vta.team_id, distinguishes "no affiliation
  -- recorded yet, fall back to current team" from "recorded as unattached
  -- for this volume" — coalescing on team_id would wrongly resurrect the
  -- athlete's current team for a swim they explicitly went unattached for.
  case when vta.id is not null then hist_team.name else t.name end as team_name,
  a.gender,
  coalesce(en.age_group_at_entry, a.age_group) as age_group,
  public.age_at_date(a.date_of_birth, mv.meet_date) as age_at_swim,
  e.stroke,
  e.distance_m,
  e.name as event_name,
  mv.id as meet_volume_id,
  mv.volume_number,
  mv.name as volume_name,
  r.official_time_ms,
  r.finish_place,
  r.created_at as swam_at,
  dense_rank() over (
    partition by e.stroke, e.distance_m, coalesce(en.age_group_at_entry, a.age_group), a.gender
    order by r.official_time_ms asc, r.created_at asc
  ) as rank
from public.results r
join public.heat_lanes hl on hl.id = r.heat_lane_id
join public.entries en on en.id = hl.entry_id
join public.athletes a on a.id = en.athlete_id
join public.users u on u.id = a.user_id
join public.events e on e.id = en.event_id
join public.sessions s on s.id = e.session_id
join public.meet_volumes mv on mv.id = s.meet_volume_id
left join public.teams t on t.id = a.team_id
left join public.volume_team_affiliations vta
  on vta.athlete_id = a.id and vta.meet_volume_id = mv.id
left join public.teams hist_team on hist_team.id = vta.team_id
where r.status = 'published'
  and r.result_outcome = 'valid'
  and r.official_time_ms is not null
  and e.is_skins = false;

-- Best Performers: each athlete's single fastest time per event key, then
-- ranked — one row per athlete per stroke/distance/age/gender.
-- Personal bests are locked to the age bracket the swimmer actually competed
-- in when they set them (age_group_at_entry): an athlete who PB'd in
-- U14 and later, older, PB'd again in U17 gets one row per bracket,
-- matching how real age-group records work. team_name/age_at_swim are
-- correlated to the specific race that produced the best time (via
-- `distinct on ... order by official_time_ms`), not just any race.
create or replace view public.all_time_best_performers as
with race_rows as (
  select
    a.id as athlete_id,
    u.full_name as athlete_name,
    u.profile_image_url,
    case when vta.id is not null then hist_team.name else t.name end as team_name,
    a.gender,
    coalesce(en.age_group_at_entry, a.age_group) as age_group,
    public.age_at_date(a.date_of_birth, mv.meet_date) as age_at_swim,
    e.stroke,
    e.distance_m,
    r.official_time_ms,
    r.created_at
  from public.results r
  join public.heat_lanes hl on hl.id = r.heat_lane_id
  join public.entries en on en.id = hl.entry_id
  join public.athletes a on a.id = en.athlete_id
  join public.users u on u.id = a.user_id
  join public.events e on e.id = en.event_id
  join public.sessions s on s.id = e.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  left join public.teams t on t.id = a.team_id
  left join public.volume_team_affiliations vta
    on vta.athlete_id = a.id and vta.meet_volume_id = mv.id
  left join public.teams hist_team on hist_team.id = vta.team_id
  where r.status = 'published'
    and r.result_outcome = 'valid'
    and r.official_time_ms is not null
    and e.is_skins = false
),
personal_bests as (
  select distinct on (athlete_id, stroke, distance_m, age_group, gender)
    athlete_id, athlete_name, profile_image_url, team_name, gender, age_group,
    age_at_swim, stroke, distance_m, official_time_ms as best_time_ms
  from race_rows
  order by athlete_id, stroke, distance_m, age_group, gender, official_time_ms asc, created_at asc
),
counts as (
  select athlete_id, stroke, distance_m, age_group, gender, count(*)::integer as races_counted
  from race_rows
  group by athlete_id, stroke, distance_m, age_group, gender
)
select
  pb.*,
  c.races_counted,
  dense_rank() over (
    partition by pb.stroke, pb.distance_m, pb.age_group, pb.gender
    order by pb.best_time_ms asc
  ) as rank
from personal_bests pb
join counts c
  on c.athlete_id = pb.athlete_id and c.stroke = pb.stroke and c.distance_m = pb.distance_m
  and c.age_group = pb.age_group and c.gender = pb.gender;

-- =============================================================================
-- 3. HELPER FUNCTIONS (SECURITY DEFINER — bypass RLS for role lookups so
--    policies referencing public.users don't recurse infinitely)
-- =============================================================================

create or replace function public.current_role()
returns public.user_role
language sql
security definer
stable
set search_path = public
as $$
  select role from public.users where id = auth.uid();
$$;

create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'admin'
  );
$$;

create or replace function public.is_referee()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.users where id = auth.uid() and role = 'referee'
  );
$$;

create or replace function public.is_admin_or_referee()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and role in ('admin', 'referee')
  );
$$;

create or replace function public.is_team_captain_of(p_team_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.teams
    where id = p_team_id and captain_id = auth.uid()
  );
$$;

create or replace function public.owns_athlete(p_athlete_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.athletes
    where id = p_athlete_id
      and (user_id = auth.uid() or (parent_id = auth.uid() and age < 15))
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- 4. SIGN-UP / PRIVILEGE-ESCALATION GUARDS
-- =============================================================================

-- Creates the public.users profile row whenever a new auth.users row lands.
-- The requested role always comes from raw_user_meta_data ->> 'role' and is
-- clamped to public_signup_role — a client can NEVER request 'admin'
-- through normal sign-up. The single exception is the
-- pre-configured superadmin_email, which self-bootstraps as 'admin' exactly
-- once (the very first admin account, since no admin yet exists to promote
-- anyone).
--
-- For role = 'athlete', this ALSO creates the public.athletes row (and sets
-- profile_image_url on public.users) directly from raw_user_meta_data,
-- rather than leaving that to a follow-up client-side insert/update. Why:
-- this project requires email confirmation (mailer_autoconfirm = false), so
-- supabase.auth.signUp() does not return an active session for a brand-new
-- user — auth.uid() is null for any request the client makes right after
-- signUp() resolves, until that email is confirmed. A client-side
-- `.from("athletes").insert(...)` immediately after signUp() therefore
-- ALWAYS fails RLS ("new row violates row-level security policy for table
-- athletes"), 100% of the time, for every real self-registration — this
-- was caught live via an E2E test hitting exactly that error. Since this
-- trigger runs SECURITY DEFINER on the server as part of the auth.users
-- INSERT itself, it is completely independent of whether the browser has
-- an active session, and mirrors the same pattern already used for
-- public.users. See lib/register.ts — it now packs the full athlete bio
-- into signUp()'s options.data instead of inserting separately afterward.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  requested_role text := new.raw_user_meta_data ->> 'role';
  resolved_role public.user_role := 'athlete';
  superadmin text;
  v_dob date;
  v_age integer;
  v_parent_email text;
  v_parent_id uuid;
  v_needs_parent boolean;
  v_specialty text[];
begin
  select superadmin_email into superadmin from public.app_settings limit 1;

  if superadmin is not null and lower(new.email) = lower(superadmin) then
    resolved_role := 'admin';
  elsif requested_role is not null
    and requested_role::public.public_signup_role is not null then
    resolved_role := requested_role::public.user_role;
  else
    resolved_role := 'athlete';
  end if;

  insert into public.users (id, email, full_name, role, profile_image_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    resolved_role,
    new.raw_user_meta_data ->> 'profile_image_url'
  );

  if resolved_role = 'athlete' and (new.raw_user_meta_data ? 'date_of_birth') then
    v_dob := (new.raw_user_meta_data ->> 'date_of_birth')::date;
    v_age := greatest(public.age_turning_this_year(v_dob, current_date), 13);
    v_parent_email := nullif(trim(new.raw_user_meta_data ->> 'parent_email'), '');
    v_needs_parent := public.age_group_for_age(v_age) = 'U14';

    v_parent_id := null;
    if v_needs_parent and v_parent_email is not null then
      select id into v_parent_id from public.users where lower(email) = lower(v_parent_email);
    end if;

    select array(select jsonb_array_elements_text(coalesce(new.raw_user_meta_data -> 'specialty_events', '[]'::jsonb)))
      into v_specialty;

    insert into public.athletes (
      user_id, date_of_birth, age, age_group, gender, height_cm, weight_kg,
      specialty_events, parent_id, parent_link_status, pending_parent_email,
      approved_by_admin
    ) values (
      new.id,
      v_dob,
      v_age,
      public.age_group_for_age(v_age),
      coalesce((new.raw_user_meta_data ->> 'gender')::public.gender, 'male'),
      nullif(new.raw_user_meta_data ->> 'height_cm', '')::numeric,
      nullif(new.raw_user_meta_data ->> 'weight_kg', '')::numeric,
      coalesce(v_specialty, '{}'),
      v_parent_id,
      case
        when not v_needs_parent then 'none'
        when v_parent_id is not null then 'verified'
        when v_parent_email is not null then 'pending'
        else 'none'
      end::public.parent_link_status,
      case when v_needs_parent and v_parent_id is null then v_parent_email else null end,
      false
    );
  end if;

  return new;
exception
  when invalid_text_representation then
    -- requested_role was not a valid public_signup_role (e.g. 'admin' was
    -- attempted) — silently clamp to the safe default instead of failing
    -- the whole sign-up.
    insert into public.users (id, email, full_name, role)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
      'athlete'
    );
    return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Blocks any UPDATE that changes public.users.role to/from 'admin' unless
-- the actor performing the change is already an admin. This is the backstop
-- that makes privilege escalation impossible even if an RLS policy is
-- misconfigured, since triggers fire on every code path (including
-- service-role scripts that forget to check first).
create or replace function public.enforce_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if not public.is_admin() then
      raise exception 'Only an admin may change a user''s role.';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger enforce_role_change_trigger
  before update on public.users
  for each row execute function public.enforce_role_change();

create or replace trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Team captaincy & join-request guards — Team/Coach domain rules: only
-- Open-category (18+) athletes or Coach/Admin accounts may create and
-- captain a team; an athlete may hold at most one pending join request
-- across the whole platform at a time; and once accepted onto a team, an
-- athlete's team_id is locked from further transfer requests until the
-- current meet volume concludes (status flips to 'completed').
-- ---------------------------------------------------------------------------

create or replace function public.can_captain_team()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and (
        u.role in ('coach', 'admin')
        or exists (
          select 1 from public.athletes a
          where a.user_id = u.id and a.age_group = 'Open'
        )
      )
  );
$$;

-- A meet volume is "in progress" once it has a confirmed date and hasn't
-- concluded yet — team transfers stay locked for the duration.
create or replace function public.meet_in_progress()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (select 1 from public.meet_volumes where status = 'scheduled');
$$;

create or replace function public.enforce_team_membership_request_rules()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_team_id uuid;
begin
  if exists (
    select 1 from public.team_memberships
    where user_id = new.user_id and status = 'pending'
  ) then
    raise exception
      'You already have a pending team join request. Cancel it before requesting to join another team.';
  end if;

  select team_id into v_current_team_id from public.athletes where user_id = new.user_id;

  if v_current_team_id is not null and public.meet_in_progress() then
    raise exception 'Team transfers are locked until the current meet volume concludes.';
  end if;

  return new;
end;
$$;

create or replace trigger enforce_team_membership_request_rules_trigger
  before insert on public.team_memberships
  for each row execute function public.enforce_team_membership_request_rules();

-- Hard safety net behind the trigger above — closes the race a plain
-- BEFORE INSERT check alone can't (two concurrent requests from the same
-- user racing past the trigger's SELECT before either commits).
create unique index if not exists one_pending_team_membership_per_user
  on public.team_memberships (user_id)
  where status = 'pending';

-- Accepting a membership request is what actually moves the athlete onto
-- the team's roster.
create or replace function public.sync_athlete_team_on_membership_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted' and old.status is distinct from 'accepted' then
    update public.athletes set team_id = new.team_id where user_id = new.user_id;
    new.responded_at := now();
  end if;
  return new;
end;
$$;

create or replace trigger sync_athlete_team_on_membership_accept_trigger
  before update on public.team_memberships
  for each row execute function public.sync_athlete_team_on_membership_accept();

-- =============================================================================
-- 5. LEADERBOARD MAINTENANCE
-- =============================================================================

-- Upserts leaderboard rows for the athlete tied to a newly-published result.
-- Always upserts into the athlete's native age_group category; additionally
-- upserts into 'Open' when the athlete's native category isn't already
-- 'Open' — this is what makes the Open leaderboard a combined ranking of
-- every age group per the Results Filter rules.
create or replace function public.apply_result_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_athlete_id uuid;
  v_age_group public.age_group;
  v_meet_volume_id uuid;
  old_placement numeric(6, 2) := 0;
  old_improvement numeric(6, 2) := 0;
  was_published boolean := false;
  delta_placement numeric(6, 2);
  delta_improvement numeric(6, 2);
begin
  -- OLD is only assigned on UPDATE — never dereference it on INSERT.
  if TG_OP = 'UPDATE' then
    if old.status = 'published' then
      was_published := true;
      old_placement := old.placement_points;
      old_improvement := old.improvement_points;
    end if;
  end if;

  if new.status <> 'published' then
    if not was_published then
      return new;
    end if;
    -- result was un-published after having been counted — reverse it.
    delta_placement := -old_placement;
    delta_improvement := -old_improvement;
  else
    delta_placement := new.placement_points - old_placement;
    delta_improvement := new.improvement_points - old_improvement;
  end if;

  if delta_placement = 0 and delta_improvement = 0 then
    return new;
  end if;

  -- coalesce is a defensive fallback for rows written before
  -- age_group_at_entry existed; new entries always have it stamped by
  -- set_entry_age_group_trigger.
  select a.id, coalesce(e.age_group_at_entry, a.age_group), s.meet_volume_id
    into v_athlete_id, v_age_group, v_meet_volume_id
  from public.heat_lanes hl
  join public.entries e on e.id = hl.entry_id
  join public.athletes a on a.id = e.athlete_id
  join public.events ev on ev.id = e.event_id
  join public.sessions s on s.id = ev.session_id
  where hl.id = new.heat_lane_id;

  if v_athlete_id is null then
    return new;
  end if;

  insert into public.leaderboards (meet_volume_id, athlete_id, category, placement_points, improvement_points)
  values (v_meet_volume_id, v_athlete_id, v_age_group, delta_placement, delta_improvement)
  on conflict (meet_volume_id, athlete_id, category) do update
    set placement_points = public.leaderboards.placement_points + excluded.placement_points,
        improvement_points = public.leaderboards.improvement_points + excluded.improvement_points,
        updated_at = now();

  -- 'Open' is a combined ranking of every age group (Results Filter rule),
  -- so non-Open athletes also accumulate into it.
  if v_age_group <> 'Open' then
    insert into public.leaderboards (meet_volume_id, athlete_id, category, placement_points, improvement_points)
    values (v_meet_volume_id, v_athlete_id, 'Open', delta_placement, delta_improvement)
    on conflict (meet_volume_id, athlete_id, category) do update
      set placement_points = public.leaderboards.placement_points + excluded.placement_points,
          improvement_points = public.leaderboards.improvement_points + excluded.improvement_points,
          updated_at = now();
  end if;

  return new;
end;
$$;

create or replace trigger results_apply_points
  after insert or update on public.results
  for each row execute function public.apply_result_points();

create or replace trigger results_set_updated_at
  before update on public.results
  for each row execute function public.set_updated_at();

create or replace trigger teams_set_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

create or replace trigger athletes_set_updated_at
  before update on public.athletes
  for each row execute function public.set_updated_at();

create or replace trigger heats_set_updated_at
  before update on public.heats
  for each row execute function public.set_updated_at();

create or replace trigger meet_volumes_set_updated_at
  before update on public.meet_volumes
  for each row execute function public.set_updated_at();

-- Only an admin may toggle team approval.
create or replace function public.enforce_team_approval_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.approved_by_admin is distinct from old.approved_by_admin and not public.is_admin() then
    raise exception 'Only an admin may approve or unapprove a team.';
  end if;
  return new;
end;
$$;

create or replace trigger enforce_team_approval_change_trigger
  before update on public.teams
  for each row execute function public.enforce_team_approval_change();

-- Force DQ / NS scoring rules and keep outcome columns consistent before
-- the row is written. Referees cannot accidentally award points to a DQ/NS.
create or replace function public.enforce_result_scoring()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.result_outcome = 'no_show' then
    new.dq_code := null;
    new.official_time_ms := null;
    new.finish_place := null;
    new.placement_points := 0;
    new.improvement_points := 0;
  elsif new.result_outcome = 'dq' then
    new.official_time_ms := null;
    new.finish_place := null;
    new.placement_points := 0;
    new.improvement_points := 0;
    if new.dq_code is null then
      raise exception 'DQ results require an official dq_code.';
    end if;
  end if;

  if new.status = 'published' and new.result_outcome is null then
    raise exception 'Published results require a result_outcome (valid, dq, or no_show).';
  end if;

  return new;
end;
$$;

create or replace trigger enforce_result_scoring_trigger
  before insert or update on public.results
  for each row execute function public.enforce_result_scoring();

-- Athletes / coaches / parents may NEVER self-register for a Skins event.
-- Only admins (and service-role jobs that populate heats from accepted
-- qualifiers) may insert skins entries.
create or replace function public.enforce_no_direct_skins_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.events e
    where e.id = new.event_id and e.is_skins = true
  ) and not public.is_admin() then
    raise exception
      'Skins entries cannot be submitted during registration. '
      'Qualification is assigned automatically from official meet results.';
  end if;
  return new;
end;
$$;

create or replace trigger enforce_no_direct_skins_entry_trigger
  before insert on public.entries
  for each row execute function public.enforce_no_direct_skins_entry();

-- Unapproved swimmers may set up profiles but cannot enter any meet volume
-- until an admin sets approved_by_admin = true.
create or replace function public.enforce_athlete_approved_for_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin() then
    return new;
  end if;

  if exists (
    select 1 from public.athletes a
    where a.id = new.athlete_id
      and a.approved_by_admin = false
  ) then
    raise exception 'Swimmer registration pending admin approval.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_athlete_approved_for_entry_trigger on public.entries;
create trigger enforce_athlete_approved_for_entry_trigger
  before insert on public.entries
  for each row execute function public.enforce_athlete_approved_for_entry();

-- Only admins may flip approved_by_admin. Self-service inserts are forced
-- to false so a client cannot self-approve on signup.
create or replace function public.enforce_athlete_approval_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    if not public.is_admin() then
      new.approved_by_admin := false;
    end if;
    return new;
  end if;

  if new.approved_by_admin is distinct from old.approved_by_admin
    and not public.is_admin() then
    raise exception 'Only an admin may approve or reject a swimmer registration.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_athlete_approval_change_trigger on public.athletes;
create trigger enforce_athlete_approval_change_trigger
  before insert or update on public.athletes
  for each row execute function public.enforce_athlete_approval_change();

-- Stamps age_group_at_entry from the athlete's date_of_birth as of THIS
-- volume's meet_date — never the athlete's current (mutable) age_group —
-- so heat seeding and leaderboard categorization stay historically correct
-- even after the swimmer ages into a new bracket for a later volume.
create or replace function public.set_entry_age_group()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dob date;
  v_meet_date date;
begin
  select a.date_of_birth, mv.meet_date
    into v_dob, v_meet_date
  from public.athletes a
  join public.events ev on ev.id = new.event_id
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where a.id = new.athlete_id;

  if v_dob is not null and v_meet_date is not null then
    new.age_group_at_entry := public.age_group_for_age(public.age_turning_this_year(v_dob, v_meet_date));
  end if;

  return new;
end;
$$;

create or replace trigger set_entry_age_group_trigger
  before insert or update of event_id, athlete_id on public.entries
  for each row execute function public.set_entry_age_group();

-- Only an admin may confirm payment (mirrors enforce_result_publish below).
create or replace function public.enforce_entry_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'confirmed' and not public.is_admin() then
    raise exception 'Only an admin may confirm entry payment.';
  end if;
  return new;
end;
$$;

create or replace trigger enforce_entry_status_change_trigger
  before insert or update on public.entries
  for each row execute function public.enforce_entry_status_change();

create or replace trigger skins_qualifications_set_updated_at
  before update on public.skins_qualifications
  for each row execute function public.set_updated_at();

-- RLS's WITH CHECK on athlete_respond_own_skins_qualification only
-- constrains the `response` value — it does not stop a self-service athlete
-- from also slipping source_rank / best_time_ms / category / skins_event_id
-- changes into the same PATCH (RLS is row-level, not column-level). This
-- trigger is the actual column-level backstop: non-admin/referee actors may
-- only ever change response / responded_at / responded_by.
create or replace function public.enforce_skins_qualification_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_admin_or_referee() then
    return new;
  end if;

  if new.skins_event_id is distinct from old.skins_event_id
    or new.athlete_id is distinct from old.athlete_id
    or new.category is distinct from old.category
    or new.source_rank is distinct from old.source_rank
    or new.best_time_ms is distinct from old.best_time_ms then
    raise exception
      'Only response / responded_at may be changed on a Skins qualification.';
  end if;

  return new;
end;
$$;

create or replace trigger enforce_skins_qualification_columns_trigger
  before update on public.skins_qualifications
  for each row execute function public.enforce_skins_qualification_columns();

-- =============================================================================
-- 5b. SKINS QUALIFICATION RPC
-- =============================================================================

-- Ranks published, valid (non-NS) results for the qualifying stroke/distance
-- that feeds a Session 3 Skins event, then applies accept/decline rollover
-- until up to 6 active slots per age-group category are filled.
--
-- event_id_param = the Skins event UUID (events.is_skins = true).
-- Qualifying times are taken from non-skins events that share the same
-- stroke + distance_m. NS outcomes are excluded entirely; DQ outcomes have
-- no official_time_ms so they never enter the ranking.
create or replace function public.get_skins_qualifiers(event_id_param uuid)
returns table (
  athlete_id uuid,
  athlete_name text,
  team_name text,
  category public.age_group,
  source_rank integer,
  best_time_ms integer,
  response public.skins_response,
  is_active_qualifier boolean,
  is_confirmed boolean,
  slot_number integer
)
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_stroke text;
  v_distance integer;
  v_is_skins boolean;
begin
  select e.stroke, e.distance_m, e.is_skins
    into v_stroke, v_distance, v_is_skins
  from public.events e
  where e.id = event_id_param;

  if v_stroke is null then
    raise exception 'Event % not found', event_id_param;
  end if;

  if not coalesce(v_is_skins, false) then
    raise exception 'get_skins_qualifiers expects a Skins event (is_skins = true)';
  end if;

  return query
  with best_times as (
    select
      a.id as athlete_id,
      u.full_name as athlete_name,
      t.name as team_name,
      a.age_group as category,
      min(r.official_time_ms)::integer as best_time_ms
    from public.results r
    join public.heat_lanes hl on hl.id = r.heat_lane_id
    join public.entries en on en.id = hl.entry_id
    join public.athletes a on a.id = en.athlete_id
    join public.users u on u.id = a.user_id
    join public.events ev on ev.id = en.event_id
    left join public.teams t on t.id = a.team_id
    where r.status = 'published'
      and r.result_outcome = 'valid'
      and r.official_time_ms is not null
      and coalesce(r.is_no_show, false) = false
      and ev.is_skins = false
      and ev.stroke = v_stroke
      and ev.distance_m = v_distance
    group by a.id, u.full_name, t.name, a.age_group
  ),
  ranked as (
    select
      best_times.*,
      dense_rank() over (
        partition by best_times.category
        order by best_times.best_time_ms
      )::integer as source_rank
    from best_times
  ),
  with_response as (
    select
      ranked.*,
      coalesce(sq.response, 'pending'::public.skins_response) as response
    from ranked
    left join public.skins_qualifications sq
      on sq.skins_event_id = event_id_param
     and sq.athlete_id = ranked.athlete_id
     and sq.category = ranked.category
  ),
  active as (
    select
      wr.*,
      case
        when wr.response = 'declined' then false
        when (
          select count(*) from with_response wr2
          where wr2.category = wr.category
            and wr2.response <> 'declined'
            and wr2.source_rank <= wr.source_rank
        ) <= 6 then true
        else false
      end as is_active_qualifier,
      (wr.response = 'accepted') as is_confirmed
    from with_response wr
  )
  select
    active.athlete_id,
    active.athlete_name,
    active.team_name,
    active.category,
    active.source_rank,
    active.best_time_ms,
    active.response,
    active.is_active_qualifier,
    active.is_confirmed,
    case
      when active.is_active_qualifier then (
        select count(*)::integer from active a2
        where a2.category = active.category
          and a2.is_active_qualifier
          and a2.source_rank <= active.source_rank
      )
      else null
    end as slot_number
  from active
  order by active.category, active.source_rank;
end;
$$;

comment on function public.get_skins_qualifiers(uuid) is
  'Returns ranked Skins candidates per age group with accept/decline '
  'rollover applied. Active qualifier slots are the first 6 non-declined '
  'athletes by source_rank; confirmed = accepted response.';

-- Upserts invitation rows for every currently-active (non-declined) qualifier
-- so athletes can respond from the dashboard modal.
create or replace function public.sync_skins_invitations(event_id_param uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  upserted integer := 0;
begin
  if not public.is_admin_or_referee() then
    raise exception 'Only admins or referees may sync Skins invitations.';
  end if;

  insert into public.skins_qualifications (
    skins_event_id, athlete_id, category, source_rank, best_time_ms, response
  )
  select
    event_id_param,
    q.athlete_id,
    q.category,
    q.source_rank,
    q.best_time_ms,
    'pending'
  from public.get_skins_qualifiers(event_id_param) q
  where q.is_active_qualifier = true
  on conflict (skins_event_id, athlete_id, category) do update
    set source_rank = excluded.source_rank,
        best_time_ms = excluded.best_time_ms,
        updated_at = now()
    where public.skins_qualifications.response = 'pending';

  get diagnostics upserted = row_count;
  return upserted;
end;
$$;

-- =============================================================================
-- 5c. PARENT LINKAGE — under-15 swimmers name a parent/guardian email at
-- signup. If that email doesn't have an account yet, the athlete row is
-- stamped pending_parent_email + parent_link_status='pending'. Call this
-- once the named parent signs up: it can't be a plain RLS-gated table
-- update, since parent_id isn't set yet (the very thing being claimed) — a
-- normal RLS policy has nothing to key off. Instead this security-definer
-- RPC matches purely on the CALLER'S OWN authenticated email, so a parent
-- can only ever claim athletes that named them, not arbitrary others.
-- =============================================================================

create or replace function public.claim_pending_parent_links()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer;
begin
  select email into v_email from public.users where id = auth.uid();
  if v_email is null then
    return 0;
  end if;

  update public.athletes
  set parent_id = auth.uid(),
      parent_link_status = 'verified',
      pending_parent_email = null
  where pending_parent_email is not null
    and lower(pending_parent_email) = lower(v_email);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- =============================================================================
-- 6. ROW LEVEL SECURITY
-- =============================================================================

alter table public.app_settings enable row level security;
alter table public.users enable row level security;
alter table public.teams enable row level security;
alter table public.team_memberships enable row level security;
alter table public.athletes enable row level security;
alter table public.volume_team_affiliations enable row level security;
alter table public.meet_volumes enable row level security;
alter table public.sessions enable row level security;
alter table public.events enable row level security;
alter table public.entries enable row level security;
alter table public.heats enable row level security;
alter table public.heat_lanes enable row level security;
alter table public.results enable row level security;
alter table public.leaderboards enable row level security;
alter table public.skins_qualifications enable row level security;

-- ---------------------------------------------------------------------------
-- app_settings — admins only, never public.
-- ---------------------------------------------------------------------------
drop policy if exists "admins_manage_app_settings" on public.app_settings;
create policy "admins_manage_app_settings" on public.app_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_users" on public.users;
create policy "admins_full_access_users" on public.users
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "users_view_own_profile" on public.users;
create policy "users_view_own_profile" on public.users
  for select using (id = auth.uid());

-- Authenticated members can see basic profile info of others (team rosters,
-- captain names, referee/athlete listings) — never role changes though,
-- which remain gated by enforce_role_change_trigger regardless of RLS.
drop policy if exists "authenticated_view_profiles" on public.users;
create policy "authenticated_view_profiles" on public.users
  for select using (auth.role() = 'authenticated');

-- Public athlete directory / all-time record book need display names + photos.
-- Clients must not render email on public surfaces.
drop policy if exists "public_view_athlete_and_deck_users" on public.users;
create policy "public_view_athlete_and_deck_users" on public.users
  for select using (
    exists (select 1 from public.athletes a where a.user_id = id)
    or role in ('referee', 'admin')
  );

drop policy if exists "users_update_own_profile" on public.users;
create policy "users_update_own_profile" on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_teams" on public.teams;
create policy "admins_full_access_teams" on public.teams
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public_view_approved_teams" on public.teams;
create policy "public_view_approved_teams" on public.teams
  for select using (approved_by_admin = true or captain_id = auth.uid());

-- Only Open-category (18+) athletes or Coach/Admin accounts may create and
-- captain a team — see public.can_captain_team() in section 4.
drop policy if exists "authenticated_create_team" on public.teams;
drop policy if exists "eligible_user_create_team" on public.teams;
create policy "eligible_user_create_team" on public.teams
  for insert with check (
    auth.uid() is not null and captain_id = auth.uid() and public.can_captain_team()
  );

drop policy if exists "captain_update_own_team" on public.teams;
create policy "captain_update_own_team" on public.teams
  for update using (captain_id = auth.uid()) with check (captain_id = auth.uid());

-- ---------------------------------------------------------------------------
-- team_memberships
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_memberships" on public.team_memberships;
create policy "admins_full_access_memberships" on public.team_memberships
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "user_view_own_memberships" on public.team_memberships;
create policy "user_view_own_memberships" on public.team_memberships
  for select using (
    user_id = auth.uid() or public.is_team_captain_of(team_id)
  );

drop policy if exists "user_request_membership" on public.team_memberships;
create policy "user_request_membership" on public.team_memberships
  for insert with check (user_id = auth.uid());

drop policy if exists "captain_manage_membership_status" on public.team_memberships;
create policy "captain_manage_membership_status" on public.team_memberships
  for update using (public.is_team_captain_of(team_id))
  with check (public.is_team_captain_of(team_id));

-- "Reject" (captain) and "cancel" (the requester) both just delete the
-- pending row — team_memberships only persists real states (pending,
-- accepted), same convention as public.rejectTeam() for team approvals.
drop policy if exists "captain_or_requester_delete_membership" on public.team_memberships;
create policy "captain_or_requester_delete_membership" on public.team_memberships
  for delete using (user_id = auth.uid() or public.is_team_captain_of(team_id));

-- ---------------------------------------------------------------------------
-- athletes
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_athletes" on public.athletes;
create policy "admins_full_access_athletes" on public.athletes
  for all using (public.is_admin()) with check (public.is_admin());

-- Public athlete directory + profiles (safe biographical fields only when
-- joined carefully; email lives on users and remains gated separately).
drop policy if exists "public_view_athletes" on public.athletes;
create policy "public_view_athletes" on public.athletes
  for select using (true);

drop policy if exists "athlete_view_own_row" on public.athletes;
create policy "athlete_view_own_row" on public.athletes
  for select using (
    user_id = auth.uid()
    or parent_id = auth.uid()
    or public.is_team_captain_of(team_id)
    or public.is_admin_or_referee()
  );

drop policy if exists "athlete_update_own_row" on public.athletes;
create policy "athlete_update_own_row" on public.athletes
  for update using (user_id = auth.uid() or parent_id = auth.uid())
  with check (user_id = auth.uid() or parent_id = auth.uid());

drop policy if exists "user_create_own_athlete_row" on public.athletes;
create policy "user_create_own_athlete_row" on public.athletes
  for insert with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- volume_team_affiliations — historical per-volume team representation.
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_volume_team_affiliations" on public.volume_team_affiliations;
create policy "admins_full_access_volume_team_affiliations" on public.volume_team_affiliations
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public_view_volume_team_affiliations" on public.volume_team_affiliations;
create policy "public_view_volume_team_affiliations" on public.volume_team_affiliations
  for select using (true);

-- Athletes choose their own team representation when registering for a volume.
drop policy if exists "athlete_manage_own_volume_team_affiliation" on public.volume_team_affiliations;
create policy "athlete_manage_own_volume_team_affiliation" on public.volume_team_affiliations
  for all using (public.owns_athlete(athlete_id))
  with check (public.owns_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- meet_volumes, sessions & events — public schedule information.
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_meet_volumes" on public.meet_volumes;
create policy "admins_full_access_meet_volumes" on public.meet_volumes
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public_view_meet_volumes" on public.meet_volumes;
create policy "public_view_meet_volumes" on public.meet_volumes
  for select using (true);

drop policy if exists "admins_full_access_sessions" on public.sessions;
create policy "admins_full_access_sessions" on public.sessions
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public_view_sessions" on public.sessions;
create policy "public_view_sessions" on public.sessions
  for select using (true);

drop policy if exists "admins_full_access_events" on public.events;
create policy "admins_full_access_events" on public.events
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public_view_events" on public.events;
create policy "public_view_events" on public.events
  for select using (true);

-- ---------------------------------------------------------------------------
-- entries
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_entries" on public.entries;
create policy "admins_full_access_entries" on public.entries
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "deck_officials_view_entries" on public.entries;
create policy "deck_officials_view_entries" on public.entries
  for select using (public.is_admin_or_referee());

-- Entries carry no PII of their own (event_id, athlete_id, seed_time_ms,
-- is_nt) — athlete names/events are already public. Without this, spectators
-- can see a published heat's lanes but not who's actually swimming in them,
-- since heat_lanes -> entries -> athletes is one join and RLS blocks the
-- middle table: the live heat sheet and athlete career-ledger features both
-- silently render empty without this policy.
drop policy if exists "public_view_entries" on public.entries;
create policy "public_view_entries" on public.entries
  for select using (true);

drop policy if exists "athlete_manage_own_entries" on public.entries;
create policy "athlete_manage_own_entries" on public.entries
  for all using (public.owns_athlete(athlete_id))
  with check (public.owns_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- heats & heat_lanes
-- ---------------------------------------------------------------------------
drop policy if exists "admins_referees_full_access_heats" on public.heats;
create policy "admins_referees_full_access_heats" on public.heats
  for all using (public.is_admin_or_referee()) with check (public.is_admin_or_referee());

drop policy if exists "public_view_published_heats" on public.heats;
create policy "public_view_published_heats" on public.heats
  for select using (status = 'published');

-- The single consolidated Referee role owns heat_lanes end to end (both
-- call-room attendance check-in and lane assignment) — no separate usher
-- tier or attendance-only lockdown trigger needed anymore.
drop policy if exists "admins_referees_full_access_heat_lanes" on public.heat_lanes;
create policy "admins_referees_full_access_heat_lanes" on public.heat_lanes
  for all using (public.is_admin_or_referee()) with check (public.is_admin_or_referee());

drop policy if exists "public_view_published_heat_lanes" on public.heat_lanes;
create policy "public_view_published_heat_lanes" on public.heat_lanes
  for select using (
    exists (select 1 from public.heats h where h.id = heat_id and h.status = 'published')
  );

-- Audit trail: stamp who/when marked attendance, on every attendance change.
create or replace function public.stamp_attendance_marked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.attendance_status is distinct from old.attendance_status then
    new.attendance_marked_at := now();
    new.attendance_marked_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace trigger stamp_attendance_marked_trigger
  before update on public.heat_lanes
  for each row execute function public.stamp_attendance_marked();

-- ---------------------------------------------------------------------------
-- results
-- ---------------------------------------------------------------------------
drop policy if exists "admins_full_access_results" on public.results;
create policy "admins_full_access_results" on public.results
  for all using (public.is_admin()) with check (public.is_admin());

-- Referees insert/update result drafts and submit the completed heat card
-- to the Admin queue — but never publish directly. enforce_result_publish
-- below is the actual gate; this policy just governs draft-level writes.
drop policy if exists "referees_manage_result_drafts" on public.results;
create policy "referees_manage_result_drafts" on public.results
  for all using (public.is_referee()) with check (public.is_referee());

drop policy if exists "public_view_published_results" on public.results;
create policy "public_view_published_results" on public.results
  for select using (status = 'published');

-- Referee -> Admin workflow: the referee enters times/DQ/NS for a heat and
-- submits the card (status stays 'draft'); only an Admin reviewing the
-- queue may flip status to 'published', making it visible on spectator
-- heat sheets and leaderboards. Coaches, athletes, and parents can never
-- reach this at all — they hold no results RLS policy (default-deny).
create or replace function public.enforce_result_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only guard the actual transition into 'published' (TG_OP = 'INSERT'
  -- direct-as-published, or an UPDATE where it wasn't already published).
  -- A plain new.status = 'published' check without the old.status compare
  -- would also fire for a referee's UNRELATED column update on a row that
  -- happens to already be published — exactly what
  -- recompute_heat_finish_places' cross-lane cascade does every time it
  -- re-ranks a heat where some other lane is already published, since that
  -- UPDATE touches every valid result row in the heat regardless of who's
  -- writing. That over-broad guard blocked referees from ever drafting a
  -- new lane in a heat that already had any published result at all.
  if new.status = 'published' and old.status is distinct from 'published' and not public.is_admin() then
    raise exception 'Only an admin may publish results.';
  end if;
  return new;
end;
$$;

create or replace trigger enforce_result_publish_trigger
  before insert or update on public.results
  for each row execute function public.enforce_result_publish();

-- Finish places are never entered manually — they're always derived from
-- ranking each heat's official times fastest-first (DQ/NS excluded, per the
-- results_outcome_consistency check above which keeps their finish_place
-- null). Recomputing server-side means every device sees identical,
-- authoritative placements regardless of which referee most recently
-- wrote a time.
create or replace function public.recompute_heat_finish_places()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_heat_id uuid;
  v_max_points numeric := 6;
begin
  select heat_id into v_heat_id from public.heat_lanes where id = new.heat_lane_id;
  if v_heat_id is null then
    return new;
  end if;

  with ranked as (
    select r.id, row_number() over (order by r.official_time_ms asc) as computed_place
    from public.results r
    join public.heat_lanes hl on hl.id = r.heat_lane_id
    where hl.heat_id = v_heat_id and r.result_outcome = 'valid'
  )
  update public.results r
  set finish_place = ranked.computed_place,
      placement_points = greatest(0, v_max_points + 1 - ranked.computed_place)
  from ranked
  where r.id = ranked.id
    and (
      r.finish_place is distinct from ranked.computed_place
      or r.placement_points is distinct from greatest(0, v_max_points + 1 - ranked.computed_place)
    );

  return new;
end;
$$;

create or replace trigger recompute_heat_finish_places_trigger
  after insert or update of result_outcome, official_time_ms on public.results
  for each row execute function public.recompute_heat_finish_places();

-- ---------------------------------------------------------------------------
-- leaderboards — public read, system-maintained writes only.
-- ---------------------------------------------------------------------------
drop policy if exists "public_view_leaderboards" on public.leaderboards;
create policy "public_view_leaderboards" on public.leaderboards
  for select using (true);

drop policy if exists "admins_full_access_leaderboards" on public.leaderboards;
create policy "admins_full_access_leaderboards" on public.leaderboards
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- skins_qualifications
-- ---------------------------------------------------------------------------
drop policy if exists "admins_referees_manage_skins_qualifications" on public.skins_qualifications;
create policy "admins_referees_manage_skins_qualifications"
  on public.skins_qualifications
  for all using (public.is_admin_or_referee())
  with check (public.is_admin_or_referee());

drop policy if exists "athlete_view_own_skins_qualification" on public.skins_qualifications;
create policy "athlete_view_own_skins_qualification"
  on public.skins_qualifications
  for select using (public.owns_athlete(athlete_id));

-- Athletes (or their under-15 parent) may accept / decline their own slot.
drop policy if exists "athlete_respond_own_skins_qualification" on public.skins_qualifications;
create policy "athlete_respond_own_skins_qualification"
  on public.skins_qualifications
  for update using (public.owns_athlete(athlete_id))
  with check (
    public.owns_athlete(athlete_id)
    and response in ('accepted', 'declined')
  );

drop policy if exists "public_view_active_skins_qualifications" on public.skins_qualifications;
create policy "public_view_active_skins_qualifications"
  on public.skins_qualifications
  for select using (true);

-- ---------------------------------------------------------------------------
-- awards — public read; admin write.
-- ---------------------------------------------------------------------------
alter table public.awards enable row level security;

drop policy if exists "public_view_awards" on public.awards;
create policy "public_view_awards" on public.awards
  for select using (true);

drop policy if exists "admins_full_access_awards" on public.awards;
create policy "admins_full_access_awards" on public.awards
  for all using (public.is_admin()) with check (public.is_admin());

-- =============================================================================
-- 6b. REALTIME — spectator heat sheets / results subscribe to live changes.
-- Guarded so this file stays idempotent (re-running it errors on an already-
-- registered table) and harmless when run somewhere with no such publication
-- (e.g. a plain local Postgres used for schema testing, not a Supabase project).
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'results'
    ) then
      alter publication supabase_realtime add table public.results;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'heats'
    ) then
      alter publication supabase_realtime add table public.heats;
    end if;

    -- Call-room attendance flips must reach referees behind the blocks live.
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'heat_lanes'
    ) then
      alter publication supabase_realtime add table public.heat_lanes;
    end if;
  end if;
end $$;

-- =============================================================================
-- 6c. STORAGE — public "avatars" bucket for profile photos (Part 2).
-- Guarded on the storage schema existing at all (a plain local Postgres used
-- for schema testing, not a real Supabase project, has no storage schema).
-- =============================================================================

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('avatars', 'avatars', true)
    on conflict (id) do update set public = true;

    -- Public bucket: anyone may view an avatar (profile photos are already
    -- shown publicly across the athlete directory, teams, and deck rosters).
    drop policy if exists "avatars_public_read" on storage.objects;
    create policy "avatars_public_read" on storage.objects
      for select using (bucket_id = 'avatars');

    -- A brand new account doesn't exist yet at the moment someone picks a
    -- profile photo during registration (see app/register/page.tsx — the
    -- photo uploads to a random `pending/` key before public.users/athletes
    -- rows exist), and this project has no backend/service role to broker a
    -- two-step "create account, then upload" flow. Profile photos are
    -- public, low-sensitivity assets, so uploads are scoped to the bucket
    -- itself rather than gated on auth.uid() ownership.
    drop policy if exists "avatars_anyone_upload" on storage.objects;
    create policy "avatars_anyone_upload" on storage.objects
      for insert with check (bucket_id = 'avatars');

    drop policy if exists "avatars_owner_update" on storage.objects;
    create policy "avatars_owner_update" on storage.objects
      for update using (bucket_id = 'avatars' and owner = auth.uid())
      with check (bucket_id = 'avatars' and owner = auth.uid());
  end if;
end $$;

-- =============================================================================
-- 6d. PRIVILEGES — PostgREST roles need table/function GRANTs *before* RLS.
-- =============================================================================
-- Symptom this section fixes: REST calls fail with
--   "permission denied for table <name>"
-- even when a permissive RLS policy exists. That error is a missing GRANT —
-- Postgres rejects the role at the privilege check, so RLS never runs.
--
-- Supabase projects normally inherit default privileges for anon /
-- authenticated / service_role, but those can be absent when tables were
-- created outside the dashboard defaults, revoked, or applied from a plain
-- Postgres dump. Re-granting here is idempotent and safe: RLS remains the
-- real authorization gate (no policy ⇒ deny).
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

-- Tables + views (Postgres treats views as tables for GRANT purposes).
grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;

grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;

-- RPCs used by the app (get_skins_qualifiers, sync_skins_invitations,
-- claim_pending_parent_links, helper predicates, etc.).
grant execute on all functions in schema public
  to anon, authenticated, service_role;

-- Objects created later by the current role in this schema.
alter default privileges in schema public
  grant select, insert, update, delete on tables
  to anon, authenticated, service_role;

alter default privileges in schema public
  grant usage, select on sequences
  to anon, authenticated, service_role;

alter default privileges in schema public
  grant execute on functions
  to anon, authenticated, service_role;

-- =============================================================================
-- 7. SEED DATA — SSC Vol. 1 (Oct 2, 2026) + a placeholder Vol. 2
-- =============================================================================

insert into public.meet_volumes (volume_number, name, meet_date, status) values
  (1, 'SSC Vol. 1', '2026-10-02', 'scheduled'),
  (2, 'SSC Vol. 2', null, 'planned')
on conflict (volume_number) do update set
  name = excluded.name,
  meet_date = coalesce(public.meet_volumes.meet_date, excluded.meet_date);

insert into public.sessions (meet_volume_id, session_number, name, meet_date, start_time, end_time)
select v.id, s.session_number, s.name, v.meet_date, s.start_time, s.end_time
from public.meet_volumes v
cross join (
  values
    (1, 'Session 1 — Morning', '09:00'::time, '12:00'::time),
    (2, 'Session 2 — Afternoon', '14:00'::time, '17:00'::time),
    (3, 'Session 3 — Skins', '17:00'::time, '19:00'::time)
) as s(session_number, name, start_time, end_time)
where v.volume_number = 1
on conflict (meet_volume_id, session_number) do nothing;

-- System creator / first-boot admin. Subsequent admins must be promoted via
-- the user-role-management panel by an existing admin. Uses do-update (not
-- do-nothing) so re-running this file always enforces the configured email,
-- even against a project that was already seeded with a placeholder value.
insert into public.app_settings (id, superadmin_email)
values (true, 'elewakareem2002@gmail.com')
on conflict (id) do update set
  superadmin_email = excluded.superadmin_email,
  updated_at = now();
