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

create type public.user_role as enum (
  'admin',
  'referee',
  'coach',
  'team_captain',
  'athlete',
  'parent'
);

-- Roles a member of the public may select for themselves at sign-up.
-- 'admin' and 'team_captain' are intentionally excluded — team_captain is
-- granted by promoting a team's captain_id, admin only by an existing admin.
create type public.public_signup_role as enum (
  'athlete',
  'parent',
  'coach',
  'referee'
);

create type public.age_group as enum (
  'U13_14',
  'U17',
  'Open'
);

-- Used for heats.status and results.status
create type public.publish_status as enum (
  'draft',
  'published'
);

create type public.membership_status as enum (
  'pending',
  'accepted'
);

-- The two heat-scheduling phases: U13-14 swims first, U17 + Open swim
-- together afterward (see lib/seeding.ts).
create type public.heat_group as enum (
  'U13_14',
  'U17_OPEN'
);

create type public.dq_reason as enum (
  'false_start',
  'stroke_infraction',
  'turn_infraction',
  'turn_stroke_violation',
  'finish_infraction',
  'unsporting_conduct',
  'other'
);

-- Explicit outcome for a recorded heat result. DQ and NS both score 0
-- placement/improvement points; NS is additionally excluded from Skins
-- qualification ranking.
create type public.result_outcome as enum (
  'valid',
  'dq',
  'no_show'
);

create type public.skins_response as enum (
  'pending',
  'accepted',
  'declined'
);

-- =============================================================================
-- 2. CORE TABLES
-- =============================================================================

-- ---------------------------------------------------------------------------
-- app_settings — single-row configuration table. Holds the email of the
-- system creator (the only account allowed to self-bootstrap as 'admin').
-- ---------------------------------------------------------------------------
create table public.app_settings (
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
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  phone text,
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
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  captain_id uuid references public.users (id) on delete set null,
  approved_by_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- team_memberships
-- ---------------------------------------------------------------------------
create table public.team_memberships (
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
create table public.athletes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  parent_id uuid references public.users (id) on delete set null,
  date_of_birth date not null,
  age integer not null check (age >= 0 and age < 120),
  age_group public.age_group not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.athletes.parent_id is
  'Optional. Grants that parent RLS management rights over this athlete''s '
  'entries when age < 15 (see entries RLS policies).';

-- ---------------------------------------------------------------------------
-- sessions — the 3 sessions of the Oct 2, 2026 meet.
-- ---------------------------------------------------------------------------
create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  session_number integer not null unique check (session_number in (1, 2, 3)),
  name text not null,
  meet_date date not null,
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
create table public.events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  name text not null,
  stroke text not null,
  distance_m integer not null check (distance_m > 0),
  event_order integer not null default 0,
  is_skins boolean not null default false,
  created_at timestamptz not null default now()
);

create index events_session_id_idx on public.events (session_id);

-- ---------------------------------------------------------------------------
-- entries — event registrations
-- ---------------------------------------------------------------------------
create table public.entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  seed_time_ms integer,
  is_nt boolean not null default false,
  created_at timestamptz not null default now(),
  unique (event_id, athlete_id),
  constraint entries_seed_time_consistency check (
    (is_nt = true and seed_time_ms is null) or
    (is_nt = false and seed_time_ms is not null and seed_time_ms > 0)
  )
);

create index entries_event_id_idx on public.entries (event_id);
create index entries_athlete_id_idx on public.entries (athlete_id);

-- ---------------------------------------------------------------------------
-- heats & heat_lanes — 6 lanes per heat.
-- ---------------------------------------------------------------------------
create table public.heats (
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

create index heats_event_id_idx on public.heats (event_id);
create index heats_status_idx on public.heats (status);

create table public.heat_lanes (
  id uuid primary key default gen_random_uuid(),
  heat_id uuid not null references public.heats (id) on delete cascade,
  lane_number integer not null check (lane_number between 1 and 6),
  entry_id uuid references public.entries (id) on delete cascade,
  unique (heat_id, lane_number),
  unique (heat_id, entry_id)
);

create index heat_lanes_heat_id_idx on public.heat_lanes (heat_id);

-- ---------------------------------------------------------------------------
-- results
-- ---------------------------------------------------------------------------
create table public.results (
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

create index results_status_idx on public.results (status);
create index results_outcome_idx on public.results (result_outcome);

-- ---------------------------------------------------------------------------
-- skins_qualifications — accept / decline responses for Session 3 Skins.
-- Athletes never self-register for skins events; invitations are created
-- from published meet results and roll over when a qualifier declines.
-- ---------------------------------------------------------------------------
create table public.skins_qualifications (
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

create index skins_qualifications_event_idx
  on public.skins_qualifications (skins_event_id, category, source_rank);

-- ---------------------------------------------------------------------------
-- leaderboards — dual tracking of Placement Points & Improvement Points.
--
-- category = 'U13_14' | 'U17'  -> only athletes native to that age group.
-- category = 'Open'           -> ALL athletes across every age group,
--                                 ranked together (per Results Filter rule).
-- Every athlete accumulates points into their native-age-group category AND
-- into 'Open' (see public.apply_result_points() below).
-- ---------------------------------------------------------------------------
create table public.leaderboards (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  category public.age_group not null,
  placement_points numeric(8, 2) not null default 0,
  improvement_points numeric(8, 2) not null default 0,
  total_points numeric(8, 2) generated always as (placement_points + improvement_points) stored,
  updated_at timestamptz not null default now(),
  unique (athlete_id, category)
);

create index leaderboards_category_idx on public.leaderboards (category, total_points desc);

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
-- clamped to public_signup_role — a client can NEVER request 'admin' or
-- 'team_captain' through normal sign-up. The single exception is the
-- pre-configured superadmin_email, which self-bootstraps as 'admin' exactly
-- once (the very first admin account, since no admin yet exists to promote
-- anyone).
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

  insert into public.users (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    resolved_role
  );

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

create trigger on_auth_user_created
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

create trigger enforce_role_change_trigger
  before update on public.users
  for each row execute function public.enforce_role_change();

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

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

  select a.id, a.age_group into v_athlete_id, v_age_group
  from public.heat_lanes hl
  join public.entries e on e.id = hl.entry_id
  join public.athletes a on a.id = e.athlete_id
  where hl.id = new.heat_lane_id;

  if v_athlete_id is null then
    return new;
  end if;

  insert into public.leaderboards (athlete_id, category, placement_points, improvement_points)
  values (v_athlete_id, v_age_group, delta_placement, delta_improvement)
  on conflict (athlete_id, category) do update
    set placement_points = public.leaderboards.placement_points + excluded.placement_points,
        improvement_points = public.leaderboards.improvement_points + excluded.improvement_points,
        updated_at = now();

  -- 'Open' is a combined ranking of every age group (Results Filter rule),
  -- so non-Open athletes also accumulate into it.
  if v_age_group <> 'Open' then
    insert into public.leaderboards (athlete_id, category, placement_points, improvement_points)
    values (v_athlete_id, 'Open', delta_placement, delta_improvement)
    on conflict (athlete_id, category) do update
      set placement_points = public.leaderboards.placement_points + excluded.placement_points,
          improvement_points = public.leaderboards.improvement_points + excluded.improvement_points,
          updated_at = now();
  end if;

  return new;
end;
$$;

create trigger results_apply_points
  after insert or update on public.results
  for each row execute function public.apply_result_points();

create trigger results_set_updated_at
  before update on public.results
  for each row execute function public.set_updated_at();

create trigger teams_set_updated_at
  before update on public.teams
  for each row execute function public.set_updated_at();

create trigger athletes_set_updated_at
  before update on public.athletes
  for each row execute function public.set_updated_at();

create trigger heats_set_updated_at
  before update on public.heats
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

create trigger enforce_team_approval_change_trigger
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

create trigger enforce_result_scoring_trigger
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

create trigger enforce_no_direct_skins_entry_trigger
  before insert on public.entries
  for each row execute function public.enforce_no_direct_skins_entry();

create trigger skins_qualifications_set_updated_at
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

create trigger enforce_skins_qualification_columns_trigger
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
-- 6. ROW LEVEL SECURITY
-- =============================================================================

alter table public.app_settings enable row level security;
alter table public.users enable row level security;
alter table public.teams enable row level security;
alter table public.team_memberships enable row level security;
alter table public.athletes enable row level security;
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
create policy "admins_manage_app_settings" on public.app_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create policy "admins_full_access_users" on public.users
  for all using (public.is_admin()) with check (public.is_admin());

create policy "users_view_own_profile" on public.users
  for select using (id = auth.uid());

-- Authenticated members can see basic profile info of others (team rosters,
-- captain names, referee/athlete listings) — never role changes though,
-- which remain gated by enforce_role_change_trigger regardless of RLS.
create policy "authenticated_view_profiles" on public.users
  for select using (auth.role() = 'authenticated');

create policy "users_update_own_profile" on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- teams
-- ---------------------------------------------------------------------------
create policy "admins_full_access_teams" on public.teams
  for all using (public.is_admin()) with check (public.is_admin());

create policy "public_view_approved_teams" on public.teams
  for select using (approved_by_admin = true or captain_id = auth.uid());

create policy "authenticated_create_team" on public.teams
  for insert with check (auth.uid() is not null and captain_id = auth.uid());

create policy "captain_update_own_team" on public.teams
  for update using (captain_id = auth.uid()) with check (captain_id = auth.uid());

-- ---------------------------------------------------------------------------
-- team_memberships
-- ---------------------------------------------------------------------------
create policy "admins_full_access_memberships" on public.team_memberships
  for all using (public.is_admin()) with check (public.is_admin());

create policy "user_view_own_memberships" on public.team_memberships
  for select using (
    user_id = auth.uid() or public.is_team_captain_of(team_id)
  );

create policy "user_request_membership" on public.team_memberships
  for insert with check (user_id = auth.uid());

create policy "captain_manage_membership_status" on public.team_memberships
  for update using (public.is_team_captain_of(team_id))
  with check (public.is_team_captain_of(team_id));

-- ---------------------------------------------------------------------------
-- athletes
-- ---------------------------------------------------------------------------
create policy "admins_full_access_athletes" on public.athletes
  for all using (public.is_admin()) with check (public.is_admin());

create policy "athlete_view_own_row" on public.athletes
  for select using (
    user_id = auth.uid()
    or parent_id = auth.uid()
    or public.is_team_captain_of(team_id)
    or public.is_admin_or_referee()
  );

create policy "athlete_update_own_row" on public.athletes
  for update using (user_id = auth.uid() or parent_id = auth.uid())
  with check (user_id = auth.uid() or parent_id = auth.uid());

create policy "user_create_own_athlete_row" on public.athletes
  for insert with check (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- sessions & events — public schedule information.
-- ---------------------------------------------------------------------------
create policy "admins_full_access_sessions" on public.sessions
  for all using (public.is_admin()) with check (public.is_admin());

create policy "public_view_sessions" on public.sessions
  for select using (true);

create policy "admins_full_access_events" on public.events
  for all using (public.is_admin()) with check (public.is_admin());

create policy "public_view_events" on public.events
  for select using (true);

-- ---------------------------------------------------------------------------
-- entries
-- ---------------------------------------------------------------------------
create policy "admins_full_access_entries" on public.entries
  for all using (public.is_admin()) with check (public.is_admin());

create policy "referees_view_entries" on public.entries
  for select using (public.is_admin_or_referee());

create policy "athlete_manage_own_entries" on public.entries
  for all using (public.owns_athlete(athlete_id))
  with check (public.owns_athlete(athlete_id));

-- ---------------------------------------------------------------------------
-- heats & heat_lanes
-- ---------------------------------------------------------------------------
create policy "admins_referees_full_access_heats" on public.heats
  for all using (public.is_admin_or_referee()) with check (public.is_admin_or_referee());

create policy "public_view_published_heats" on public.heats
  for select using (status = 'published');

create policy "admins_referees_full_access_heat_lanes" on public.heat_lanes
  for all using (public.is_admin_or_referee()) with check (public.is_admin_or_referee());

create policy "public_view_published_heat_lanes" on public.heat_lanes
  for select using (
    exists (select 1 from public.heats h where h.id = heat_id and h.status = 'published')
  );

-- ---------------------------------------------------------------------------
-- results
-- ---------------------------------------------------------------------------
create policy "admins_full_access_results" on public.results
  for all using (public.is_admin()) with check (public.is_admin());

-- Referees insert/update result drafts only (publishing is admin-only,
-- enforced by enforce_result_publish trigger below).
create policy "referees_manage_result_drafts" on public.results
  for all using (public.is_referee()) with check (public.is_referee());

create policy "public_view_published_results" on public.results
  for select using (status = 'published');

create or replace function public.enforce_result_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'published' and not public.is_admin() then
    raise exception 'Only an admin may publish results.';
  end if;
  return new;
end;
$$;

create trigger enforce_result_publish_trigger
  before insert or update on public.results
  for each row execute function public.enforce_result_publish();

-- ---------------------------------------------------------------------------
-- leaderboards — public read, system-maintained writes only.
-- ---------------------------------------------------------------------------
create policy "public_view_leaderboards" on public.leaderboards
  for select using (true);

create policy "admins_full_access_leaderboards" on public.leaderboards
  for all using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- skins_qualifications
-- ---------------------------------------------------------------------------
create policy "admins_referees_manage_skins_qualifications"
  on public.skins_qualifications
  for all using (public.is_admin_or_referee())
  with check (public.is_admin_or_referee());

create policy "athlete_view_own_skins_qualification"
  on public.skins_qualifications
  for select using (public.owns_athlete(athlete_id));

-- Athletes (or their under-15 parent) may accept / decline their own slot.
create policy "athlete_respond_own_skins_qualification"
  on public.skins_qualifications
  for update using (public.owns_athlete(athlete_id))
  with check (
    public.owns_athlete(athlete_id)
    and response in ('accepted', 'declined')
  );

create policy "public_view_active_skins_qualifications"
  on public.skins_qualifications
  for select using (true);

-- =============================================================================
-- 7. SEED DATA — Oct 2, 2026 meet sessions
-- =============================================================================

insert into public.sessions (session_number, name, meet_date, start_time, end_time) values
  (1, 'Session 1', '2026-10-02', '09:00', '12:00'),
  (2, 'Session 2', '2026-10-02', '14:00', '16:00'),
  (3, 'Session 3 — Skins', '2026-10-02', '17:00', '19:00')
on conflict (session_number) do nothing;

-- System creator / first-boot admin. Subsequent admins must be promoted via
-- the user-role-management panel by an existing admin. Uses do-update (not
-- do-nothing) so re-running this file always enforces the configured email,
-- even against a project that was already seeded with a placeholder value.
insert into public.app_settings (id, superadmin_email)
values (true, 'elewakareem2002@gmail.com')
on conflict (id) do update set
  superadmin_email = excluded.superadmin_email,
  updated_at = now();
