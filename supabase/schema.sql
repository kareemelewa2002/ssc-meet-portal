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
      'athlete',
      'parent'
    );
  else
    if exists (
      select 1 from pg_enum
      where enumtypid = (select oid from pg_type where typname = 'user_role')
        and enumlabel in ('usher', 'entry_helper', 'team_captain', 'coach')
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
      create type public.user_role as enum ('admin', 'referee', 'athlete', 'parent');
      alter table public.users alter column role drop default;
      alter table public.users alter column role type public.user_role using (
        case role::text
          when 'usher' then 'referee'
          when 'entry_helper' then 'referee'
          -- 'coach' and the older 'team_captain' both become plain athletes.
          -- Captaincy is no longer a ROLE at all: it is teams.captain_id, a
          -- relationship. A role said someone could captain in the abstract
          -- while the actual team pointer said otherwise, which is two
          -- sources of truth for one fact.
          when 'team_captain' then 'athlete'
          when 'coach' then 'athlete'
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
-- Signup no longer offers 'coach': captaincy is a relationship
-- (teams.captain_id), not something you can claim at registration.
drop type if exists public.public_signup_role;
do $$
begin
  if not exists (select 1 from pg_type where typname = 'public_signup_role') then
    create type public.public_signup_role as enum (
      'athlete',
      'parent',
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
      'accepted',
      'invited'
    );
  end if;
end $$;

-- Deliberately NOT wrapped in a DO block — see the comment on
-- entry_status's 'hold_expired' below for why. 'invited' is the captain-
-- initiated direction (captain picks an unattached athlete, athlete
-- accepts/declines) — the opposite of 'pending' (athlete requests, captain
-- accepts/rejects). Both directions land on the same table and reuse the
-- same accept trigger (sync_athlete_team_on_membership_accept below).
alter type public.membership_status add value if not exists 'invited';

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
--
-- 'hold_expired' is what an unpaid entry becomes when its hold window lapses:
-- the slot is released back to the race and the entry stops counting against
-- capacity, but the entry itself SURVIVES. Deleting it would make an athlete's
-- registration vanish with no trace and no way to reclaim it; this way both the
-- athlete and the admin can still see it, and [Pay now] can re-acquire the slot
-- if the race still has room.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'entry_status') then
    create type public.entry_status as enum (
      'pending_payment',
      'confirmed'
    );
  end if;
end $$;

-- Deliberately NOT wrapped in a DO block. ALTER TYPE ... ADD VALUE may not be
-- used in the same transaction that adds it, and a DO block is a transaction —
-- the bare statement with IF NOT EXISTS autocommits and is idempotent on its
-- own, which is what re-running this file needs.
alter type public.entry_status add value if not exists 'hold_expired';

-- The three pricing phases. Which one is in force is decided by date, unless an
-- admin has pinned one (see public.meet_settings.pinned_pricing_tier).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'pricing_tier') then
    create type public.pricing_tier as enum (
      'early_bird',
      'standard',
      'late'
    );
  end if;
end $$;

-- What a race looks like to a swimmer deciding whether to enter it. Derived
-- from live capacity, never stored — see public.event_capacity().
do $$
begin
  if not exists (select 1 from pg_type where typname = 'event_availability') then
    create type public.event_availability as enum (
      'available',
      'selling_out_soon',
      'full'
    );
  end if;
end $$;

-- Notification categories. The split is not cosmetic: 'entry_payment' and
-- 'waitlist' carry clocks — a missed hold expiry or a missed 24h claim window
-- costs the athlete their slot — so those two cannot be muted. See
-- public.notification_preferences.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'notification_category') then
    create type public.notification_category as enum (
      'team',
      'entry_payment',
      'waitlist',
      'results_schedule'
    );
  end if;
end $$;

-- Deliberately a DISTINCT category from 'team', not folded into it. 'team'
-- already covers join-request notices (captain-facing, actionable); an
-- announcement is captain-authored and athlete-facing, informational. A
-- swimmer who wants fewer motivational-message emails should not lose
-- visibility into their own join-request outcomes as a side effect, and vice
-- versa for a captain who wants fewer team-management emails but still wants
-- to read their own team's announcements.
--
-- Bare statement, not inside a DO block: ALTER TYPE ... ADD VALUE cannot run
-- in the same transaction that later uses the new value, and a DO block is a
-- transaction. IF NOT EXISTS makes the bare form idempotent on its own,
-- which is what re-running this file needs — same pattern as entry_status's
-- 'hold_expired' above.
alter type public.notification_category add value if not exists 'announcement';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_delivery_status') then
    create type public.email_delivery_status as enum (
      'pending',
      'sent',
      'failed',
      'skipped'
    );
  end if;
end $$;

-- Waitlist entries are a queue, and a queue needs to say where each member is
-- in it. 'offered' is the only state with a deadline attached.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'waitlist_status') then
    create type public.waitlist_status as enum (
      'waiting',
      'offered',
      'claimed',
      'expired',
      'withdrawn'
    );
  end if;
end $$;

-- =============================================================================
-- 2. CORE TABLES
-- =============================================================================

-- Defined before the tables because public.entry_payments and
-- public.relay_squad_payments both use it as a column DEFAULT, and a default
-- expression must resolve at CREATE TABLE time — a from-scratch apply fails
-- outright if this lives further down beside the other helper functions.
create or replace function public.current_collector()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select auth.uid() $$;

comment on function public.current_collector() is
  'auth.uid() behind a SECURITY DEFINER wrapper, so it is reachable from a '
  'column DEFAULT. A default is evaluated as the INSERTING role, and that '
  'role is not guaranteed USAGE on schema auth — the RLS suite''s scratch '
  'cluster grants it on public only, and a bare `default auth.uid()` fails '
  'there with "permission denied for schema auth". RLS policies get away '
  'with calling auth.uid() directly because policy expressions are evaluated '
  'as the table owner; defaults and SECURITY INVOKER triggers are not.';


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
-- team_invite_links — a shareable URL a captain hands to someone OUTSIDE the
-- app who has no account yet. Deliberately not a team_memberships row: that
-- table's user_id is a not-null FK to public.users, and there is no user
-- row until the invitee actually finishes signing up. One reusable link per
-- team (regenerating replaces it, see revoked_at), not one link per
-- invitee — the token is meant to be pasted into a group chat, not minted
-- fresh for each person.
--
-- Redemption happens at registration time via
-- public.redeem_team_invite_token() (below), NOT a direct SELECT — an
-- unauthenticated visitor evaluating whether a link is still valid must not
-- be able to enumerate every token in this table.
-- ---------------------------------------------------------------------------
create table if not exists public.team_invite_links (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  token text not null unique,
  created_by uuid not null references public.users (id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  use_count integer not null default 0
);
create index if not exists team_invite_links_team_idx on public.team_invite_links (team_id);

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
  -- Vestigial. Account approval was removed: paying the entry fee is the
  -- seriousness signal, and confirming that payment is the admin's decision
  -- point. Kept only for historical rows and the admin "deactivate"
  -- affordance, so it defaults to true and gates nothing.
  approved_by_admin boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent column add for databases that already had athletes without approval.
-- Legacy teardown: a previous generation of this schema guarded
-- approved_by_admin with a trigger that raises when auth.uid() is NULL. The
-- Supabase SQL editor runs as superuser with no JWT, so that trigger made
-- this very file un-rerunnable against any database it had already been
-- applied to. CASCADE drops the dependent trigger with the function.
drop function if exists public.enforce_athlete_approval_change() cascade;

-- Retained for historical rows and for the admin "deactivate" affordance,
-- but it no longer gates anything: athletes are approved on creation. The
-- real gate is payment — an admin confirms cash at the desk, which confirms
-- the entries and seeds the heats. A separate account-approval step just
-- meant a swimmer could pay and still not be able to swim.
alter table public.athletes
  add column if not exists approved_by_admin boolean not null default true;
alter table public.athletes alter column approved_by_admin set default true;
update public.athletes set approved_by_admin = true where approved_by_admin = false;

-- ---------------------------------------------------------------------------
-- SAFETY & PRIVACY ACKNOWLEDGEMENT
-- ---------------------------------------------------------------------------
-- Every swimmer must accept that they are responsible for their own safety
-- and personal belongings on event days. For a U14 that acceptance is not
-- theirs to give: a minor cannot waive their own liability, so it must be
-- recorded against the linked parent's account instead. accepted_by stores
-- WHO actually clicked it, which is the part that matters if it is ever
-- disputed — a boolean alone would not tell you whether the child or the
-- guardian agreed.
alter table public.athletes
  add column if not exists safety_accepted_at timestamptz,
  add column if not exists safety_accepted_by uuid references public.users (id);

comment on column public.athletes.safety_accepted_at is
  'When the safety & privacy acknowledgement was accepted. NULL = outstanding.';
comment on column public.athletes.safety_accepted_by is
  'WHO accepted: the swimmer themselves (15+), or the linked parent for a U14.';

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
  -- Whether this volume is announced to the public. Deliberately a SEPARATE
  -- axis from `status`: status is the meet's own lifecycle (has a date been
  -- set, has it happened), is_public is a business decision an admin makes
  -- explicitly ("clients have agreed to this, tell the world"). A volume can
  -- be fully scheduled and internally ready while is_public stays false —
  -- that gap is the whole point of the column: it is the window in which a
  -- meet gets built and priced before anyone announces it.
  --
  -- VISIBILITY RULE (enforced in RLS below, not just in app code):
  --   public sees a volume  <=>  is_public = true AND status <> 'planned'
  -- A 'planned' volume has no meet_date and nothing scheduled — flipping
  -- is_public on one does not make it a public "Coming Soon" card; it stays
  -- hidden until it also becomes 'scheduled'. Admins bypass this rule
  -- entirely (see is_admin() in every policy that reads this table).
  is_public boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent column add for databases created before is_public existed.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'meet_volumes' and column_name = 'is_public'
  ) then
    alter table public.meet_volumes add column is_public boolean not null default false;

    -- Backfill ONLY on first creation of the column. Every volume that is
    -- already visible today (status <> 'planned') gets is_public = true, so
    -- this migration does not silently take a live, already-public meet
    -- offline the moment it runs. A volume already sitting at 'planned'
    -- stays is_public = false, which changes nothing for it — it was already
    -- hidden by status alone.
    --
    -- This block cannot fire on a later re-run of this file (the IF NOT
    -- EXISTS guard above sees the column already exists), so an admin who
    -- has since deliberately unpublished a scheduled volume will never have
    -- that choice silently reverted by re-applying schema.sql.
    update public.meet_volumes set is_public = true where status <> 'planned';
  end if;
end $$;

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

-- Heat turnaround is deliberately NOT a column here: it is an admin dial, and
-- it lives with the other dials on public.meet_settings, keyed by the same
-- (meet_volume_id, session_number). This table answers "when does session 2
-- run"; that one answers "how is session 2 configured".
create index if not exists sessions_meet_volume_id_idx on public.sessions (meet_volume_id);

-- An earlier draft of the Control Unit put turnaround here as well as on
-- meet_settings. Two writable copies of one number is how they drift, so the
-- column is dropped if a database picked it up.
alter table public.sessions drop column if exists heat_turnaround_seconds;

-- ---------------------------------------------------------------------------
-- meet_settings — the Admin Control Unit's dials, one row per VOLUME.
-- ---------------------------------------------------------------------------
-- This table was keyed (meet_volume_id, session_number) for exactly one
-- release. It is now one row per volume, because pricing moved to packages
-- counted across the WHOLE meet: an athlete who swims two races in Session 1
-- and one in Session 2 has entered a three-race package, not two packages, and
-- there is no way to assemble a cross-session basket price out of per-session
-- unit prices. The migration that collapses the old shape is directly below.
--
-- Session-level differentiation did not disappear, it moved to where it can
-- actually be expressed: a race that costs more (a 400 IM, a Skins race) says
-- so through its own surcharge on public.events, per race rather than per
-- session.
--
-- WHAT IS DELIBERATELY *NOT* HERE:
--
--   * Session start and end times. public.sessions owns them and is what every
--     schedule/heat-sheet query already reads. A second writable copy would be
--     two sources of truth for one fact — the same mistake as the retired
--     'coach' role sitting alongside teams.captain_id, where the two could
--     disagree and nothing said which one was right.
--   * Heat turnaround. It is per EVENT now (public.events.turnaround_seconds):
--     a 50m sprint clears the pool far faster than a 400 IM or a relay, and one
--     number averaged across them is wrong in both directions. Session duration
--     is summed from the events actually scheduled in it.
--   * The individual race price. That is the pricing matrix — see
--     public.pricing_packages.
--   * Results display. Whether World Aquatics points show, and whether DQ/NS
--     sort to the bottom, are correctness rather than preference. An admin
--     should not be able to configure results into being misleading.
--
-- A client that cannot read this table must show an error, never a plausible
-- number: quoting a swimmer a price because the settings query FAILED is
-- exactly the silent-fallback failure lib/fetch-policy.ts exists to prevent. A
-- row that is simply ABSENT is a different thing — an unconfigured volume, not
-- a failure — and lib/meet-settings.ts answers that with DEFAULT_MEET_SETTINGS.
create table if not exists public.meet_settings (
  id uuid primary key default gen_random_uuid(),
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,

  -- --- Capacity and schedule ------------------------------------------------
  -- How many swimmers one session can physically take. Feeds the Control
  -- Unit's derived event-limit ceiling; a planning figure, not a hard gate.
  athlete_capacity integer not null default 200 check (athlete_capacity > 0),
  -- Lanes in the pool. Was hardcoded; it belongs to the capacity arithmetic.
  lane_count integer not null default 8 check (lane_count between 1 and 20),
  -- Dead time between sessions — warm-up, clearing the deck, officials' break.
  inter_session_break_minutes integer not null default 30
    check (inter_session_break_minutes >= 0),
  -- Replaces lib/event-registration.ts's flat MAX_EVENTS_PER_MEET = 4. The
  -- Control Unit shows the admin the maximum the schedule can absorb, but
  -- does NOT clamp this to it: the admin decides, the readout warns. It may
  -- exceed 4, which is why the pricing matrix needs an additional-race price.
  athlete_event_limit integer not null default 4
    check (athlete_event_limit between 1 and 20),

  -- --- Registration window --------------------------------------------------
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  -- Lets an admin keep taking entries past the close without moving the
  -- published deadline (which athletes may have screenshotted).
  late_registration_enabled boolean not null default false,

  -- --- Holds, capacity signalling and the waitlist --------------------------
  -- How long an unpaid entry keeps its slot. The compromise between two
  -- failure modes: count only paid entries and an athlete can be told after
  -- registering that the race is full; hold unpaid slots forever and a
  -- reserve-and-never-pay pattern locks a race out.
  hold_window_hours integer not null default 48
    check (hold_window_hours between 1 and 720),
  -- How long the athlete at the head of a waitlist has to claim a freed slot
  -- before it passes to the next in line.
  waitlist_claim_hours integer not null default 24
    check (waitlist_claim_hours between 1 and 168),
  -- At or below this share of a race's cap remaining, the race reads
  -- "selling out soon" rather than "available".
  selling_out_threshold_percent integer not null default 20
    check (selling_out_threshold_percent between 0 and 100),
  -- Starting capacity for a race that has not been given its own cap.
  default_event_capacity integer not null default 64
    check (default_event_capacity > 0),

  -- --- Pricing --------------------------------------------------------------
  -- Per SWIMMER on a relay squad, not per squad — a four-swimmer squad pays
  -- four of these. A relay leg does NOT count toward the athlete's individual
  -- race package; it is charged on top. Flat, not tiered.
  relay_swimmer_price_egp integer not null default 300
    check (relay_swimmer_price_egp >= 0),
  -- Overrides the date windows on public.pricing_tiers when set. Null means
  -- "decide by date", which is the normal state; a value here is an admin
  -- deliberately holding a tier open (extending a deadline, covering an
  -- outage). Stored rather than inferred so the override survives a reload and
  -- is visible to anyone reading the table.
  pinned_pricing_tier public.pricing_tier,

  -- --- Refunds --------------------------------------------------------------
  -- What a withdrawing athlete gets back, and until when. 0 with a null
  -- deadline is "no refunds", which is a policy, not an absence of one.
  refund_percent integer not null default 0 check (refund_percent between 0 and 100),
  refund_deadline_days integer check (refund_deadline_days >= 0),
  refund_policy_note text,

  updated_at timestamptz not null default now(),
  unique (meet_volume_id)
);

-- Migration off the one-release-only per-session shape. Keeps session 1's row
-- as the volume's row and discards 2 and 3: their prices are superseded by the
-- package matrix, and their capacity/turnaround by per-event values, so there
-- is nothing in them worth merging. Guarded on the column still existing, so
-- this is a no-op on a fresh database and on any subsequent run.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'meet_settings'
      and column_name = 'session_number'
  ) then
    delete from public.meet_settings where session_number <> 1;
    alter table public.meet_settings
      drop constraint if exists meet_settings_meet_volume_id_session_number_key;
    alter table public.meet_settings drop column session_number;
  end if;
end $$;

-- Columns retired into other tables. Dropped rather than left dormant: a stale
-- writable price column is exactly how two sources of truth for one number get
-- created, and someone would eventually read it.
alter table public.meet_settings drop column if exists heat_turnaround_seconds;
alter table public.meet_settings drop column if exists individual_event_price_egp;

-- Existing databases predating the columns above.
alter table public.meet_settings
  add column if not exists lane_count integer not null default 8,
  add column if not exists inter_session_break_minutes integer not null default 30,
  add column if not exists registration_opens_at timestamptz,
  add column if not exists registration_closes_at timestamptz,
  add column if not exists late_registration_enabled boolean not null default false,
  add column if not exists hold_window_hours integer not null default 48,
  add column if not exists waitlist_claim_hours integer not null default 24,
  add column if not exists selling_out_threshold_percent integer not null default 20,
  add column if not exists default_event_capacity integer not null default 64,
  add column if not exists pinned_pricing_tier public.pricing_tier,
  add column if not exists refund_percent integer not null default 0,
  add column if not exists refund_deadline_days integer,
  add column if not exists refund_policy_note text;

-- The unique key changed shape along with the table.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.meet_settings'::regclass
      and conname = 'meet_settings_meet_volume_id_key'
  ) then
    alter table public.meet_settings
      add constraint meet_settings_meet_volume_id_key unique (meet_volume_id);
  end if;
end $$;

create index if not exists meet_settings_meet_volume_id_idx
  on public.meet_settings (meet_volume_id);

comment on table public.meet_settings is
  'Admin Control Unit dials, one row per meet volume: capacity, lanes, holds, '
  'waitlist windows, registration window, refund policy, relay price and the '
  'pricing-tier pin. Session times live on public.sessions; heat turnaround '
  'and race surcharge live per-event on public.events; the individual race '
  'price is the matrix in public.pricing_packages.';

-- Backfill: every existing volume gets a settings row, and the three default
-- clock windows land on public.sessions where the times live. Both are ON
-- CONFLICT DO NOTHING, so re-running this file never overwrites a setting an
-- admin has since changed — which is the whole point of doing it here rather
-- than in seed-demo.sql, a file that deliberately destroys data.
insert into public.meet_settings (meet_volume_id)
select v.id from public.meet_volumes v
on conflict (meet_volume_id) do nothing;

-- The default clock window for each of the three sessions. Sessions that
-- already exist keep the times they were scheduled with — this is the fallback
-- used when a session is created without one, and the figure the Control Unit
-- offers as a starting point. Kept in SQL rather than only in TypeScript so
-- the database can create a well-formed session on its own.
create or replace function public.default_session_window(p_session_number integer)
returns table (start_time time, end_time time)
language sql
immutable
as $$
  -- s, e only: `select *` here would also return the `n` discriminator and
  -- the function would not match its two-column return type.
  select w.s, w.e from (values
    (1, time '09:00', time '13:00'),
    (2, time '13:30', time '17:00'),
    (3, time '17:30', time '21:00')
  ) as w(n, s, e)
  where w.n = p_session_number;
$$;

comment on function public.default_session_window(integer) is
  'Default start/end clock for sessions 1-3 (09:00-13:00, 13:30-17:00, '
  '17:30-21:00). Existing sessions keep their scheduled times; this is the '
  'starting point offered for a new one.';

-- ---------------------------------------------------------------------------
-- pricing_tiers — when each of the three pricing phases is in force.
-- ---------------------------------------------------------------------------
-- Dates decide the active tier; meet_settings.pinned_pricing_tier overrides
-- them when an admin needs to hold one open. Both live in the Control Unit.
--
-- The windows are stored as timestamptz rather than date because a tier
-- boundary is a moment, not a day: "Early Bird ends on the 20th" has to mean a
-- specific instant or two athletes paying minutes apart get different answers
-- depending on the server's idea of midnight.
create table if not exists public.pricing_tiers (
  id uuid primary key default gen_random_uuid(),
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,
  tier public.pricing_tier not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (meet_volume_id, tier),
  constraint pricing_tiers_window_ordered check (ends_at > starts_at)
);

create index if not exists pricing_tiers_meet_volume_id_idx
  on public.pricing_tiers (meet_volume_id);

comment on table public.pricing_tiers is
  'Date window for each of the three pricing phases, per volume. The active '
  'tier is the one whose window contains now(), unless '
  'meet_settings.pinned_pricing_tier overrides it.';

-- ---------------------------------------------------------------------------
-- pricing_packages — the 4 x 3 matrix.
-- ---------------------------------------------------------------------------
-- race_count 1-4 are the four packages. race_count 0 is NOT a package: it is
-- the "each additional race" price, used for a race added after payment and
-- for every race beyond the fourth when an admin has raised
-- athlete_event_limit above 4. Storing it as a row in the same table rather
-- than a column on meet_settings keeps one place to look up "what does a race
-- cost at tier T", and it is tiered exactly like the packages are.
--
-- Per the pricing decision, the additional-race price is the 1-race package
-- price; the seed below sets them equal. They are separate rows so an admin can
-- later diverge them without a schema change.
create table if not exists public.pricing_packages (
  id uuid primary key default gen_random_uuid(),
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,
  -- 1-4: the package for entering exactly that many individual races.
  -- 0: the per-race price for anything beyond the largest package.
  race_count integer not null check (race_count between 0 and 4),
  tier public.pricing_tier not null,
  price_egp integer not null check (price_egp >= 0),
  updated_at timestamptz not null default now(),
  unique (meet_volume_id, race_count, tier)
);

create index if not exists pricing_packages_meet_volume_id_idx
  on public.pricing_packages (meet_volume_id);

comment on table public.pricing_packages is
  'The 4x3 pricing matrix per volume: race_count 1-4 are the packages, '
  'race_count 0 is the each-additional-race price used past the largest '
  'package. Totals also add per-event surcharges and relay fees.';

-- Default matrix and tier windows for every volume that has none. Prices
-- ascend across tiers and give a small break for entering more races; they are
-- a starting point for the admin, not a recommendation. ON CONFLICT DO NOTHING
-- throughout: re-running this file must never reset a price an admin has set.
insert into public.pricing_packages (meet_volume_id, race_count, tier, price_egp)
select v.id, m.race_count, m.tier::public.pricing_tier, m.price_egp
from public.meet_volumes v
cross join (values
  -- additional / beyond-package race, equal to the 1-race package
  (0, 'early_bird', 200), (0, 'standard', 300), (0, 'late', 400),
  (1, 'early_bird', 200), (1, 'standard', 300), (1, 'late', 400),
  (2, 'early_bird', 380), (2, 'standard', 560), (2, 'late', 740),
  (3, 'early_bird', 540), (3, 'standard', 700), (3, 'late', 960),
  (4, 'early_bird', 680), (4, 'standard', 900), (4, 'late', 1200)
) as m(race_count, tier, price_egp)
on conflict (meet_volume_id, race_count, tier) do nothing;

-- Default tier windows, anchored on the volume's meet_date so they mean
-- something: Early Bird until six weeks out, Standard until one week out, Late
-- through meet day. A volume with no meet_date yet gets windows anchored on
-- today, which the admin will move when the date is set.
insert into public.pricing_tiers (meet_volume_id, tier, starts_at, ends_at)
select
  v.id,
  w.tier::public.pricing_tier,
  (coalesce(v.meet_date, current_date) + w.starts_days)::timestamptz,
  (coalesce(v.meet_date, current_date) + w.ends_days)::timestamptz
from public.meet_volumes v
cross join (values
  ('early_bird', -180, -42),
  ('standard',    -42,  -7),
  ('late',         -7,   1)
) as w(tier, starts_days, ends_days)
on conflict (meet_volume_id, tier) do nothing;

-- ---------------------------------------------------------------------------
-- public.active_pricing_tier — which tier a volume is selling at right now.
-- ---------------------------------------------------------------------------
-- Resolution order, and the reason for each step:
--   1. An admin pin, if set. A deliberate override outranks the calendar.
--   2. The tier whose date window contains now().
--   3. Before the first window opens: the earliest tier — a meet that has not
--      started selling should quote Early Bird, not nothing.
--   4. After the last window closes: the latest tier. Registration being
--      closed is a separate question, answered by the registration window;
--      whatever still gets sold sells at the last price, never at Early Bird.
-- Never returns null, because every caller of this would otherwise have to
-- invent a price, and inventing prices is the failure mode this schema is
-- built to prevent.
create or replace function public.active_pricing_tier(p_meet_volume_id uuid)
returns public.pricing_tier
language sql
stable
as $$
  select coalesce(
    (select ms.pinned_pricing_tier
       from public.meet_settings ms
      where ms.meet_volume_id = p_meet_volume_id),
    (select pt.tier
       from public.pricing_tiers pt
      where pt.meet_volume_id = p_meet_volume_id
        and now() >= pt.starts_at and now() < pt.ends_at
      order by pt.starts_at
      limit 1),
    (select pt.tier
       from public.pricing_tiers pt
      where pt.meet_volume_id = p_meet_volume_id
        and pt.starts_at > now()
      order by pt.starts_at
      limit 1),
    (select pt.tier
       from public.pricing_tiers pt
      where pt.meet_volume_id = p_meet_volume_id
      order by pt.ends_at desc
      limit 1),
    'standard'::public.pricing_tier
  );
$$;

comment on function public.active_pricing_tier(uuid) is
  'The pricing tier in force for a volume now: an admin pin if set, else the '
  'tier whose date window contains now(), else the nearest window on either '
  'side. Never null — a caller with no tier would have to invent a price.';

-- The set_updated_at trigger for this table is created alongside the others,
-- below public.set_updated_at() itself.

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
  -- True for events with no official long course equivalent: the 50m
  -- stroke-switch events, and the 100m IM (a short-course-only event). A
  -- swimmer has no comparable time to declare for these, so entries are
  -- forced to NT and seeded from World Aquatics points instead — see
  -- public.athlete_best_wa_points(). Note this is about ENTRY, not scoring:
  -- the 100 IM still has a base time and its results still earn points.
  seeds_as_nt boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.events add column if not exists seeds_as_nt boolean not null default false;

-- Existing databases. Two families of event have no official long course
-- equivalent, so a swimmer has nothing to declare:
--   * the 50m stroke-switch events (25m + 25m of two strokes), and
--   * the 100m Individual Medley, which is only ever swum short course.
update public.events
set seeds_as_nt = true
where seeds_as_nt = false
  and (stroke ilike '%switch%' or (stroke = 'Individual Medley' and is_relay = false));

-- Idempotent column add for databases created before is_relay existed.
alter table public.events
  add column if not exists is_relay boolean not null default false;

-- ---------------------------------------------------------------------------
-- Per-event turnaround, surcharge and capacity.
-- ---------------------------------------------------------------------------
-- All three are per EVENT, and every event's values are editable. The
-- race-shape template below only supplies the STARTING value when an event is
-- created; it constrains nothing afterwards.
--
-- Turnaround used to be one number per session. That is wrong in both
-- directions at once: a session budgeted at a 400 IM's turnaround wastes most
-- of its afternoon on 50s, and one budgeted at a 50's overruns the moment a
-- distance event appears. Session duration is now summed from the events
-- actually scheduled in it.
--
-- Surcharge is what makes a 400 IM cost more than a 50 Free. It is added on top
-- of the athlete's package price, per race entered.
alter table public.events
  add column if not exists turnaround_seconds integer,
  add column if not exists surcharge_egp integer,
  add column if not exists capacity_cap integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass and conname = 'events_turnaround_positive'
  ) then
    alter table public.events add constraint events_turnaround_positive
      check (turnaround_seconds is null or turnaround_seconds > 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass and conname = 'events_surcharge_non_negative'
  ) then
    alter table public.events add constraint events_surcharge_non_negative
      check (surcharge_egp is null or surcharge_egp >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.events'::regclass and conname = 'events_capacity_positive'
  ) then
    alter table public.events add constraint events_capacity_positive
      check (capacity_cap is null or capacity_cap > 0);
  end if;
end $$;

comment on column public.events.turnaround_seconds is
  'Wall-clock budget for one heat of THIS event: the swim plus clearing the '
  'water and getting the next field behind the blocks. Seeded from the '
  'race-shape template, editable per event. Null falls back to the template.';
comment on column public.events.surcharge_egp is
  'Added to the athlete package price for entering this race. Null falls back '
  'to the race-shape template.';
comment on column public.events.capacity_cap is
  'Maximum entries this race accepts. Null falls back to '
  'meet_settings.default_event_capacity.';

create index if not exists events_session_id_idx on public.events (session_id);

-- ---------------------------------------------------------------------------
-- race_shape_templates — default turnaround and surcharge per kind of race.
-- ---------------------------------------------------------------------------
-- public.events rows are recreated for every volume. Without a template an
-- admin retypes ~40 pairs of numbers per volume with nothing to catch a missed
-- one; with it, a new volume starts sensible and only the differences get
-- touched.
--
-- Matching is most-specific-first: an exact (distance, stroke) beats a
-- distance-only row, which beats the relay/any fallback. stroke null means
-- "any stroke at this distance".
create table if not exists public.race_shape_templates (
  id uuid primary key default gen_random_uuid(),
  distance_m integer check (distance_m is null or distance_m > 0),
  -- Null = any stroke. Matched case-insensitively against events.stroke.
  stroke text,
  is_relay boolean not null default false,
  turnaround_seconds integer not null check (turnaround_seconds > 0),
  surcharge_egp integer not null default 0 check (surcharge_egp >= 0),
  updated_at timestamptz not null default now()
);

-- A partial unique index rather than a table constraint: null distance_m and
-- null stroke are legitimate wildcard rows, and plain UNIQUE treats every null
-- as distinct, which would let duplicate wildcards accumulate silently.
create unique index if not exists race_shape_templates_shape_key
  on public.race_shape_templates (
    coalesce(distance_m, -1), lower(coalesce(stroke, '*')), is_relay
  );

comment on table public.race_shape_templates is
  'Default turnaround and surcharge by race shape, used to seed new events. '
  'Matched most-specific-first: (distance, stroke) then (distance, any) then '
  'the relay/any fallback. Editable per event afterwards — this constrains '
  'nothing, it only supplies a starting value.';

insert into public.race_shape_templates
  (distance_m, stroke, is_relay, turnaround_seconds, surcharge_egp)
values
  (null,  null,               true,   120, 0),
  (50,    null,               false,   45, 0),
  (100,   null,               false,   60, 0),
  (100,   'Individual Medley', false,  60, 25),
  (200,   null,               false,   90, 50),
  (400,   null,               false,  150, 150),
  (800,   null,               false,  240, 200),
  (1500,  null,               false,  420, 250),
  (null,  null,               false,   90, 0)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- public.template_for_race — the template row matching a race shape.
-- ---------------------------------------------------------------------------
-- Ordering is the whole function: an exact distance+stroke match must outrank
-- a distance-only match, which must outrank the catch-all, or a 100 IM would
-- silently pick up the plain-100 surcharge of zero.
create or replace function public.template_for_race(
  p_distance_m integer,
  p_stroke text,
  p_is_relay boolean
)
returns table (turnaround_seconds integer, surcharge_egp integer)
language sql
stable
as $$
  select t.turnaround_seconds, t.surcharge_egp
  from public.race_shape_templates t
  where t.is_relay = coalesce(p_is_relay, false)
    and (t.distance_m is null or t.distance_m = p_distance_m)
    and (t.stroke is null or lower(t.stroke) = lower(coalesce(p_stroke, '')))
  order by
    (t.distance_m is not null) desc,
    (t.stroke is not null) desc
  limit 1;
$$;

comment on function public.template_for_race(integer, text, boolean) is
  'The race_shape_templates row matching a race, most specific first: exact '
  'distance+stroke, then distance-only, then the catch-all.';

-- ---------------------------------------------------------------------------
-- Seed an event's turnaround/surcharge/cap from the template on insert.
-- ---------------------------------------------------------------------------
-- Only fills what the caller left null, so an INSERT that states its own
-- values keeps them. The admin's edits are never overwritten: this fires on
-- insert only, not on update.
create or replace function public.set_event_defaults_from_template()
returns trigger
language plpgsql
as $$
declare
  v_tpl record;
  v_default_cap integer;
begin
  if new.turnaround_seconds is null or new.surcharge_egp is null then
    select * into v_tpl
    from public.template_for_race(new.distance_m, new.stroke, new.is_relay);

    if found then
      new.turnaround_seconds := coalesce(new.turnaround_seconds, v_tpl.turnaround_seconds);
      new.surcharge_egp := coalesce(new.surcharge_egp, v_tpl.surcharge_egp);
    end if;
  end if;

  if new.capacity_cap is null then
    select ms.default_event_capacity into v_default_cap
    from public.meet_settings ms
    join public.sessions s on s.meet_volume_id = ms.meet_volume_id
    where s.id = new.session_id;

    new.capacity_cap := v_default_cap;
  end if;

  return new;
end;
$$;

create or replace trigger set_event_defaults_from_template_trigger
  before insert on public.events
  for each row execute function public.set_event_defaults_from_template();

-- Backfill events that predate these columns. Guarded on IS NULL so an admin's
-- edits survive every re-run of this file.
-- Correlated scalar subqueries rather than UPDATE ... FROM func(e.col): a
-- set-returning function in the FROM list cannot reference the UPDATE target
-- without LATERAL, and LATERAL against the target is not allowed either.
update public.events e
set turnaround_seconds = coalesce(
      e.turnaround_seconds,
      (select t.turnaround_seconds
         from public.template_for_race(e.distance_m, e.stroke, e.is_relay) t)),
    surcharge_egp = coalesce(
      e.surcharge_egp,
      (select t.surcharge_egp
         from public.template_for_race(e.distance_m, e.stroke, e.is_relay) t))
where e.turnaround_seconds is null or e.surcharge_egp is null;

update public.events e
set capacity_cap = ms.default_event_capacity
from public.sessions s
join public.meet_settings ms on ms.meet_volume_id = s.meet_volume_id
where e.session_id = s.id and e.capacity_cap is null;

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
-- Capacity holds on an unpaid entry.
-- ---------------------------------------------------------------------------
-- Registering reserves a slot immediately, but not forever. hold_expires_at is
-- stamped on insert from meet_settings.hold_window_hours; once it passes, the
-- slot stops counting against the race's cap.
--
-- This is the middle ground between two failure modes. Count only PAID entries
-- and an athlete can register, walk to the desk, and be told the race filled up
-- on the way. Hold unpaid slots forever and one person registering for
-- everything with no intention of paying locks out a race.
alter table public.entries
  add column if not exists hold_expires_at timestamptz;

create index if not exists entries_hold_expires_at_idx
  on public.entries (hold_expires_at)
  where hold_expires_at is not null;

comment on column public.entries.hold_expires_at is
  'When an unpaid entry stops holding its capacity slot. Set on insert from '
  'meet_settings.hold_window_hours; cleared when the entry is confirmed.';

-- Stamp the hold on insert, and clear it the moment payment lands. A confirmed
-- entry with a live expiry would eventually be swept and have its slot taken
-- away after the athlete had already paid for it.
create or replace function public.set_entry_hold_expiry()
returns trigger
language plpgsql
as $$
declare
  v_hours integer;
begin
  if new.status = 'pending_payment' and new.hold_expires_at is null then
    select ms.hold_window_hours into v_hours
    from public.meet_settings ms
    join public.sessions s on s.meet_volume_id = ms.meet_volume_id
    join public.events e on e.session_id = s.id
    where e.id = new.event_id;

    new.hold_expires_at := now() + make_interval(hours => coalesce(v_hours, 48));
  elsif new.status = 'confirmed' then
    new.hold_expires_at := null;
  end if;

  return new;
end;
$$;

create or replace trigger set_entry_hold_expiry_trigger
  before insert or update of status on public.entries
  for each row execute function public.set_entry_hold_expiry();

-- ---------------------------------------------------------------------------
-- public.event_capacity — what a race looks like right now.
-- ---------------------------------------------------------------------------
-- Held slots are counted with a LIVE comparison against hold_expires_at rather
-- than by reading the entry's status. The scheduled sweep is what flips a
-- lapsed hold to 'hold_expired' and fires the notification, but the sweep runs
-- every 15 minutes and could fail or be paused. Deriving the number here means
-- capacity is correct in the gaps: a race can never read as full because a
-- background job did not run.
--
-- The sweep owns the side effects. This function owns the truth.
create or replace function public.event_capacity(p_event_id uuid)
returns table (
  capacity_cap integer,
  paid_count integer,
  held_count integer,
  free_count integer,
  availability public.event_availability
)
language sql
stable
as $$
  with cap as (
    select coalesce(e.capacity_cap, ms.default_event_capacity, 64) as cap,
           coalesce(ms.selling_out_threshold_percent, 20) as threshold
    from public.events e
    join public.sessions s on s.id = e.session_id
    left join public.meet_settings ms on ms.meet_volume_id = s.meet_volume_id
    where e.id = p_event_id
  ),
  counts as (
    select
      count(*) filter (where en.status = 'confirmed')::integer as paid,
      count(*) filter (
        where en.status = 'pending_payment'
          and (en.hold_expires_at is null or en.hold_expires_at > now())
      )::integer as held
    from public.entries en
    where en.event_id = p_event_id
  )
  select
    cap.cap,
    counts.paid,
    counts.held,
    greatest(cap.cap - counts.paid - counts.held, 0)::integer as free_count,
    case
      when cap.cap - counts.paid - counts.held <= 0 then 'full'
      -- Integer arithmetic rather than a float ratio: at cap 64 and a 20%
      -- threshold this is "13 or fewer left", which is a number an admin can
      -- check by hand against what the screen says.
      when (cap.cap - counts.paid - counts.held) * 100 <= cap.cap * cap.threshold
        then 'selling_out_soon'
      else 'available'
    end::public.event_availability
  from cap, counts;
$$;

comment on function public.event_capacity(uuid) is
  'Live capacity for a race: cap, paid, held (expiry compared against now(), '
  'not read from status), free, and the availability state. Correct between '
  'sweeps and correct if a sweep never runs.';

-- ---------------------------------------------------------------------------
-- event_waitlist — the queue for a full race.
-- ---------------------------------------------------------------------------
-- Position is derived from requested_at rather than stored. A stored integer
-- would have to be renumbered on every withdrawal, and any missed renumber
-- leaves two athletes believing they are third.
create table if not exists public.event_waitlist (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  status public.waitlist_status not null default 'waiting',
  requested_at timestamptz not null default now(),
  -- Set when this athlete is offered a freed slot. Past it, the offer lapses
  -- and passes to the next in line.
  offered_at timestamptz,
  offer_expires_at timestamptz,
  resolved_at timestamptz,
  unique (event_id, athlete_id)
);

create index if not exists event_waitlist_event_id_idx
  on public.event_waitlist (event_id, requested_at);
create index if not exists event_waitlist_offer_expiry_idx
  on public.event_waitlist (offer_expires_at)
  where status = 'offered';

comment on table public.event_waitlist is
  'Queue for a full race, ordered by requested_at. When a slot frees the head '
  'of the queue is offered it and has meet_settings.waitlist_claim_hours to '
  'claim before it passes on. Position is derived, never stored.';

-- ---------------------------------------------------------------------------
-- public.waitlist_position — where an athlete stands in a race's queue.
-- ---------------------------------------------------------------------------
create or replace function public.waitlist_position(p_event_id uuid, p_athlete_id uuid)
returns integer
language sql
stable
as $$
  select position from (
    select w.athlete_id,
           -- id is the tiebreak, and it is not decoration. Two athletes who
           -- join in the same statement (or the same millisecond) share a
           -- requested_at, and without a deterministic second key this
           -- ordering and the one in offer_waitlist_slots can disagree — the
           -- queue would tell one swimmer they are next while the slot was
           -- offered to the other. Both orderings must sort identically.
           row_number() over (order by w.requested_at, w.id)::integer as position
    from public.event_waitlist w
    where w.event_id = p_event_id
      and w.status in ('waiting', 'offered')
  ) ranked
  where ranked.athlete_id = p_athlete_id;
$$;

comment on function public.waitlist_position(uuid, uuid) is
  'An athlete''s place in a race queue, ordered by (requested_at, id). The '
  'tiebreak must match offer_waitlist_slots exactly or the displayed position '
  'and the offered slot can go to different people.';

-- ---------------------------------------------------------------------------
-- entry_payments — who paid how much, and for what.
-- ---------------------------------------------------------------------------
-- Price is DETERMINED at payment time and deliberately never snapshotted at
-- registration: an athlete pays whatever tier is in force when they actually
-- pay. But the moment cash is collected, what was collected has to be written
-- down. Nothing else in this schema stores a price, so without this table the
-- meet ends with no financial record at all — only a set of prices that can
-- still be recomputed differently tomorrow.
--
-- Structured for a payment provider that does not exist yet: method and
-- external_reference are the seam. Adding a gateway later means new rows here,
-- not a rework of entries, holds or the waitlist.
create table if not exists public.entry_payments (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  meet_volume_id uuid not null references public.meet_volumes (id) on delete cascade,
  -- The tier that produced this amount. Recorded rather than looked up later,
  -- because active_pricing_tier() answers "what is the tier NOW" and will give
  -- a different answer next week.
  tier public.pricing_tier not null,
  amount_egp integer not null check (amount_egp >= 0),
  method text not null default 'cash',
  -- Gateway transaction id, when there is a gateway. Null for cash.
  external_reference text,
  -- The admin who took the money. Null only if a future gateway collects it
  -- with no human involved, or if the row was written outside an
  -- authenticated session (psql/service role). Never client-supplied for a
  -- real request: public.enforce_collected_by() overrides it with auth.uid()
  -- on insert — see that function for why a default alone is not enough.
  collected_by uuid references public.users (id) on delete set null default public.current_collector(),
  collected_at timestamptz not null default now(),
  note text
);

create index if not exists entry_payments_athlete_idx
  on public.entry_payments (athlete_id, meet_volume_id);
create index if not exists entry_payments_volume_idx
  on public.entry_payments (meet_volume_id, collected_at);

comment on table public.entry_payments is
  'Financial record: what an athlete actually paid, at which tier, taken by '
  'which admin, when. Written when payment is collected — price is settled at '
  'payment time, so this is the only place the figure survives.';

-- The line items behind the amount. An athlete asking "why 850?" gets an
-- answer that came out of the database, not one recomputed by the UI from
-- today's prices — which by then may differ.
create table if not exists public.entry_payment_items (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.entry_payments (id) on delete cascade,
  -- Null for the package line, which covers several races at once rather than
  -- belonging to any one of them.
  entry_id uuid references public.entries (id) on delete set null,
  kind text not null check (kind in ('package', 'surcharge', 'additional_race', 'relay')),
  label text not null,
  amount_egp integer not null
);

create index if not exists entry_payment_items_payment_idx
  on public.entry_payment_items (payment_id);

-- ---------------------------------------------------------------------------
-- notifications — in-app first, email second.
-- ---------------------------------------------------------------------------
-- Every notification lands here and shows in the header bell. Email is a
-- second channel layered on top and can be muted for some categories; the
-- in-app record never can, so "I was never told" is always answerable.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  category public.notification_category not null,
  title text not null,
  body text not null,
  -- Where clicking it should go, e.g. /events/<vol>/register.
  link_url text,
  -- Ids relevant to the notice (event, team, entry). Kept loose on purpose:
  -- a typed column per referent would mean a migration for every new kind.
  metadata jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_only_idx
  on public.notifications (user_id)
  where read_at is null;

comment on table public.notifications is
  'In-app notification feed. Always written regardless of email preferences — '
  'preferences govern the email copy only.';

-- ---------------------------------------------------------------------------
-- notification_preferences — per user, per category, EMAIL only.
-- ---------------------------------------------------------------------------
-- entry_payment and waitlist cannot be switched off, and the CHECK below is
-- what enforces it rather than the UI. Those two carry clocks: a missed hold
-- expiry or a missed 24-hour claim window costs the athlete their slot, so an
-- opt-out is a trap rather than a preference. Team and results/schedule are
-- genuinely optional and can be muted individually.
create table if not exists public.notification_preferences (
  user_id uuid not null references public.users (id) on delete cascade,
  category public.notification_category not null,
  email_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, category),
  constraint notification_preferences_critical_always_on check (
    email_enabled or category not in ('entry_payment', 'waitlist')
  )
);

comment on table public.notification_preferences is
  'Per-user email opt-outs. entry_payment and waitlist are mandatory and the '
  'CHECK constraint refuses to store them as off — those notices carry '
  'deadlines that cost the athlete their slot if missed.';

-- ---------------------------------------------------------------------------
-- email_outbox — queued email, drained by the dispatch route handler.
-- ---------------------------------------------------------------------------
-- A queue rather than sending inline, for three reasons: the browser cannot
-- hold the provider key, a provider outage must not roll back the data change
-- that caused the notice, and digest email needs somewhere to accumulate.
--
-- Rows are written even when no provider is configured. They sit 'pending' and
-- drain the day a key is added, so the pipeline is complete before email works.
create table if not exists public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notifications (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  to_email text not null,
  subject text not null,
  body text not null,
  status public.email_delivery_status not null default 'pending',
  -- False = send now (waitlist offers, holds, payment: these carry clocks).
  -- True = hold for the daily digest (results, schedule).
  is_digest boolean not null default false,
  -- Earliest send time. Digest rows are stamped forward to the next digest run.
  scheduled_for timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists email_outbox_pending_idx
  on public.email_outbox (scheduled_for)
  where status = 'pending';

comment on table public.email_outbox is
  'Queued outbound email drained by /api/notifications/dispatch. Rows are '
  'written even with no provider configured — they queue and drain once a key '
  'exists, so the pipeline is testable before email is live.';

-- ---------------------------------------------------------------------------
-- public.raise_notification — the one way a notification is created.
-- ---------------------------------------------------------------------------
-- Writes the in-app row always, and queues an email only if the user has not
-- muted that category. Every trigger below goes through here, so the
-- preference check exists in exactly one place.
create or replace function public.raise_notification(
  p_user_id uuid,
  p_category public.notification_category,
  p_title text,
  p_body text,
  p_link_url text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_notification_id uuid;
  v_email text;
  v_email_enabled boolean;
  v_is_digest boolean;
begin
  if p_user_id is null then
    return null;
  end if;

  insert into public.notifications (user_id, category, title, body, link_url, metadata)
  values (p_user_id, p_category, p_title, p_body, p_link_url, coalesce(p_metadata, '{}'::jsonb))
  returning id into v_notification_id;

  -- Absent preference row means opted in. Making the default "on" matters:
  -- a user who has never visited the settings page still hears about a
  -- waitlist offer.
  select np.email_enabled into v_email_enabled
  from public.notification_preferences np
  where np.user_id = p_user_id and np.category = p_category;

  -- Belt and braces with the CHECK constraint: even if a preference row for a
  -- critical category somehow read false, the email still goes.
  if p_category in ('entry_payment', 'waitlist') then
    v_email_enabled := true;
  end if;

  if not coalesce(v_email_enabled, true) then
    return v_notification_id;
  end if;

  select u.email into v_email from public.users u where u.id = p_user_id;
  if v_email is null then
    return v_notification_id;
  end if;

  -- Anything with a deadline goes immediately; the rest batches.
  v_is_digest := p_category = 'results_schedule';

  insert into public.email_outbox (
    notification_id, user_id, to_email, subject, body, is_digest, scheduled_for
  ) values (
    v_notification_id, p_user_id, v_email, p_title, p_body, v_is_digest,
    case when v_is_digest then date_trunc('day', now()) + interval '1 day' + interval '18 hours'
         else now() end
  );

  return v_notification_id;
end;
$$;

comment on function public.raise_notification(uuid, public.notification_category, text, text, text, jsonb) is
  'Creates an in-app notification and queues its email unless the user muted '
  'that category. The single entry point — the preference check lives here and '
  'nowhere else. entry_payment and waitlist always send.';

-- ---------------------------------------------------------------------------
-- public.offer_waitlist_slots — hand freed slots to the head of the queue.
-- ---------------------------------------------------------------------------
-- Called after anything that could free capacity. Offers as many slots as are
-- actually free, in requested_at order, and gives each offeree a deadline.
create or replace function public.offer_waitlist_slots(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_free integer;
  v_claim_hours integer;
  v_event record;
  v_candidate record;
  v_offered integer := 0;
  v_user_id uuid;
begin
  select ec.free_count into v_free from public.event_capacity(p_event_id) ec;
  if coalesce(v_free, 0) <= 0 then
    return 0;
  end if;

  -- Slots already promised to someone must not be promised twice.
  v_free := v_free - (
    select count(*) from public.event_waitlist w
    where w.event_id = p_event_id and w.status = 'offered'
      and w.offer_expires_at > now()
  );
  if v_free <= 0 then
    return 0;
  end if;

  select e.name, s.meet_volume_id, ms.waitlist_claim_hours
    into v_event
  from public.events e
  join public.sessions s on s.id = e.session_id
  left join public.meet_settings ms on ms.meet_volume_id = s.meet_volume_id
  where e.id = p_event_id;

  v_claim_hours := coalesce(v_event.waitlist_claim_hours, 24);

  for v_candidate in
    select w.id, w.athlete_id
    from public.event_waitlist w
    where w.event_id = p_event_id and w.status = 'waiting'
    -- (requested_at, id) must match public.waitlist_position exactly.
    order by w.requested_at, w.id
    limit v_free
  loop
    update public.event_waitlist
    set status = 'offered',
        offered_at = now(),
        offer_expires_at = now() + make_interval(hours => v_claim_hours)
    where id = v_candidate.id;

    select a.user_id into v_user_id
    from public.athletes a where a.id = v_candidate.athlete_id;

    perform public.raise_notification(
      v_user_id,
      'waitlist',
      'A place opened in ' || v_event.name,
      'You are next on the waitlist for ' || v_event.name || '. Claim it within '
        || v_claim_hours || ' hours or it passes to the next swimmer.',
      '/events/' || v_event.meet_volume_id || '/register',
      jsonb_build_object('event_id', p_event_id, 'athlete_id', v_candidate.athlete_id)
    );

    v_offered := v_offered + 1;
  end loop;

  return v_offered;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.sweep_expired_holds — the scheduled job.
-- ---------------------------------------------------------------------------
-- Materialises what event_capacity() already computes, so the side effects can
-- happen: the athlete is told their slot went, and the freed place is offered
-- to the waitlist. Capacity itself does not depend on this running — see the
-- note on event_capacity() — which is why a missed run degrades notification
-- timeliness and nothing else.
--
-- Driven by pg_cron every 15 minutes (scheduled at the end of this file), and
-- reachable at /api/cron/process-expired-holds for a host-level scheduler.
--
-- Explicit DROP before CREATE OR REPLACE: this function's OUT parameters
-- changed shape (relay_holds_expired was added), and Postgres refuses to
-- CREATE OR REPLACE a function whose return row type differs from what is
-- already there — "cannot change return type of existing function". A truly
-- fresh database never hits this (nothing to conflict with), which is
-- exactly why it went unnoticed against the throwaway scratch clusters this
-- schema is normally verified against; it surfaces the moment schema.sql is
-- re-applied to a database that already had the three-column version.
drop function if exists public.sweep_expired_holds();

create or replace function public.sweep_expired_holds()
returns table (
  holds_expired integer,
  offers_made integer,
  offers_lapsed integer,
  relay_holds_expired integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expired integer := 0;
  v_lapsed integer := 0;
  v_offers integer := 0;
  v_relay_expired integer := 0;
  rec record;
begin
  -- 1. Lapsed holds. The entry survives in 'hold_expired' — deleting it would
  -- make an athlete's registration vanish with nothing to reclaim.
  for rec in
    select en.id, en.event_id, en.athlete_id, a.user_id, e.name as event_name,
           s.meet_volume_id
    from public.entries en
    join public.events e on e.id = en.event_id
    join public.sessions s on s.id = e.session_id
    join public.athletes a on a.id = en.athlete_id
    where en.status = 'pending_payment'
      and en.hold_expires_at is not null
      and en.hold_expires_at <= now()
  loop
    update public.entries set status = 'hold_expired' where id = rec.id;
    v_expired := v_expired + 1;

    perform public.raise_notification(
      rec.user_id,
      'entry_payment',
      'Your place in ' || rec.event_name || ' was released',
      'Payment was not recorded in time, so your slot in ' || rec.event_name
        || ' has been released. You can still pay to reclaim it if the race has room.',
      '/events/' || rec.meet_volume_id || '/register',
      jsonb_build_object('event_id', rec.event_id, 'entry_id', rec.id)
    );
  end loop;

  -- 1b. Lapsed relay squad holds. Notifies the CAPTAIN, not each of the four
  -- swimmers on the squad — the captain is who was billed and who is
  -- expected to act, and four separate notices for one squad would just be
  -- noise to the swimmers who have no payment action to take at all.
  for rec in
    select rs.id, rs.event_id, t.captain_id, e.name as event_name,
           s.meet_volume_id, t.name as team_name
    from public.relay_squads rs
    join public.teams t on t.id = rs.team_id
    join public.events e on e.id = rs.event_id
    join public.sessions s on s.id = e.session_id
    where rs.status = 'pending_payment'
      and rs.hold_expires_at is not null
      and rs.hold_expires_at <= now()
  loop
    update public.relay_squads set status = 'hold_expired' where id = rec.id;
    v_relay_expired := v_relay_expired + 1;

    -- A team with no captain (never happens in practice — a squad cannot be
    -- created without one, per captain_manages_relay_squads — but defensive
    -- rather than assumed) has nobody to notify; the hold still releases.
    if rec.captain_id is not null then
      perform public.raise_notification(
        rec.captain_id,
        'entry_payment',
        rec.team_name || '''s relay squad in ' || rec.event_name || ' was released',
        'Payment was not recorded in time, so this relay squad''s slot in '
          || rec.event_name || ' has been released. The legs are still assigned — '
          || 'reclaim the slot from the Captain Dashboard if there is still room, '
          || 'then pay at the desk.',
        '/captain',
        jsonb_build_object('event_id', rec.event_id, 'squad_id', rec.id)
      );
    end if;
  end loop;

  -- 2. Waitlist offers nobody claimed, so the queue can move on.
  for rec in
    select w.id, w.event_id, w.athlete_id, a.user_id, e.name as event_name
    from public.event_waitlist w
    join public.events e on e.id = w.event_id
    join public.athletes a on a.id = w.athlete_id
    where w.status = 'offered' and w.offer_expires_at <= now()
  loop
    update public.event_waitlist
    set status = 'expired', resolved_at = now()
    where id = rec.id;
    v_lapsed := v_lapsed + 1;

    perform public.raise_notification(
      rec.user_id,
      'waitlist',
      'Your waitlist offer for ' || rec.event_name || ' expired',
      'The claim window closed, so the place has passed to the next swimmer.',
      null,
      jsonb_build_object('event_id', rec.event_id)
    );
  end loop;

  -- 3. Offer everything now free. Runs last so it sees the slots freed above.
  for rec in
    select distinct w.event_id from public.event_waitlist w where w.status = 'waiting'
  loop
    v_offers := v_offers + public.offer_waitlist_slots(rec.event_id);
  end loop;

  return query select v_expired, v_offers, v_lapsed, v_relay_expired;
end;
$$;

comment on function public.sweep_expired_holds() is
  'Scheduled sweep: expires lapsed individual AND relay-squad holds, lapses '
  'unclaimed waitlist offers, and offers freed slots to the queue — with the '
  'notifications each of those implies. Capacity does not depend on it '
  'running; only timeliness does.';

-- ---------------------------------------------------------------------------
-- Team membership notifications.
-- ---------------------------------------------------------------------------
-- The captain hears about a request; the requester hears the outcome. Written
-- as a trigger rather than in the UI so a request created any other way — an
-- admin acting on someone's behalf, a script — still notifies.
-- Note the DELETE branch. public.membership_status has only 'pending' and
-- 'accepted' — a rejection DELETES the row (see lib/teams.ts), so a trigger
-- watching for a 'rejected' status would compile fine and silently never fire.
-- The requester would hear about acceptance and never about refusal.
create or replace function public.notify_team_membership_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record := case when tg_op = 'DELETE' then old else new end;
  v_team record;
  v_requester_name text;
begin
  select t.name, t.captain_id into v_team
  from public.teams t where t.id = v_row.team_id;

  -- The team is gone (cascade delete); there is nothing to say about it.
  if v_team.name is null then
    return v_row;
  end if;

  select u.full_name into v_requester_name
  from public.users u where u.id = v_row.user_id;

  if tg_op = 'INSERT' and v_row.status = 'pending' then
    -- A captain who somehow requests to join their own team does not need
    -- telling about it.
    if v_team.captain_id is not null and v_team.captain_id <> v_row.user_id then
      perform public.raise_notification(
        v_team.captain_id,
        'team',
        'New request to join ' || v_team.name,
        coalesce(v_requester_name, 'A swimmer') || ' has asked to join ' || v_team.name || '.',
        '/teams',
        jsonb_build_object('team_id', v_row.team_id, 'user_id', v_row.user_id)
      );
    end if;

  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    perform public.raise_notification(
      v_row.user_id, 'team',
      'You joined ' || v_team.name,
      'Your request to join ' || v_team.name || ' was accepted.',
      '/teams',
      jsonb_build_object('team_id', v_row.team_id)
    );

  elsif tg_op = 'DELETE' then
    if old.status = 'pending' then
      perform public.raise_notification(
        v_row.user_id, 'team',
        'Your request to join ' || v_team.name || ' was declined',
        'You can request to join another team.',
        '/teams',
        jsonb_build_object('team_id', v_row.team_id)
      );
    else
      perform public.raise_notification(
        v_row.user_id, 'team',
        'You are no longer on ' || v_team.name,
        'Your membership of ' || v_team.name || ' has ended.',
        '/teams',
        jsonb_build_object('team_id', v_row.team_id)
      );
    end if;
  end if;

  return v_row;
end;
$$;

create or replace trigger notify_team_membership_change_trigger
  after insert or update or delete on public.team_memberships
  for each row execute function public.notify_team_membership_change();

-- ---------------------------------------------------------------------------
-- team_announcements — captain-authored, team-wide messages.
-- ---------------------------------------------------------------------------
-- Distinct from public.notifications: a notification is addressed to one
-- person (see its own comment — "there is no operational reason to read
-- someone else's feed"). An announcement has no single addressee; it belongs
-- to the team. This table is the message itself, of which every member's own
-- public.notifications row (fired by the trigger below) is a per-recipient
-- pointer back to it.
create table if not exists public.team_announcements (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  author_id uuid references public.users (id) on delete set null,
  title text not null,
  body text not null,
  -- Pinned announcements sort first. A team's motivational message about
  -- Tuesday's practice and a genuinely important one ("meet moved to
  -- Saturday") are not equally worth surfacing forever — pinning is the
  -- captain's own editorial call, not automatic.
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists team_announcements_team_idx
  on public.team_announcements (team_id, pinned desc, created_at desc);

-- The updated_at trigger for this table is registered later, alongside the
-- others, below public.set_updated_at() itself — same reason as
-- meet_settings and every other table that does this. RLS is enabled and
-- policies are added in section 6 below, alongside teams/team_memberships —
-- this table's RLS depends on public.is_admin() and
-- public.is_team_captain_of(), neither of which exists yet at this point in
-- the file.

-- ---------------------------------------------------------------------------
-- public.notify_team_announcement — fans a posted announcement out to
-- every accepted member's own notification feed.
-- ---------------------------------------------------------------------------
-- Fires on INSERT only. An edit (fixing a typo) or a pin toggle re-notifying
-- the whole team would be exactly the noise a "read the room" captain tool
-- should avoid — the announcement itself is still there to read; nobody
-- needs telling twice. The author is excluded from their own fan-out: a
-- captain posting to their own team does not need to be told they did.
--
-- Fans out to athletes.team_id, not team_memberships — see the comment on
-- this table's read policy for why: team_memberships is a one-time
-- join-request record, not the live roster, and most seeded/assigned
-- athletes have no row in it at all.
create or replace function public.notify_team_announcement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_name text;
  v_member record;
begin
  select name into v_team_name from public.teams where id = new.team_id;

  for v_member in
    select a.user_id
    from public.athletes a
    where a.team_id = new.team_id
      and a.user_id is distinct from new.author_id
  loop
    perform public.raise_notification(
      v_member.user_id,
      'announcement',
      coalesce(v_team_name, 'Your team') || ': ' || new.title,
      new.body,
      '/teams',
      jsonb_build_object('team_id', new.team_id, 'announcement_id', new.id)
    );
  end loop;

  return new;
end;
$$;

create or replace trigger notify_team_announcement_trigger
  after insert on public.team_announcements
  for each row execute function public.notify_team_announcement();

-- ---------------------------------------------------------------------------
-- heats & heat_lanes — 6 lanes per heat.
-- ---------------------------------------------------------------------------
create table if not exists public.heats (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  heat_group public.heat_group not null,
  -- Male and female swim separately in every age group, so gender is part of
  -- a heat's identity alongside heat_group. Nullable only to keep already
  -- scored legacy heats (seeded before the split, possibly mixed) readable —
  -- every heat generated from here on has it set.
  gender public.gender,
  heat_number integer not null,
  heat_order integer not null default 0,
  status public.publish_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Heat numbers restart per age group and gender ("17 & Under Women Heat 1"),
  -- so uniqueness is per bucket, not per event. heat_order carries the global
  -- running order.
  unique (event_id, heat_group, gender, heat_number)
);

alter table public.heats add column if not exists gender public.gender;


create index if not exists heats_event_id_idx on public.heats (event_id);
create index if not exists heats_status_idx on public.heats (status);

create table if not exists public.heat_lanes (
  id uuid primary key default gen_random_uuid(),
  heat_id uuid not null references public.heats (id) on delete cascade,
  lane_number integer not null check (lane_number between 1 and 6),
  entry_id uuid references public.entries (id) on delete cascade,
  unique (heat_id, lane_number),
  unique (heat_id, entry_id)
);

-- Attendance teardown. Call-room check-in was a second, redundant record of
-- who turned up: a swimmer who does not swim is published as NS on the
-- result, which is the authoritative record and the one that actually feeds
-- scoring. Marking attendance separately meant the same fact could be
-- recorded twice and disagree — present in the call room, NS on the sheet —
-- with no rule for which won. `create table if not exists` cannot remove
-- columns, so an existing database needs this explicitly.
drop trigger if exists stamp_attendance_marked_trigger on public.heat_lanes;
drop function if exists public.stamp_attendance_marked() cascade;
drop index if exists public.heat_lanes_attendance_idx;
alter table public.heat_lanes
  drop column if exists attendance_status,
  drop column if exists attendance_marked_at,
  drop column if exists attendance_marked_by;
drop type if exists public.attendance_status;

-- Heat numbering migration. Heat numbers used to run globally across an
-- event; they now restart within each (age group, gender) bucket, so the old
-- constraint would reject the very first re-seed. Heats are pure derived data
-- (rebuilt whenever payment is confirmed), so unscored ones are simply
-- dropped and regenerated under the new numbering; scored heats are left
-- alone rather than cascading away real times.
alter table public.heats drop constraint if exists heats_event_id_heat_number_key;

-- Renumber heats that were seeded under the old global numbering. Without
-- this, an existing meet keeps "Heat 1..7" running across the whole event and
-- the new titles ("17 & Under Women Heat 2") would be wrong on exactly the
-- data the user is already looking at. heat_order preserves the running order
-- the heats were actually seeded in, so renumbering never reorders the meet.
update public.heats h
set heat_number = renumbered.new_number
from (
  select id,
         row_number() over (
           partition by event_id, heat_group, gender
           order by heat_order, heat_number, id
         ) as new_number
  from public.heats
) renumbered
where h.id = renumbered.id
  and h.heat_number is distinct from renumbered.new_number;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'heats_event_id_heat_group_gender_heat_number_key'
  ) then
    alter table public.heats
      add constraint heats_event_id_heat_group_gender_heat_number_key
      unique (event_id, heat_group, gender, heat_number);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Skins heats carry their own identity: which board, which round.
-- ---------------------------------------------------------------------------
-- A Skins board is (age category x gender) — six of them. But heat_group has
-- only two values and folds U17 in with Open, so the 17 & Under board and the
-- Open board of the same gender resolved to the SAME heat row, and whichever
-- was materialised second collided on heat_lanes (heat_id, lane_number).
-- That is the "duplicate key value violates unique constraint
-- heat_lanes_heat_id_lane_number_key" the Skins bracket reported; it was
-- never male-specific, it just needed both categories of a gender to be
-- populated. U14 escaped only because U13_14 is its own heat group.
--
-- Rounds collided the same way, and worse: all three rounds reused
-- heat_number 1, and results key on heat_lane_id, so publishing the Round of
-- 4 overwrote the Round of 6's results in place rather than recording a
-- second round. Per-round publishing is impossible until each round is its
-- own heat.
alter table public.heats
  add column if not exists skins_category public.age_group,
  add column if not exists skins_round integer,
  add column if not exists skins_swim_off boolean not null default false;

-- Partial, so ordinary heats are untouched. Adding these columns to the base
-- constraint instead would have been actively harmful: NULLs compare as
-- distinct, so every non-Skins heat would have silently lost its uniqueness.
create unique index if not exists heats_skins_board_round_key
  on public.heats (event_id, skins_category, gender, skins_round, skins_swim_off)
  where skins_round is not null;

-- (Legacy Skins heats are cleaned up further down, once results exists —
-- deciding which of them are safe to drop requires reading their results.)

create index if not exists heat_lanes_heat_id_idx on public.heat_lanes (heat_id);

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

-- Legacy Skins heats predate per-board/per-round identity and are
-- unsalvageable: one row stood for two boards and all three rounds at once.
-- Unscored ones are pure derived data, so drop them and let the bracket
-- rebuild cleanly. Scored ones are left alone — they hold real results, and
-- destroying those to tidy up the schema would be the worse trade.
delete from public.heats h
where h.skins_round is null
  and exists (select 1 from public.events e where e.id = h.event_id and e.is_skins)
  and not exists (
    select 1
    from public.heat_lanes hl
    join public.results r on r.heat_lane_id = hl.id
    where hl.heat_id = h.id and r.result_outcome is not null
  );

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
drop view if exists public.series_leaderboards;
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
drop view if exists public.all_time_best_performances;
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
  -- Ranked on time alone. r.created_at was previously a second ORDER BY key,
  -- which meant two identical times were split by whoever was entered first
  -- and never actually tied. dense_rank would also be wrong: it awards the
  -- next swimmer 2nd after a tie for 1st, where the rule is 3rd.
  rank() over (
    partition by e.stroke, e.distance_m, coalesce(en.age_group_at_entry, a.age_group), a.gender
    order by r.official_time_ms asc
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
drop view if exists public.all_time_best_performers;
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
  rank() over (
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
-- ADMIN AUDIT LOG — append-only record of privileged writes: role changes,
-- payment overrides/cash confirmations, and pricing changes. Exists so "who
-- changed X, to what, and when" has an answer that survives the UI that made
-- the change — the same reasoning entry_payments already exists for: a
-- financial or permission fact, once true, must be written down somewhere
-- that outlives whatever screen produced it.
-- =============================================================================
create table if not exists public.admin_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  actor_id uuid not null references public.users (id),
  action text not null,
  target_table text not null,
  target_id uuid,
  details jsonb not null default '{}'::jsonb
);

create index if not exists admin_actions_created_at_idx
  on public.admin_actions (created_at desc);
create index if not exists admin_actions_actor_idx
  on public.admin_actions (actor_id, created_at desc);
create index if not exists admin_actions_action_idx
  on public.admin_actions (action, created_at desc);

comment on table public.admin_actions is
  'Append-only audit trail of privileged writes: who (actor_id), what '
  '(action / target_table / target_id), and the before/after in details. '
  'Written exclusively by the trigger functions below — nothing in '
  'application code inserts here directly, so the log cannot go stale from '
  'a screen that forgets to call it. There is no UPDATE or DELETE policy on '
  'this table, on purpose: once written, a row cannot be changed or removed '
  'by anyone, including an admin, through PostgREST. Only a direct '
  'superuser connection (a migration) can touch an existing row, which is '
  'the correct amount of friction for an audit trail.';

alter table public.admin_actions enable row level security;

drop policy if exists "admins_read_admin_actions" on public.admin_actions;
create policy "admins_read_admin_actions" on public.admin_actions
  for select using (public.is_admin());

drop policy if exists "admins_insert_admin_actions" on public.admin_actions;
create policy "admins_insert_admin_actions" on public.admin_actions
  for insert with check (public.is_admin());

-- No update or delete policy, deliberately. RLS denies a command by default
-- when no policy grants it — there is nothing here that ever allows one, for
-- any role, including an admin. That is what makes the log append-only
-- rather than merely a convention nobody violates yet.

-- log_admin_action() writes one audit row. In practice called only from the
-- trigger functions below, so the audit trail is a property of the tables it
-- covers rather than something a screen has to remember to invoke — but it
-- is a plain callable function like any other in this schema (PostgREST
-- exposes it as an RPC), so it enforces its own admin check rather than
-- trusting that every caller will only ever be a trigger. SECURITY DEFINER
-- so it can read auth.uid() regardless of the caller's own grants (every
-- other function in this schema that touches auth.uid() follows the same
-- pattern), which also means RLS on admin_actions is bypassed for this
-- specific insert — the is_admin() check below is what stands in its place.
--
-- Silently does nothing when there is no authenticated actor (auth.uid() is
-- null) — the case for every direct-SQL write during schema.sql /
-- seed-*.sql application, run over a superuser psql connection with no JWT
-- at all. Seeding a demo admin's role or a volume's default pricing matrix
-- is bootstrapping, not a privileged action taken through the app, and
-- logging it would mean every re-application of schema.sql (which is meant
-- to be safely re-runnable) manufactures audit rows for events that never
-- happened in the app.
create or replace function public.log_admin_action(
  p_action text,
  p_target_table text,
  p_target_id uuid,
  p_details jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  if not public.is_admin() then
    raise exception 'Only an admin action may write to the audit log.';
  end if;
  insert into public.admin_actions (actor_id, action, target_table, target_id, details)
  values (auth.uid(), p_action, p_target_table, p_target_id, coalesce(p_details, '{}'::jsonb));
end;
$$;

-- ROLE_CHANGE — fires only when role actually changes value; a name/phone
-- edit on the same row does not need an audit row.
create or replace function public.audit_user_role_change()
returns trigger
language plpgsql
as $$
begin
  perform public.log_admin_action(
    'ROLE_CHANGE',
    'users',
    new.id,
    jsonb_build_object('previous_role', old.role, 'new_role', new.role)
  );
  return new;
end;
$$;

create or replace trigger audit_user_role_change_trigger
  after update on public.users
  for each row
  when (old.role is distinct from new.role)
  execute function public.audit_user_role_change();

-- PAYMENT_OVERRIDE — entry_payments and (wired below, once that table
-- exists) relay_squad_payments are the same category of event, an admin
-- recording money collected outside any payment gateway, but NEW/OLD in a
-- trigger function are a generic `record`, not a fixed row type: a single
-- shared function with a `case tg_table_name when ... then new.col` branch
-- per table still fails at runtime with "record has no field X" for
-- whichever table's branch is NOT the one that matched, because every branch
-- of the CASE is resolved against the actual record regardless of which one
-- executes. One small function per table avoids that, at the cost of two
-- near-identical functions instead of one.
create or replace function public.audit_entry_payment_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.log_admin_action(
    'PAYMENT_OVERRIDE',
    'entry_payments',
    new.id,
    jsonb_build_object(
      'athlete_id', new.athlete_id,
      'meet_volume_id', new.meet_volume_id,
      'tier', new.tier,
      'amount_egp', new.amount_egp,
      'method', new.method
    )
  );
  return new;
end;
$$;

create or replace trigger audit_entry_payment_insert_trigger
  after insert on public.entry_payments
  for each row execute function public.audit_entry_payment_insert();

-- ---------------------------------------------------------------------------
-- public.enforce_collected_by — the payment tables' "who collected" rule.
-- ---------------------------------------------------------------------------
-- Both payment tables record a collector that the CLIENT used to supply:
-- lib/admin-cash-payments.ts inserted it from the browser and
-- confirm_relay_squad_payment() took it as a parameter. The audit trail was
-- never at risk — log_admin_action() above already writes actor_id :=
-- auth.uid() into the append-only admin_actions — but collected_by is the
-- copy the cash desk and the payment-status screens DISPLAY, so the two could
-- disagree and the readable one was the forgeable one.
--
-- A column default cannot fix that on its own: a default only applies when
-- the column is omitted, and the problem is a caller supplying a wrong value
-- explicitly. Nor can an insert policy's WITH CHECK, because
-- confirm_relay_squad_payment() is SECURITY DEFINER and bypasses RLS
-- altogether. A BEFORE INSERT trigger is the one mechanism that covers both
-- write paths.
--
-- Overrides only when a session exists. psql/service-role writes (seeds, ops
-- scripts, backfills) have no auth.uid() and are already outside RLS, so
-- forcing NULL over an attribution the operator passed deliberately would
-- break legitimate seeding while buying no security at all.
create or replace function public.enforce_collected_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_collector();
begin
  if v_actor is not null then
    new.collected_by := v_actor;
  end if;
  return new;
end;
$$;

create or replace trigger enforce_entry_payment_collected_by
  before insert on public.entry_payments
  for each row execute function public.enforce_collected_by();

-- PRICING_UPDATE — pricing_packages and pricing_tiers each get their own
-- function for the same reason audit_entry_payment_insert() is not shared
-- with relay_squad_payments (see comment above); each is gated on the field
-- that actually defines "a price changed" for that table, so a Control Unit
-- save that resubmits identical numbers (or only bumps updated_at) does not
-- manufacture a no-op audit row.
create or replace function public.audit_pricing_package_change()
returns trigger
language plpgsql
as $$
begin
  perform public.log_admin_action(
    'PRICING_UPDATE',
    'pricing_packages',
    new.id,
    jsonb_build_object(
      'meet_volume_id', new.meet_volume_id,
      'race_count', new.race_count,
      'tier', new.tier,
      'previous_price_egp', old.price_egp,
      'new_price_egp', new.price_egp
    )
  );
  return new;
end;
$$;

create or replace trigger audit_pricing_package_change_trigger
  after update on public.pricing_packages
  for each row
  when (old.price_egp is distinct from new.price_egp)
  execute function public.audit_pricing_package_change();

create or replace function public.audit_pricing_tier_change()
returns trigger
language plpgsql
as $$
begin
  perform public.log_admin_action(
    'PRICING_UPDATE',
    'pricing_tiers',
    new.id,
    jsonb_build_object(
      'meet_volume_id', new.meet_volume_id,
      'tier', new.tier,
      'previous_starts_at', old.starts_at,
      'previous_ends_at', old.ends_at,
      'new_starts_at', new.starts_at,
      'new_ends_at', new.ends_at
    )
  );
  return new;
end;
$$;

create or replace trigger audit_pricing_tier_change_trigger
  after update on public.pricing_tiers
  for each row
  when (old.starts_at is distinct from new.starts_at or old.ends_at is distinct from new.ends_at)
  execute function public.audit_pricing_tier_change();

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
  v_team_id uuid;
  v_invite_token text;
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

    -- A captain's shareable invite link (public.create_team_invite_link),
    -- carried through signUp()'s metadata the same way parent_email is.
    -- Resolved and consumed HERE, inline, rather than via a separate
    -- redeem_team_invite_token() call from the client: there is no active
    -- session between signUp() returning and this trigger running (email
    -- confirmation is required — see this function's own comment further
    -- up in app code / lib/register.ts), so the client could never call
    -- that RPC itself at the right moment. A stale/mistyped token leaves
    -- v_team_id null and the athlete is simply created unattached, exactly
    -- like redeem_team_invite_token()'s own contract: never blocks sign-up.
    v_invite_token := nullif(trim(new.raw_user_meta_data ->> 'team_invite_token'), '');
    v_team_id := null;
    if v_invite_token is not null then
      update public.team_invite_links
      set use_count = use_count + 1
      where token = v_invite_token and revoked_at is null
      returning team_id into v_team_id;
    end if;

    insert into public.athletes (
      user_id, date_of_birth, age, age_group, gender, height_cm, weight_kg,
      specialty_events, parent_id, parent_link_status, pending_parent_email,
      approved_by_admin, safety_accepted_at, safety_accepted_by, team_id
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
      true,
      -- A U14 cannot accept for themselves no matter what the form sent;
      -- their guardian must do it from their own account afterwards.
      case
        when v_needs_parent then null
        when (new.raw_user_meta_data ->> 'safety_accepted') = 'true' then now()
        else null
      end,
      case
        when v_needs_parent then null
        when (new.raw_user_meta_data ->> 'safety_accepted') = 'true' then new.id
        else null
      end,
      v_team_id
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
  -- ELIGIBILITY to found and captain a team — deliberately NOT the same
  -- question as "does this person captain team X", which is
  -- is_team_captain_of() and is what relay management checks.
  --
  -- Conflating them breaks team creation outright: requiring that you already
  -- captain a team in order to create one means nobody can ever create the
  -- first. 'coach' is gone from the list because the role is retired; an
  -- Open-age athlete founding a team remains the route in.
  select exists (
    select 1 from public.users u
    where u.id = auth.uid()
      and (
        u.role = 'admin'
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
  -- These two checks are specific to an ATHLETE-INITIATED request
  -- ('pending') — a captain inviting someone ('invited', below) is a
  -- different direction with its own rule, not a relaxation of this one.
  if new.status = 'pending' and exists (
    select 1 from public.team_memberships
    where user_id = new.user_id and status = 'pending'
  ) then
    raise exception
      'You already have a pending team join request. Cancel it before requesting to join another team.';
  end if;

  select team_id into v_current_team_id from public.athletes where user_id = new.user_id;

  if new.status = 'pending' and v_current_team_id is not null and public.meet_in_progress() then
    raise exception 'Team transfers are locked until the current meet volume concludes.';
  end if;

  -- A captain may only invite an UNATTACHED athlete. Enforced here, not only
  -- in the app's search query, because RLS's WITH CHECK can't cleanly join
  -- against athletes' current state — this is the same defense-in-depth
  -- pattern the transfer lock above already uses.
  if new.status = 'invited' and v_current_team_id is not null then
    raise exception 'This athlete is already on a team and cannot be invited to another.';
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

-- ---------------------------------------------------------------------------
-- CONTACT PRIVACY
-- ---------------------------------------------------------------------------
-- Phone and email are only shared where there is a real relationship:
--   * yourself, and admins (operational necessity);
--   * members of the SAME team see each other;
--   * while a join request is pending, the requester and that team's
--     captain see each other — and nobody else on that team.
--
-- This is enforced in a SECURITY DEFINER function rather than the UI because
-- RLS is row-level: public.users rows must stay broadly readable for names
-- and avatars, so filtering the contact COLUMNS client-side would still ship
-- every phone number to every browser. Callers get contact details only
-- through this function.
create or replace function public.visible_contacts(p_user_ids uuid[])
returns table (user_id uuid, email text, phone text)
language sql
security definer
stable
set search_path = public
as $$
  select u.id, u.email, u.phone
  from public.users u
  where u.id = any(p_user_ids)
    and (
      -- yourself
      u.id = auth.uid()
      -- admins run the meet desk and need to reach anyone
      or public.is_admin()
      -- same team (covers athlete<->athlete and athlete<->coach alike,
      -- since a team's captain is a member of that team's roster view)
      or exists (
        select 1
        from public.athletes me
        join public.athletes them on them.team_id = me.team_id
        where me.user_id = auth.uid()
          and them.user_id = u.id
          and me.team_id is not null
      )
      -- you captain a team this person has a pending request to
      or exists (
        select 1
        from public.team_memberships tm
        join public.teams t on t.id = tm.team_id
        where tm.user_id = u.id
          and tm.status = 'pending'
          and t.captain_id = auth.uid()
      )
      -- ...and the mirror: this person captains a team YOU have a pending
      -- request to
      or exists (
        select 1
        from public.team_memberships tm
        join public.teams t on t.id = tm.team_id
        where tm.user_id = auth.uid()
          and tm.status = 'pending'
          and t.captain_id = u.id
      )
    );
$$;

comment on function public.visible_contacts(uuid[]) is
  'Returns email/phone ONLY for users the caller may contact: self, admins, '
  'same-team members, and pending join-request counterparties (requester <-> '
  'that team''s captain). Everyone else is omitted from the result.';

-- ---------------------------------------------------------------------------
-- Accepting the safety & privacy acknowledgement.
-- ---------------------------------------------------------------------------
-- Enforced in the database, not the form: the whole point of the U14 rule is
-- that the swimmer cannot give this consent themselves, and a client-side
-- check would be trivially bypassable on exactly the population it exists to
-- protect.
create or replace function public.accept_safety_acknowledgement(p_athlete_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_age_group public.age_group;
  v_user_id uuid;
  v_parent_id uuid;
begin
  select a.age_group, a.user_id, a.parent_id
    into v_age_group, v_user_id, v_parent_id
  from public.athletes a
  where a.id = p_athlete_id;

  if v_user_id is null then
    raise exception 'No such swimmer.';
  end if;

  if v_age_group = 'U14' then
    -- A minor's acknowledgement must come from the linked guardian.
    if v_parent_id is null then
      raise exception 'This swimmer is under 15 and has no linked parent yet. A parent must be linked before the safety acknowledgement can be accepted.';
    end if;
    if auth.uid() <> v_parent_id then
      raise exception 'Only the linked parent may accept the safety acknowledgement for a swimmer under 15.';
    end if;
  else
    if auth.uid() <> v_user_id then
      raise exception 'You can only accept the safety acknowledgement for your own account.';
    end if;
  end if;

  update public.athletes
     set safety_accepted_at = now(),
         safety_accepted_by = auth.uid()
   where id = p_athlete_id;
end;
$$;

comment on function public.accept_safety_acknowledgement(uuid) is
  'Records the safety & privacy acknowledgement. A U14 swimmer cannot accept '
  'for themselves — only their linked parent may, from that parent''s own '
  'account. Everyone 15+ accepts for themselves.';

/** Outstanding acknowledgements a signed-in PARENT must action. */
create or replace function public.my_pending_safety_acceptances()
returns table (athlete_id uuid, full_name text, age_group public.age_group)
language sql
security definer
stable
set search_path = public
as $$
  select a.id, u.full_name, a.age_group
  from public.athletes a
  join public.users u on u.id = a.user_id
  where a.parent_id = auth.uid()
    and a.age_group = 'U14'
    and a.safety_accepted_at is null;
$$;


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

create or replace trigger meet_settings_set_updated_at
  before update on public.meet_settings
  for each row execute function public.set_updated_at();

create or replace trigger pricing_packages_set_updated_at
  before update on public.pricing_packages
  for each row execute function public.set_updated_at();

create or replace trigger race_shape_templates_set_updated_at
  before update on public.race_shape_templates
  for each row execute function public.set_updated_at();

create or replace trigger notification_preferences_set_updated_at
  before update on public.notification_preferences
  for each row execute function public.set_updated_at();

create or replace trigger team_announcements_set_updated_at
  before update on public.team_announcements
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
  -- admin_or_referee, not admin: the point of this guard is that an ATHLETE
  -- cannot self-register for Skins, and the referee running the bracket on
  -- the deck is not self-registration. materialise_skins_heat is the only
  -- route in, and it applies the same admin-or-referee check itself.
  -- SECURITY DEFINER does not change auth.uid(), so a referee opening a
  -- board hits this trigger as themselves.
  if exists (
    select 1 from public.events e
    where e.id = new.event_id and e.is_skins = true
  ) and not public.is_admin_or_referee() then
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
-- Approval NO LONGER gates registration.
--
-- The flow is now: an athlete signs up, registers for their events, and the
-- admin approves the swimmer and confirms their cash in one action at the
-- meet desk. Blocking the INSERT meant an unapproved swimmer could never
-- reach that desk with entries to approve — the gate ran before the thing it
-- was gating existed. What still holds is that entries land as
-- 'pending_payment' (enforce_entry_status_change below) and only an admin can
-- confirm them, so nobody swims unapproved; they just aren't blocked from
-- ASKING.
--
-- Parent authorization for U14s is a separate, legal gate and is unaffected.
drop trigger if exists enforce_athlete_approved_for_entry_trigger on public.entries;
drop function if exists public.enforce_athlete_approved_for_entry();

-- public.enforce_athlete_approval_change() intentionally no longer exists.
-- It guarded approved_by_admin, which no longer gates anything now that
-- paying the entry fee is the only requirement. Worse, it actively broke two
-- things: its INSERT branch forced every self-service signup back to
-- approved_by_admin = false (silently undoing account auto-approval, since
-- SECURITY DEFINER does not change auth.uid()), and its UPDATE branch raised
-- whenever auth.uid() was NULL — which is exactly the case in the Supabase
-- SQL editor, so re-running this file against an existing database failed.
-- It is dropped near the top of this script.

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
  -- A Skins entry is not a paid registration. Qualification is assigned from
  -- published results, there is no fee, and there is therefore no payment for
  -- an admin to confirm — the entry row exists only because results hang off
  -- heat_lanes -> entries. Referees run the bracket on the deck, and
  -- SECURITY DEFINER does not change auth.uid(), so without this exemption
  -- materialise_skins_heat fails for exactly the people meant to use it.
  -- This opens nothing: enforce_no_direct_skins_entry still restricts who may
  -- create a Skins entry at all, and the exemption is scoped to Skins events.
  if exists (select 1 from public.events e where e.id = new.event_id and e.is_skins) then
    return new;
  end if;

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
-- The return signature gained `gender`, and Postgres will not replace a
-- function whose OUT columns changed — an existing database needs the drop.
drop function if exists public.get_skins_qualifiers(uuid);
create or replace function public.get_skins_qualifiers(event_id_param uuid)
returns table (
  athlete_id uuid,
  athlete_name text,
  team_name text,
  category public.age_group,
  gender public.gender,
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
      a.gender,
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
    group by a.id, u.full_name, t.name, a.age_group, a.gender
  ),
  ranked as (
    select
      best_times.*,
      rank() over (
        partition by best_times.category, best_times.gender
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
            and wr2.gender = wr.gender
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
    active.gender,
    active.source_rank,
    active.best_time_ms,
    active.response,
    active.is_active_qualifier,
    active.is_confirmed,
    case
      when active.is_active_qualifier then (
        select count(*)::integer from active a2
        where a2.category = active.category
          and a2.gender = active.gender
          and a2.is_active_qualifier
          and a2.source_rank <= active.source_rank
      )
      else null
    end as slot_number
  from active
  order by active.category, active.gender, active.source_rank;
end;
$$;

comment on function public.get_skins_qualifiers(uuid) is
  'Returns ranked Skins candidates per age group AND gender (men and women '
  'never race each other) with accept/decline '
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
alter table public.meet_settings enable row level security;
alter table public.pricing_tiers enable row level security;
alter table public.pricing_packages enable row level security;
alter table public.race_shape_templates enable row level security;
alter table public.event_waitlist enable row level security;
alter table public.entry_payments enable row level security;
alter table public.entry_payment_items enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.email_outbox enable row level security;
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

-- Restricted to status = 'pending' — an athlete requesting to join. The
-- opposite direction (a captain inviting someone) is the policy below;
-- keeping them as two separate, narrowly-scoped policies means neither can
-- accidentally be used to perform the other's action.
drop policy if exists "user_request_membership" on public.team_memberships;
create policy "user_request_membership" on public.team_memberships
  for insert with check (user_id = auth.uid() and status = 'pending');

drop policy if exists "captain_invite_to_membership" on public.team_memberships;
create policy "captain_invite_to_membership" on public.team_memberships
  for insert with check (
    status = 'invited' and user_id <> auth.uid() and public.is_team_captain_of(team_id)
  );

-- Scoped to status = 'pending' rows only: this is the captain
-- accepting/rejecting an ATHLETE-INITIATED request. It must not also reach
-- 'invited' rows — a captain updating their own invite to 'accepted' would
-- silently bypass the invitee's actual consent, which is the entire point
-- of the invited/accepted split. See invitee_accept_own_invitation below
-- for the other direction.
drop policy if exists "captain_manage_membership_status" on public.team_memberships;
create policy "captain_manage_membership_status" on public.team_memberships
  for update using (public.is_team_captain_of(team_id) and status = 'pending')
  with check (public.is_team_captain_of(team_id));

-- The invitee accepting a captain-sent invite — the mirror of the policy
-- above. Restricted to the 'invited' -> 'accepted' transition only; a
-- decline is a DELETE (captain_or_requester_delete_membership below already
-- allows user_id = auth.uid() to delete their own row regardless of
-- status), matching the existing convention that a rejected/declined
-- membership row is removed outright rather than kept as a rejected state.
drop policy if exists "invitee_accept_own_invitation" on public.team_memberships;
create policy "invitee_accept_own_invitation" on public.team_memberships
  for update using (user_id = auth.uid() and status = 'invited')
  with check (user_id = auth.uid() and status = 'accepted');

-- "Reject" (captain) and "cancel" (the requester) both just delete the
-- pending row — team_memberships only persists real states (pending,
-- accepted), same convention as public.rejectTeam() for team approvals.
drop policy if exists "captain_or_requester_delete_membership" on public.team_memberships;
create policy "captain_or_requester_delete_membership" on public.team_memberships
  for delete using (user_id = auth.uid() or public.is_team_captain_of(team_id));

-- ---------------------------------------------------------------------------
-- team_invite_links
-- ---------------------------------------------------------------------------
-- No select policy at all for anonymous/unauthenticated callers — a token's
-- validity is only ever checked through redeem_team_invite_token() below,
-- a SECURITY DEFINER function, never a direct table read. Signed-in callers
-- who are not this team's captain/admin have no reason to browse this
-- table either.
alter table public.team_invite_links enable row level security;

drop policy if exists "admins_full_access_invite_links" on public.team_invite_links;
create policy "admins_full_access_invite_links" on public.team_invite_links
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "captain_view_own_invite_links" on public.team_invite_links;
create policy "captain_view_own_invite_links" on public.team_invite_links
  for select using (public.is_team_captain_of(team_id));

drop policy if exists "captain_create_own_invite_link" on public.team_invite_links;
create policy "captain_create_own_invite_link" on public.team_invite_links
  for insert with check (public.is_team_captain_of(team_id) and created_by = auth.uid());

-- Revoking sets revoked_at — the only column a captain may ever change here;
-- use_count is only ever touched by redeem_team_invite_token(), which runs
-- as the table owner and bypasses this policy entirely.
drop policy if exists "captain_revoke_own_invite_link" on public.team_invite_links;
create policy "captain_revoke_own_invite_link" on public.team_invite_links
  for update using (public.is_team_captain_of(team_id))
  with check (public.is_team_captain_of(team_id));

-- Generates (or replaces) the ONE active invite link for a team. Revokes
-- whatever link the team already had rather than accumulating an unbounded
-- pile of dead tokens — "regenerate" reads as one link, not many.
create or replace function public.create_team_invite_link(p_team_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token text;
begin
  if not public.is_team_captain_of(p_team_id) then
    raise exception 'Only this team''s captain may create an invite link.';
  end if;

  update public.team_invite_links
  set revoked_at = now()
  where team_id = p_team_id and revoked_at is null;

  -- Two concatenated gen_random_uuid()s, dashes stripped — 64 hex chars from
  -- Postgres core's own CSPRNG-backed UUID generator, not pgcrypto's
  -- gen_random_bytes(). pgcrypto lives in the `extensions` schema on this
  -- project, not `public`, so a security definer function pinned to
  -- `search_path = public` cannot call it unqualified — confirmed by
  -- actually running this against the local test database, not just reading
  -- the extension list.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.team_invite_links (team_id, token, created_by)
  values (p_team_id, v_token, auth.uid());

  return v_token;
end;
$$;

-- Validates and redeems a token in one step, called from the registration
-- flow right before the new athlete row is inserted. Returns the team_id to
-- join, or null for a missing/revoked token — the caller treats null as
-- "proceed with no team," never as an error, since a stale or mistyped link
-- must not block someone from creating an account at all.
create or replace function public.redeem_team_invite_token(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_id uuid;
begin
  update public.team_invite_links
  set use_count = use_count + 1
  where token = p_token and revoked_at is null
  returning team_id into v_team_id;

  return v_team_id;
end;
$$;

-- Read-only preview of what a token leads to, for the registration page to
-- show "You're joining <team name>" before the visitor submits — does NOT
-- increment use_count (that only happens once, at actual redemption above).
-- Team name only: nothing else about the team is anyone's business before
-- they've even signed up.
create or replace function public.preview_team_invite_token(p_token text)
returns text
language sql
security definer
stable
set search_path = public
as $$
  select t.name
  from public.team_invite_links l
  join public.teams t on t.id = l.team_id
  where l.token = p_token and l.revoked_at is null;
$$;

-- ---------------------------------------------------------------------------
-- team_announcements
-- ---------------------------------------------------------------------------
alter table public.team_announcements enable row level security;

-- Read: any current member of the team, the team's captain, or an admin —
-- an announcement is for the team, not the public (unlike, say, a heat
-- sheet). Write: captain-of-team or admin only, matching every other
-- captain-only write in this schema (relay squads, relay legs).
--
-- "Current member" is athletes.team_id, NOT team_memberships.status =
-- 'accepted'. team_memberships is the join-REQUEST workflow only — accepting
-- one is a one-time event that syncs athletes.team_id
-- (sync_athlete_team_on_membership_accept()) and the membership row then
-- becomes history, not a live record. An athlete seeded or assigned to a team
-- directly (never having gone through a join request at all — true for most
-- of the seeded roster) has NO team_memberships row to match at all. Checking
-- that table here would have silently hidden every announcement from anyone
-- who did not personally request to join.
drop policy if exists "team_view_announcements" on public.team_announcements;
create policy "team_view_announcements" on public.team_announcements
  for select using (
    public.is_admin()
    or public.is_team_captain_of(team_id)
    or exists (
      select 1 from public.athletes a
      where a.team_id = team_announcements.team_id
        and a.user_id = auth.uid()
    )
  );

drop policy if exists "captain_manages_announcements" on public.team_announcements;
create policy "captain_manages_announcements" on public.team_announcements
  for all
  using (public.is_admin() or public.is_team_captain_of(team_id))
  with check (public.is_admin() or public.is_team_captain_of(team_id));

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

-- Was `using (true)` — fully public over the REST API regardless of anything
-- app code checked. A Next.js route gate does nothing against a direct
-- `GET /rest/v1/meet_volumes` call: that request never touches the route at
-- all. This is the actual enforcement of the is_public visibility rule; the
-- gates in app/events/[volId]/layout.tsx and the /meets, /leaderboards
-- listings are UX on top of it, not the boundary itself.
drop policy if exists "public_view_meet_volumes" on public.meet_volumes;
create policy "public_view_meet_volumes" on public.meet_volumes
  for select using (public.is_admin() or (is_public and status <> 'planned'));

-- ---------------------------------------------------------------------------
-- public.volume_is_public — the ONE place "is this volume visible" is
-- defined, for every child table below to call.
-- ---------------------------------------------------------------------------
-- Deliberately excludes the admin bypass — each policy below adds
-- `public.is_admin() or public.volume_is_public(...)` explicitly, so the
-- admin exception stays visible at every call site rather than hidden inside
-- a shared helper. What IS shared, and must only ever be written once, is the
-- definition of "public" itself: is_public = true AND status <> 'planned'.
-- A volume that no longer exists (bad id) reads as not public, not as an
-- error — coalesce rather than a bare boolean subquery, which would produce
-- NULL (falsy in a USING clause, but worth being explicit about).
create or replace function public.volume_is_public(p_meet_volume_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select mv.is_public and mv.status <> 'planned'
       from public.meet_volumes mv
      where mv.id = p_meet_volume_id),
    false
  );
$$;

comment on function public.volume_is_public(uuid) is
  'Whether a volume is publicly visible: is_public AND status <> ''planned''. '
  'The single definition of that rule — every "public read" policy on a '
  'volume-scoped table calls this rather than repeating the predicate.';

-- meet_settings is PUBLIC READ on purpose: the individual race price is
-- quoted to a swimmer on the registration form before they have any special
-- standing, so an anonymous visitor must be able to read it. Writes are
-- admin-only — the Control Unit is an admin screen, and a swimmer who could
-- edit this row could set their own entry fee to zero.
-- Was `using (true)`. A hidden volume's prices must not be readable just
-- because its id is known — the whole point of is_public is defeated if the
-- pricing matrix stays open while the volume row is closed.
drop policy if exists "public_view_meet_settings" on public.meet_settings;
create policy "public_view_meet_settings" on public.meet_settings
  for select using (public.is_admin() or public.volume_is_public(meet_volume_id));

drop policy if exists "admins_manage_meet_settings" on public.meet_settings;
create policy "admins_manage_meet_settings" on public.meet_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- The pricing matrix, the tier calendar and the race-shape template are all
-- public read for the same reason meet_settings is: a swimmer has to be
-- quoted a price, and told which tier that price belongs to and when it ends,
-- before they have any standing at all. Writes are admin-only throughout — a
-- swimmer who could write any of these could set their own entry fee.
-- Was `using (true)`. Same reasoning as meet_settings above: a hidden
-- volume's tier calendar is part of what "hidden" has to mean.
drop policy if exists "public_view_pricing_tiers" on public.pricing_tiers;
create policy "public_view_pricing_tiers" on public.pricing_tiers
  for select using (public.is_admin() or public.volume_is_public(meet_volume_id));

drop policy if exists "admins_manage_pricing_tiers" on public.pricing_tiers;
create policy "admins_manage_pricing_tiers" on public.pricing_tiers
  for all using (public.is_admin()) with check (public.is_admin());

-- Was `using (true)`. Same reasoning: the package matrix is pricing detail
-- exactly like meet_settings and pricing_tiers, hidden along with the volume.
drop policy if exists "public_view_pricing_packages" on public.pricing_packages;
create policy "public_view_pricing_packages" on public.pricing_packages
  for select using (public.is_admin() or public.volume_is_public(meet_volume_id));

drop policy if exists "admins_manage_pricing_packages" on public.pricing_packages;
create policy "admins_manage_pricing_packages" on public.pricing_packages
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "public_view_race_shape_templates" on public.race_shape_templates;
create policy "public_view_race_shape_templates" on public.race_shape_templates
  for select using (true);

drop policy if exists "admins_manage_race_shape_templates" on public.race_shape_templates;
create policy "admins_manage_race_shape_templates" on public.race_shape_templates
  for all using (public.is_admin()) with check (public.is_admin());

-- Waitlist rows are public read: position in a queue is not a secret, and the
-- registration page needs the count to say "you would be #4". Joining and
-- leaving are restricted to the swimmer themselves (or their parent, or an
-- admin) — otherwise anyone could queue-jump by inserting rows for others, or
-- withdraw a rival.
drop policy if exists "public_view_event_waitlist" on public.event_waitlist;
create policy "public_view_event_waitlist" on public.event_waitlist
  for select using (true);

drop policy if exists "athlete_manage_own_waitlist" on public.event_waitlist;
create policy "athlete_manage_own_waitlist" on public.event_waitlist
  for all
  using (
    public.is_admin()
    or exists (
      select 1 from public.athletes a
      where a.id = event_waitlist.athlete_id
        and (a.user_id = auth.uid() or a.parent_id = auth.uid())
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.athletes a
      where a.id = event_waitlist.athlete_id
        and (a.user_id = auth.uid() or a.parent_id = auth.uid())
    )
  );

-- Payments are NOT public. A swimmer (or their parent) may read their own
-- receipts; only an admin may write one. Letting an athlete insert here would
-- let them mark themselves paid.
drop policy if exists "own_or_admin_view_entry_payments" on public.entry_payments;
create policy "own_or_admin_view_entry_payments" on public.entry_payments
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.athletes a
      where a.id = entry_payments.athlete_id
        and (a.user_id = auth.uid() or a.parent_id = auth.uid())
    )
  );

drop policy if exists "admins_manage_entry_payments" on public.entry_payments;
create policy "admins_manage_entry_payments" on public.entry_payments
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists "own_or_admin_view_entry_payment_items" on public.entry_payment_items;
create policy "own_or_admin_view_entry_payment_items" on public.entry_payment_items
  for select using (
    public.is_admin()
    or exists (
      select 1
      from public.entry_payments p
      join public.athletes a on a.id = p.athlete_id
      where p.id = entry_payment_items.payment_id
        and (a.user_id = auth.uid() or a.parent_id = auth.uid())
    )
  );

drop policy if exists "admins_manage_entry_payment_items" on public.entry_payment_items;
create policy "admins_manage_entry_payment_items" on public.entry_payment_items
  for all using (public.is_admin()) with check (public.is_admin());

-- A notification is addressed to one person and nobody else, including
-- admins: there is no operational reason to read someone's feed, and plenty
-- of reason not to. The only thing a recipient may write is read_at, so the
-- update policy is scoped to their own rows and insert is left to
-- raise_notification(), which is SECURITY DEFINER.
drop policy if exists "own_view_notifications" on public.notifications;
create policy "own_view_notifications" on public.notifications
  for select using (user_id = auth.uid());

drop policy if exists "own_update_notifications" on public.notifications;
create policy "own_update_notifications" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own_delete_notifications" on public.notifications;
create policy "own_delete_notifications" on public.notifications
  for delete using (user_id = auth.uid());

drop policy if exists "own_manage_notification_preferences" on public.notification_preferences;
create policy "own_manage_notification_preferences" on public.notification_preferences
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- email_outbox has NO policy granting anyone access. It holds queued message
-- bodies and recipient addresses, and is read solely by the dispatch route
-- handler using the service key, which bypasses RLS. An empty policy set with
-- RLS enabled means anon and authenticated see nothing — which is the intent,
-- not an oversight.

drop policy if exists "admins_full_access_sessions" on public.sessions;
create policy "admins_full_access_sessions" on public.sessions
  for all using (public.is_admin()) with check (public.is_admin());

-- Was `using (true)`. A hidden volume's session windows and dates are exactly
-- the "details" nobody has agreed to yet — they must not be readable just
-- because someone knows or guesses the volume's id.
--
-- NOTE ON BLAST RADIUS: this also gates the referee scoring deck and any
-- other internal tool that reads sessions/events directly, not only the
-- three public routes named in the original ask. For today's data that
-- changes nothing (Vol 1 stays public via the backfill above; Vol 2 has no
-- sessions to read). It does mean is_public = false can no longer be used
-- later as a way to "pause" an already-running, already-public meet without
-- also cutting off referees mid-meet — documented in TECH_STACK_DECISIONS.md.
drop policy if exists "public_view_sessions" on public.sessions;
create policy "public_view_sessions" on public.sessions
  for select using (public.is_admin() or public.volume_is_public(meet_volume_id));

drop policy if exists "admins_full_access_events" on public.events;
create policy "admins_full_access_events" on public.events
  for all using (public.is_admin()) with check (public.is_admin());

-- Was `using (true)`. events has no meet_volume_id of its own — it reaches
-- one through session_id — so this cannot call volume_is_public() directly
-- the way the other child tables do; it joins to sessions first.
drop policy if exists "public_view_events" on public.events;
create policy "public_view_events" on public.events
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.sessions s
      where s.id = events.session_id
        and public.volume_is_public(s.meet_volume_id)
    )
  );

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

-- The single consolidated Referee role owns heat_lanes end to end.
drop policy if exists "admins_referees_full_access_heat_lanes" on public.heat_lanes;
create policy "admins_referees_full_access_heat_lanes" on public.heat_lanes
  for all using (public.is_admin_or_referee()) with check (public.is_admin_or_referee());

drop policy if exists "public_view_published_heat_lanes" on public.heat_lanes;
create policy "public_view_published_heat_lanes" on public.heat_lanes
  for select using (
    exists (select 1 from public.heats h where h.id = heat_id and h.status = 'published')
  );

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

  -- A PUBLISHED result is locked to admins. Guarding only the transition into
  -- 'published' left the far bigger hole wide open: referees hold
  -- `for all using (is_referee())` on results, so once a row was published a
  -- referee could still rewrite its time, or set status back to 'draft' and
  -- quietly unpublish it. The UI hid the button; nothing enforced it.
  --
  -- Derived columns are deliberately excluded. recompute_heat_finish_places
  -- re-ranks every valid lane of a heat whenever any lane changes — including
  -- lanes that are already published — so blocking finish_place/
  -- placement_points here would stop a referee drafting a new lane in a heat
  -- that has any published result at all. Those columns are computed by the
  -- system from official_time_ms, which is itself locked below, so they are
  -- not a route to changing a published result.
  if tg_op = 'UPDATE' and old.status = 'published' and not public.is_admin() then
    if new.official_time_ms is distinct from old.official_time_ms
       or new.result_outcome is distinct from old.result_outcome
       or new.dq_code is distinct from old.dq_code
       or new.status is distinct from old.status
       -- Skins is placed by eye: finish_place IS the result there, and
       -- recompute_heat_finish_places skips Skins heats, so no cascade can
       -- legitimately touch it.
       or (new.finish_place is distinct from old.finish_place
           and exists (
             select 1
             from public.heat_lanes hl
             join public.heats h on h.id = hl.heat_id
             where hl.id = new.heat_lane_id and h.skins_round is not null
           ))
    then
      raise exception 'Only an admin may change a published result.';
    end if;
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
  v_is_skins_round boolean;
  v_max_points numeric := 6;
begin
  select heat_id into v_heat_id from public.heat_lanes where id = new.heat_lane_id;
  if v_heat_id is null then
    return new;
  end if;

  -- Skins is placed by eye, not timed: the referee records who touched
  -- first, second, third, and there is no official_time_ms at all. Ranking
  -- this heat by time would therefore order it by a column that is null for
  -- every swimmer — rank() over (order by null) is 1 for everyone — and
  -- overwrite the referee's finish order with a six-way tie for first.
  -- The entered places ARE the result here, so leave them alone.
  select (h.skins_round is not null) into v_is_skins_round
  from public.heats h where h.id = v_heat_id;
  if coalesce(v_is_skins_round, false) then
    return new;
  end if;

  -- rank(), never row_number(): swimmers on the same time to the hundredth
  -- share a place and the next swimmer skips the places they consumed
  -- (1,1,3). row_number() would hand one of them 2nd on scan order alone.
  -- Times are stored as exact multiples of 10ms (parsed from ss.cc), so
  -- equality here is exactly equality to the hundredth.
  with ranked as (
    select r.id, rank() over (order by r.official_time_ms asc) as computed_place
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

-- ===========================================================================
-- HEAT GENERATION — heats are produced when an admin approves entries.
-- ===========================================================================
-- Seeding rules (identical to lib/seeding.ts, kept in SQL so approval can
-- generate heats without a round trip through the app):
--   * U14 seeds separately from the combined U17/Open field, and always
--     swims first.
--   * Buckets larger than 6 chunk into multiple heats, fastest chunk LAST.
--   * NT swimmers seed ahead of timed swimmers within a bucket (oldest first),
--     matching how an unseeded entry is treated on deck.
--   * Lanes fill from the middle out: 4, 3, 5, 2, 1, 6.
--
-- ---------------------------------------------------------------------------
-- CATEGORY RUNNING ORDER
-- ---------------------------------------------------------------------------
-- The order the deck calls the boards of one event:
--
--   14 & Under Women -> 14 & Under Men -> 17 & Under/Open Women -> ... Men
--
-- Buckets are (heat_group, gender), NOT (age_group, gender). age_group has
-- three values, but ordinary heats only ever carry heat_group, which folds
-- 17 & Under in with Open — so "Open" in the running order means the combined
-- U17_OPEN board, and there are four buckets, not six.
--
-- Skins heats fall out of this for free: materialise_skins_heat() sets
-- heat_group ('U14' -> U13_14, everything else -> U17_OPEN) and gender like
-- any other heat, so a Skins round sorts into the same bucket its swimmers
-- would sort into. Within a bucket, skins_heat_number() already encodes
-- category tens + round units, so U17 rounds precede Open rounds and each
-- board runs 6 -> 4 -> 2 with its swim-off directly after the round it
-- settles. Nothing special-cases Skins, and nothing dumps it at one end.
--
-- ORDERING ONLY. This decides the sequence heats are LISTED in. It is
-- deliberately not a gate: a referee may still score any heat at any time,
-- because a meet that deadlocks behind one disputed 14 & Under heat is worse
-- than a meet scored slightly out of order.
--
-- Gender is nullable on legacy heats seeded before male and female were split
-- into separate races. Those sort last within their own board rather than
-- being silently folded into the men's, which would misstate what they are.
create or replace function public.category_sort_order(
  p_heat_group public.heat_group,
  p_gender public.gender
)
returns integer
language sql
immutable
as $$
  select (case p_heat_group when 'U13_14' then 0 else 3 end)
       + (case p_gender when 'female' then 1 when 'male' then 2 else 3 end);
$$;

comment on function public.category_sort_order(public.heat_group, public.gender) is
  'Running order of the four heat buckets: U13_14 Women (1), U13_14 Men (2), '
  'U17_OPEN Women (4), U17_OPEN Men (5). 3 and 6 are legacy heats with no '
  'gender, which sort last within their own board. Ordering only — never a '
  'gate on scoring.';

-- ---------------------------------------------------------------------------
-- WORLD AQUATICS POINTS
-- ---------------------------------------------------------------------------
-- Used to seed the 50m stroke-switch events, where nobody has a comparable
-- time. A swimmer's ability is instead read from their BEST other event,
-- converted to World Aquatics points so that (say) a 50 Breaststroke and a
-- 100 Freestyle become directly comparable numbers.
--
--   P = 1000 * (base_time / swum_time)^3
--
-- Base times are per stroke x distance x gender. They are DATA, not code, so
-- they can be corrected with a single UPDATE when World Aquatics republishes
-- them — no migration, no redeploy.
--
-- COURSE: these are SHORT COURSE (25m) base times. The program includes a
-- 100m Individual Medley, which is only swum short course, so that is the
-- course this meet runs. If SSC ever moves to a 50m pool, replace the rows in
-- this table with the long course base times; nothing else needs to change.
--
-- ACCURACY: these ship as approximate records rounded to the hundredth and
-- should be verified against the current official list before a meet that
-- depends on them. They only ever decide the ORDER swimmers are seeded in, so
-- a small error shifts a lane, not a result.
create table if not exists public.wa_base_times (
  stroke text not null,
  distance_m integer not null check (distance_m > 0),
  gender public.gender not null,
  base_time_ms integer not null check (base_time_ms > 0),
  updated_at timestamptz not null default now(),
  primary key (stroke, distance_m, gender)
);

insert into public.wa_base_times (stroke, distance_m, gender, base_time_ms) values
  ('Freestyle',         50,  'male',   19900),
  ('Freestyle',        100,  'male',   44840),
  ('Backstroke',        50,  'male',   22110),
  ('Breaststroke',      50,  'male',   24950),
  ('Butterfly',         50,  'male',   21320),
  ('Individual Medley',100,  'male',   49280),
  ('Freestyle',         50,  'female', 22830),
  ('Freestyle',        100,  'female', 50250),
  ('Backstroke',        50,  'female', 25250),
  ('Breaststroke',      50,  'female', 28370),
  ('Butterfly',         50,  'female', 23910),
  ('Individual Medley',100,  'female', 56510)
on conflict (stroke, distance_m, gender) do update
  set base_time_ms = excluded.base_time_ms, updated_at = now();

alter table public.wa_base_times enable row level security;

drop policy if exists "public_read_wa_base_times" on public.wa_base_times;
create policy "public_read_wa_base_times" on public.wa_base_times for select using (true);

drop policy if exists "admins_manage_wa_base_times" on public.wa_base_times;
create policy "admins_manage_wa_base_times" on public.wa_base_times
  for all using (public.is_admin()) with check (public.is_admin());

create or replace function public.world_aquatics_points(
  p_stroke text,
  p_distance_m integer,
  p_gender public.gender,
  p_time_ms integer
)
returns integer
language sql
stable
set search_path = public
as $$
  select case
    when p_time_ms is null or p_time_ms <= 0 then null
    else (
      select floor(1000 * power(b.base_time_ms::numeric / p_time_ms::numeric, 3))::integer
      from public.wa_base_times b
      where b.stroke = p_stroke and b.distance_m = p_distance_m and b.gender = p_gender
    )
  end;
$$;

comment on function public.world_aquatics_points(text, integer, public.gender, integer) is
  'World Aquatics points: 1000 * (base/time)^3. NULL when the event has no '
  'base time on file (relays, skins, and the switch events themselves), which '
  'is why callers must treat NULL as "unrated" rather than "zero".';

-- A swimmer's best World Aquatics points across every event they can be
-- rated on.
--
-- Deliberately reads BOTH sources:
--   * published race results — what they have actually swum, and
--   * seed times on their other confirmed entries — what they declared.
-- The first SSC volume has no prior results at all, so results alone would
-- leave every swimmer unrated and the switch events would fall back to
-- seeding by age on day one. Declared seed times make the rule work from the
-- very first meet, and real results take over naturally as they accumulate
-- (a faster actual swim simply scores higher and wins the max).
--
-- Rateability is decided by whether the event has a row in wa_base_times, NOT
-- by seeds_as_nt. The two are different things and 100m IM is why: it has no
-- official long course event, so nobody can declare a seed time for it
-- (seeds_as_nt), yet it has a perfectly good short course base time and a
-- swimmer's 100 IM result is one of the better things to rate them on.
-- Filtering on seeds_as_nt here would have silently discarded it. Events with
-- no base time (the switch events, relays) score NULL, and max() ignores
-- NULLs — so they drop out on their own without a filter.
create or replace function public.athlete_best_wa_points(p_athlete_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select max(points)::integer from (
    select public.world_aquatics_points(ev.stroke, ev.distance_m, a.gender, r.official_time_ms) as points
    from public.results r
    join public.heat_lanes hl on hl.id = r.heat_lane_id
    join public.entries en on en.id = hl.entry_id
    join public.events ev on ev.id = en.event_id
    join public.athletes a on a.id = en.athlete_id
    where en.athlete_id = p_athlete_id
      and r.status = 'published'
      and r.result_outcome = 'valid'
      and r.official_time_ms is not null
      and ev.is_relay = false

    union all

    select public.world_aquatics_points(ev.stroke, ev.distance_m, a.gender, en.seed_time_ms)
    from public.entries en
    join public.events ev on ev.id = en.event_id
    join public.athletes a on a.id = en.athlete_id
    where en.athlete_id = p_athlete_id
      and en.is_nt = false
      and en.seed_time_ms is not null
      and ev.is_relay = false
  ) rated;
$$;

-- ---------------------------------------------------------------------------
-- BEST PERFORMANCE (World Aquatics points)
-- ---------------------------------------------------------------------------
-- Every published swim, scored in World Aquatics points. This is the one
-- ranking that compares swimmers ACROSS events: a 50 Breaststroke and a
-- 100 Freestyle are not otherwise commensurable, but their points are.
--
-- Rows only exist for events with a base time on file, so the switch events
-- are absent by construction rather than by filter — they have no points
-- system and deliberately keep it that way.
-- create-or-replace cannot rename or reorder a view's columns, so a shape
-- change makes this file un-rerunnable against any database still on the old
-- shape. Dropping first is what keeps schema.sql idempotent across versions.
-- Views hold no data, so there is nothing to lose by rebuilding them.
drop view if exists public.performance_highlights;
drop view if exists public.performance_points;

create or replace view public.performance_points as
select
  r.id                                          as result_id,
  a.id                                          as athlete_id,
  u.full_name                                   as athlete_name,
  t.name                                        as team_name,
  a.gender,
  coalesce(en.age_group_at_entry, a.age_group)  as age_group,
  ev.id                                         as event_id,
  ev.name                                       as event_name,
  ev.stroke,
  ev.distance_m,
  s.meet_volume_id,
  mv.volume_number,
  mv.name                                       as volume_name,
  r.official_time_ms,
  public.world_aquatics_points(ev.stroke, ev.distance_m, a.gender, r.official_time_ms) as wa_points,
  r.created_at                                  as swam_at
from public.results r
join public.heat_lanes hl on hl.id = r.heat_lane_id
join public.heats h       on h.id = hl.heat_id
join public.entries en    on en.id = hl.entry_id
join public.events ev     on ev.id = h.event_id
join public.sessions s    on s.id = ev.session_id
join public.meet_volumes mv on mv.id = s.meet_volume_id
join public.athletes a    on a.id = en.athlete_id
join public.users u       on u.id = a.user_id
left join public.teams t  on t.id = a.team_id
where r.status = 'published'
  and r.result_outcome = 'valid'
  and r.official_time_ms is not null
  and public.world_aquatics_points(ev.stroke, ev.distance_m, a.gender, r.official_time_ms) is not null;

comment on view public.performance_points is
  'Every published valid swim scored in World Aquatics points. Excludes '
  'events with no base time (the 50m switch events, relays), which have no '
  'points system by design.';

-- Which swims are the best anywhere, and the best within their own event.
-- Ties share the top spot: two swimmers on identical points are both "best",
-- which is the same rule finish places follow.
create or replace view public.performance_highlights as
with ranked as (
  select
    pp.*,
    rank() over (order by pp.wa_points desc)                  as overall_rank,
    rank() over (partition by pp.event_id order by pp.wa_points desc) as event_rank
  from public.performance_points pp
)
select
  ranked.*,
  (overall_rank = 1) as is_best_overall,
  (event_rank = 1)   as is_best_in_event
from ranked;

-- ---------------------------------------------------------------------------
-- RELAY SQUADS
-- ---------------------------------------------------------------------------
-- An athlete can compete individually without a team, but a relay is a TEAM
-- entry: four swimmers from one team. public.entries is strictly one athlete
-- per event and cannot express that, which is why relay events have always
-- been schedule-only.
--
-- Composition rules, all enforced below rather than in the UI:
--   * exactly four legs, numbered 1-4
--   * all four swimmers are on the squad's team
--   * all four share the squad's age group (a squad is single-category)
--   * gender comes from the event: (Male) -> four men, (Female) -> four
--     women, (Mixed) -> exactly two of each
--   * a swimmer may appear in at most ONE squad per event, across every team
--   * every swimmer must already be entered in this meet volume
--
-- Medley relays swim a fixed Back / Breast / Fly / Free order, so leg_number
-- IS the stroke and the captain's choice is who takes each leg. Freestyle
-- relays have no stroke, and leg_number is just swim order.
create table if not exists public.relay_squads (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  team_id uuid not null references public.teams (id) on delete cascade,
  age_group public.age_group not null,
  -- A, B, C... in creation order within (event, team). A team may enter as
  -- many squads as it can fill.
  squad_letter text not null,
  status public.entry_status not null default 'pending_payment',
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, team_id, squad_letter)
);

create table if not exists public.relay_legs (
  id uuid primary key default gen_random_uuid(),
  squad_id uuid not null references public.relay_squads (id) on delete cascade,
  leg_number integer not null check (leg_number between 1 and 4),
  athlete_id uuid not null references public.athletes (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- One swimmer per leg, and one leg per swimmer within a squad.
  unique (squad_id, leg_number),
  unique (squad_id, athlete_id)
);

create index if not exists relay_squads_event_idx on public.relay_squads (event_id);
create index if not exists relay_legs_athlete_idx on public.relay_legs (athlete_id);

-- ---------------------------------------------------------------------------
-- Relay squad holds, capacity and payment — captain-billed, per squad.
-- ---------------------------------------------------------------------------
-- A relay squad is ONE payable unit, owed by the team captain, never split
-- across the four swimmers on it. This was not always true — an earlier
-- version of quote_athlete_entries() charged each swimmer their own leg fee
-- individually — but "some relays get paid, some don't, per squad, and the
-- captain is the one who decides" only makes sense if payment is a property
-- of the squad, not of each swimmer's own entry. See quote_relay_squad_egp()
-- and confirm_relay_squad_payment() below.
--
-- Same hold mechanism as an individual entry, deliberately: a squad occupies
-- a relay-event capacity slot the moment it is created (even before it has 4
-- legs — see relay_event_capacity() below), and if the captain does not both
-- complete AND pay for it within the hold window, the slot releases. Without
-- this, a team could create relay squads indefinitely and never pay, locking
-- other teams out of a capacity-limited relay event with no consequence.
alter table public.relay_squads
  add column if not exists hold_expires_at timestamptz;

comment on column public.relay_squads.hold_expires_at is
  'When an unpaid squad stops holding its relay-event capacity slot. Stamped '
  'on insert from meet_settings.hold_window_hours, same as entries. Cleared '
  'once the squad is paid (confirm_relay_squad_payment()).';

create index if not exists relay_squads_hold_expires_at_idx
  on public.relay_squads (hold_expires_at)
  where hold_expires_at is not null;

-- Mirrors public.set_entry_hold_expiry() exactly, keyed through
-- event -> session -> volume -> meet_settings the same way.
create or replace function public.set_relay_squad_hold_expiry()
returns trigger
language plpgsql
as $$
declare
  v_hours integer;
begin
  if new.status = 'pending_payment' and new.hold_expires_at is null then
    select ms.hold_window_hours into v_hours
    from public.meet_settings ms
    join public.sessions s on s.meet_volume_id = ms.meet_volume_id
    join public.events e on e.session_id = s.id
    where e.id = new.event_id;

    new.hold_expires_at := now() + make_interval(hours => coalesce(v_hours, 48));
  elsif new.status = 'confirmed' then
    new.hold_expires_at := null;
  end if;

  return new;
end;
$$;

create or replace trigger set_relay_squad_hold_expiry_trigger
  before insert or update of status on public.relay_squads
  for each row execute function public.set_relay_squad_hold_expiry();

-- ---------------------------------------------------------------------------
-- public.relay_event_capacity — event_capacity(), but for relay squads.
-- ---------------------------------------------------------------------------
-- public.event_capacity() counts public.entries rows. A relay squad is never
-- inserted into entries at all — it lives in relay_squads/relay_legs — so
-- events.capacity_cap has silently never applied to a relay event, despite
-- being a column on every event row including relay ones. This is the
-- counting function that was missing, not a new column: it reuses
-- events.capacity_cap unchanged, just counts the right table.
--
-- A squad counts against capacity from the moment it is CREATED, complete or
-- not — an event capped at 8 relay squads has to mean 8 squads claimed, not
-- 8 squads paid, or a team could sit on an unlimited number of empty squad
-- slots with no consequence until the hold sweep eventually catches up.
create or replace function public.relay_event_capacity(p_event_id uuid)
returns table (
  capacity_cap integer,
  paid_count integer,
  held_count integer,
  free_count integer,
  availability public.event_availability
)
language sql
stable
as $$
  with cap as (
    select coalesce(e.capacity_cap, ms.default_event_capacity, 64) as cap,
           coalesce(ms.selling_out_threshold_percent, 20) as threshold
    from public.events e
    join public.sessions s on s.id = e.session_id
    left join public.meet_settings ms on ms.meet_volume_id = s.meet_volume_id
    where e.id = p_event_id
  ),
  counts as (
    select
      count(*) filter (where rs.status = 'confirmed')::integer as paid,
      count(*) filter (
        where rs.status = 'pending_payment'
          and (rs.hold_expires_at is null or rs.hold_expires_at > now())
      )::integer as held
    from public.relay_squads rs
    where rs.event_id = p_event_id
  )
  select
    cap.cap,
    counts.paid,
    counts.held,
    greatest(cap.cap - counts.paid - counts.held, 0)::integer as free_count,
    case
      when cap.cap - counts.paid - counts.held <= 0 then 'full'
      when (cap.cap - counts.paid - counts.held) * 100 <= cap.cap * cap.threshold
        then 'selling_out_soon'
      else 'available'
    end::public.event_availability
  from cap, counts;
$$;

comment on function public.relay_event_capacity(uuid) is
  'event_capacity() for relay squads: identical shape, counts relay_squads '
  'against events.capacity_cap instead of entries. The column was already '
  'there and unused for relay events; this is the missing counting function.';

-- ---------------------------------------------------------------------------
-- relay_squad_payments — who paid for a squad, and how much.
-- ---------------------------------------------------------------------------
-- Not public.entry_payments: that table is keyed to athlete_id, one payer per
-- individual entry. A relay squad has no single "owner" athlete — it is owed
-- by whoever captains the team — so this is its own table with its own key.
create table if not exists public.relay_squad_payments (
  id uuid primary key default gen_random_uuid(),
  squad_id uuid not null references public.relay_squads (id) on delete cascade,
  -- Snapshotted at payment time: legs x meet_settings.relay_swimmer_price_egp
  -- as it stood the moment payment was collected. relay_swimmer_price_egp is
  -- flat, not tiered (see TECH_STACK_DECISIONS.md §3), so unlike an
  -- individual entry this amount has no "which tier" ambiguity to record.
  amount_egp integer not null check (amount_egp >= 0),
  method text not null default 'cash',
  -- Server-derived, exactly as on entry_payments above.
  collected_by uuid references public.users (id) on delete set null default public.current_collector(),
  collected_at timestamptz not null default now(),
  note text,
  -- One payment per squad. A squad that needs re-billing (a leg swapped after
  -- payment, say) is an admin correction, not a second payment row.
  unique (squad_id)
);

create index if not exists relay_squad_payments_squad_idx
  on public.relay_squad_payments (squad_id);

comment on table public.relay_squad_payments is
  'One row per PAID relay squad. The captain is billed for the whole squad, '
  'not each swimmer individually — see the comment on relay_squads above.';

-- Same PAYMENT_OVERRIDE category as entry_payments' own trigger above, but
-- its own function rather than a shared one — see the comment on
-- audit_entry_payment_insert() for why a `case tg_table_name` dispatch does
-- not actually work here.
create or replace function public.audit_relay_squad_payment_insert()
returns trigger
language plpgsql
as $$
begin
  perform public.log_admin_action(
    'PAYMENT_OVERRIDE',
    'relay_squad_payments',
    new.id,
    jsonb_build_object(
      'squad_id', new.squad_id,
      'amount_egp', new.amount_egp,
      'method', new.method
    )
  );
  return new;
end;
$$;

create or replace trigger audit_relay_squad_payment_insert_trigger
  after insert on public.relay_squad_payments
  for each row execute function public.audit_relay_squad_payment_insert();

-- Same collector rule as entry_payments — see public.enforce_collected_by().
create or replace trigger enforce_relay_squad_payment_collected_by
  before insert on public.relay_squad_payments
  for each row execute function public.enforce_collected_by();

-- ---------------------------------------------------------------------------
-- public.quote_relay_squad_egp — what a squad costs, and whether it can be
-- paid for yet.
-- ---------------------------------------------------------------------------
-- `payable` is genuinely defensive rather than a check this function expects
-- to ever see fail: validate_relay_squad() (a deferred constraint trigger on
-- relay_legs, predating this feature) already refuses to let ANY transaction
-- commit while a squad has fewer than 4 legs — a 3/4 squad cannot exist as a
-- persisted row at all, only as unsubmitted state in a captain's browser. So
-- `legs_filled` is always 4 for any row this function is ever actually asked
-- about. The field is kept anyway: if that constraint is ever relaxed later
-- to allow real draft squads, this function and confirm_relay_squad_payment()
-- already do the right thing with no further change, rather than silently
-- quoting or accepting payment for an incomplete squad.
create or replace function public.quote_relay_squad_egp(p_squad_id uuid)
returns table (legs_filled integer, amount_egp integer, payable boolean)
language sql
stable
as $$
  select
    count(rl.id)::integer as legs_filled,
    (count(rl.id) * coalesce(ms.relay_swimmer_price_egp, 300))::integer as amount_egp,
    count(rl.id) = 4 as payable
  from public.relay_squads rs
  left join public.relay_legs rl on rl.squad_id = rs.id
  join public.events e on e.id = rs.event_id
  join public.sessions s on s.id = e.session_id
  left join public.meet_settings ms on ms.meet_volume_id = s.meet_volume_id
  where rs.id = p_squad_id
  group by ms.relay_swimmer_price_egp;
$$;

-- ---------------------------------------------------------------------------
-- public.confirm_relay_squad_payment — the cash desk's write path.
-- ---------------------------------------------------------------------------
-- ADMIN-ONLY, deliberately — the captain is who OWES for the squad, not who
-- may mark it paid. Every other payment in this app works the same way: cash
-- changes hands physically, an admin confirms it in the UI (see
-- confirmCashPayment() for individual entries). A captain self-confirming
-- their own team's payment would mean the person with the money and the
-- person verifying the money arrived are the same person — letting a
-- swimmer confirm their own entry fee has never been allowed either.
--
-- This also matches enforce_relay_status_change_trigger, which already
-- refuses to move relay_squads.status to 'confirmed' for anyone but an
-- admin — that trigger predates this function and was not written for it,
-- but it enforces the same rule this function would otherwise have needed to
-- add: this is not a coincidence, cash-collected-in-person payment
-- confirmation has exactly one actor throughout this schema.
--
-- Refuses anything short of 4/4 legs, refuses a double-payment, and writes
-- the payment record BEFORE flipping the squad to 'confirmed' — same
-- ordering as the individual cash desk, so a failure between the two steps
-- leaves the squad unpaid and re-collectable rather than confirmed with no
-- receipt.
-- p_collected_by is gone: public.enforce_collected_by() resolves the
-- collector from auth.uid(), and a parameter that accepts an id then silently
-- ignores it is worse than no parameter at all. Dropped by full signature
-- first — Postgres treats the 3-arg and 2-arg forms as different functions,
-- so without the drop the old one lingers and PostgREST can still resolve a
-- call that supplies it.
drop function if exists public.confirm_relay_squad_payment(uuid, uuid, text);

create or replace function public.confirm_relay_squad_payment(
  p_squad_id uuid,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote record;
begin
  if not public.is_admin() then
    raise exception 'Only an admin may confirm a relay squad payment';
  end if;

  select * into v_quote from public.quote_relay_squad_egp(p_squad_id);
  if v_quote is null or not v_quote.payable then
    raise exception 'Relay squad is not complete (needs 4/4 legs assigned before it can be paid)';
  end if;

  if exists (select 1 from public.relay_squad_payments where squad_id = p_squad_id) then
    raise exception 'This relay squad has already been paid';
  end if;

  -- collected_by omitted deliberately: the column default and the BEFORE
  -- INSERT trigger both resolve it to auth.uid(). This function is SECURITY
  -- DEFINER and so runs with RLS bypassed, but auth.uid() still reads the
  -- request's JWT claim — which is exactly why the rule lives in a trigger.
  insert into public.relay_squad_payments (squad_id, amount_egp, note)
  values (p_squad_id, v_quote.amount_egp, p_note);

  update public.relay_squads set status = 'confirmed' where id = p_squad_id;

  return p_squad_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- public.reclaim_relay_squad_hold — [Reclaim] on an expired relay hold.
-- ---------------------------------------------------------------------------
-- Mirrors public.reclaim_entry_slot(), captain-initiated rather than
-- swimmer-initiated: the captain is who is billed, so the captain is who
-- reclaims. Re-checks relay_event_capacity() INSIDE this statement — checking
-- in the browser and then writing would let two teams both see the last slot
-- free and both reclaim it.
create or replace function public.reclaim_relay_squad_hold(p_squad_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_squad record;
  v_free integer;
  v_hours integer;
begin
  select rs.id, rs.event_id, rs.team_id, rs.status
    into v_squad
  from public.relay_squads rs
  where rs.id = p_squad_id;

  if not found then
    raise exception 'Relay squad not found';
  end if;

  if not (public.is_admin() or public.is_team_captain_of(v_squad.team_id)) then
    raise exception 'Not permitted to reclaim this relay squad';
  end if;

  if v_squad.status = 'confirmed' then
    return true;
  end if;

  select ec.free_count into v_free from public.relay_event_capacity(v_squad.event_id) ec;
  if coalesce(v_free, 0) <= 0 then
    return false;
  end if;

  select ms.hold_window_hours into v_hours
  from public.meet_settings ms
  join public.sessions s on s.meet_volume_id = ms.meet_volume_id
  join public.events e on e.session_id = s.id
  where e.id = v_squad.event_id;

  update public.relay_squads
  set status = 'pending_payment',
      hold_expires_at = now() + make_interval(hours => coalesce(v_hours, 48))
  where id = p_squad_id;

  return true;
end;
$$;

comment on function public.reclaim_relay_squad_hold(uuid) is
  'Re-acquires a hold on an expired relay squad if the event still has room. '
  'Captain-initiated (reclaim_entry_slot() is the individual-entry, '
  'swimmer-initiated equivalent). False when the relay event is full.';

-- ---------------------------------------------------------------------------
-- public.quote_athlete_entries — the price, and why it is the price.
-- ---------------------------------------------------------------------------
-- Returns LINE ITEMS, not a total. Every screen that asks an athlete for money
-- has to show which race cost what, so a function that returned a single
-- number would just be recomputed differently by each caller — which is how
-- the desk and the registration page end up disagreeing.
--
--   total = package(n races, tier)
--         + one additional-race price for each race beyond the 4th
--         + each entered race's own surcharge
--
-- Relay squads are priced and paid separately — see quote_relay_squad_egp().
--
-- Race count is taken across the WHOLE volume, not per session: three races
-- spread over two sessions is one three-race package.
--
-- p_include_statuses controls what counts. Registration quotes everything the
-- athlete has selected; the cash desk quotes only what is still owed.
create or replace function public.quote_athlete_entries(
  p_athlete_id uuid,
  p_meet_volume_id uuid,
  p_include_statuses public.entry_status[] default array['pending_payment']::public.entry_status[]
)
returns table (
  kind text,
  label text,
  entry_id uuid,
  amount_egp integer,
  tier public.pricing_tier
)
language sql
stable
as $$
  with tier as (
    select public.active_pricing_tier(p_meet_volume_id) as t
  ),
  individual as (
    select en.id as entry_id, e.name as event_name,
           coalesce(e.surcharge_egp, 0) as surcharge,
           row_number() over (order by s.session_number, e.event_order, e.name) as nth
    from public.entries en
    join public.events e on e.id = en.event_id
    join public.sessions s on s.id = e.session_id
    where s.meet_volume_id = p_meet_volume_id
      and en.athlete_id = p_athlete_id
      and en.status = any (p_include_statuses)
      and e.is_relay = false
  ),
  race_count as (select count(*)::integer as n from individual),
  -- Package covers the first 4; anything past that is priced one at a time.
  package as (
    select pp.price_egp, rc.n
    from race_count rc
    join tier on true
    left join public.pricing_packages pp
      on pp.meet_volume_id = p_meet_volume_id
     and pp.tier = tier.t
     and pp.race_count = least(rc.n, 4)
    where rc.n > 0
  ),
  extra_price as (
    select pp.price_egp
    from tier
    join public.pricing_packages pp
      on pp.meet_volume_id = p_meet_volume_id
     and pp.tier = tier.t
     and pp.race_count = 0
  )
  -- The package line.
  select
    'package'::text,
    case when package.n > 4
      then package.n || '-race entry (4-race package + ' || (package.n - 4) || ' extra)'
      else package.n || '-race package' end,
    null::uuid,
    package.price_egp,
    tier.t
  from package, tier

  union all

  -- Races past the fourth, one line each so the athlete can see them.
  select
    'additional_race'::text,
    'Additional race — ' || i.event_name,
    i.entry_id,
    coalesce((select price_egp from extra_price), 0),
    (select t from tier)
  from individual i
  where i.nth > 4

  union all

  -- Per-race surcharges. Zero-surcharge races are omitted rather than listed
  -- as "+0": a breakdown of forty lines that are mostly zero explains nothing.
  select
    'surcharge'::text,
    i.event_name || ' surcharge',
    i.entry_id,
    i.surcharge,
    (select t from tier)
  from individual i
  where i.surcharge > 0;
$$;

comment on function public.quote_athlete_entries(uuid, uuid, public.entry_status[]) is
  'Line items behind what an athlete owes for a volume: the package, any '
  'races past the fourth, and per-race surcharges, all at the tier in force '
  'now. Returns the derivation, not just a total, because every screen that '
  'asks for money must show why.'
  ' '
  'Relay legs are DELIBERATELY not here. A relay squad is one payable unit,'
  ' owed by the team captain, not split across the swimmers on it — see'
  ' quote_relay_squad_egp() and public.relay_squad_payments. This function'
  ' used to include a per-leg charge on each swimmer''s own quote; that was'
  ' removed, not layered under, when squad-level captain billing replaced'
  ' it, so a relay never gets charged to both the swimmer and the captain.';

alter table public.relay_squads enable row level security;
alter table public.relay_legs enable row level security;

-- The medley stroke for a leg, or null when the event is not a medley.
create or replace function public.relay_leg_stroke(p_event_stroke text, p_leg integer)
returns text
language sql
immutable
as $$
  select case
    when p_event_stroke not ilike '%medley%' then null
    when p_leg = 1 then 'Backstroke'
    when p_leg = 2 then 'Breaststroke'
    when p_leg = 3 then 'Butterfly'
    when p_leg = 4 then 'Freestyle'
  end;
$$;

comment on function public.relay_leg_stroke(text, integer) is
  'Medley relays swim a fixed Back/Breast/Fly/Free order, so the leg number '
  'determines the stroke. Returns null for freestyle relays, where the leg '
  'number is only swim order.';

-- How many swimmers of each gender an event requires. Read from the event
-- NAME because that is where the programme states it: "(Male)", "(Female)",
-- "(Mixed)". Every mixed relay is exactly 2 + 2.
create or replace function public.relay_gender_requirement(p_event_name text)
returns table (male_count integer, female_count integer)
language sql
immutable
as $$
  select case
    when p_event_name ilike '%(male%' then 4
    when p_event_name ilike '%(female%' then 0
    else 2
  end,
  case
    when p_event_name ilike '%(male%' then 0
    when p_event_name ilike '%(female%' then 4
    else 2
  end;
$$;

-- Validates a squad's roster. Runs as a CONSTRAINT TRIGGER deferred to
-- commit, because the rules are about the squad as a whole (four legs, two of
-- each gender) and cannot be judged while the legs are still being inserted
-- one at a time.
create or replace function public.validate_relay_squad()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_squad_id uuid;
  v_squad public.relay_squads%rowtype;
  v_event public.events%rowtype;
  v_legs integer;
  v_male integer;
  v_female integer;
  v_need_male integer;
  v_need_female integer;
  v_wrong_team integer;
  v_wrong_age integer;
  v_not_entered integer;
  v_volume_id uuid;
begin
  v_squad_id := coalesce(new.squad_id, old.squad_id);

  select * into v_squad from public.relay_squads where id = v_squad_id;
  -- Squad deleted in the same transaction: its legs go with it, nothing to check.
  if v_squad.id is null then
    return null;
  end if;

  select * into v_event from public.events where id = v_squad.event_id;

  if not coalesce(v_event.is_relay, false) then
    raise exception 'Relay squads can only be entered for relay events.';
  end if;

  select s.meet_volume_id into v_volume_id
  from public.sessions s where s.id = v_event.session_id;

  select count(*) into v_legs from public.relay_legs where squad_id = v_squad_id;
  if v_legs <> 4 then
    raise exception 'A relay squad needs exactly 4 swimmers (this one has %).', v_legs;
  end if;

  select
    count(*) filter (where a.gender = 'male'),
    count(*) filter (where a.gender = 'female'),
    count(*) filter (where a.team_id is distinct from v_squad.team_id),
    count(*) filter (where a.age_group <> v_squad.age_group)
  into v_male, v_female, v_wrong_team, v_wrong_age
  from public.relay_legs rl
  join public.athletes a on a.id = rl.athlete_id
  where rl.squad_id = v_squad_id;

  if v_wrong_team > 0 then
    raise exception 'Every swimmer in a relay squad must be on that team (% are not).', v_wrong_team;
  end if;

  if v_wrong_age > 0 then
    raise exception 'All four swimmers must be in the squad''s age group (% are not).', v_wrong_age;
  end if;

  select male_count, female_count into v_need_male, v_need_female
  from public.relay_gender_requirement(v_event.name);

  if v_male <> v_need_male or v_female <> v_need_female then
    raise exception
      '% needs % male and % female swimmers (this squad has % male, % female).',
      v_event.name, v_need_male, v_need_female, v_male, v_female;
  end if;

  -- Already entered in this meet: a relay swimmer must be competing in it,
  -- not brought in for the relay alone.
  select count(*) into v_not_entered
  from public.relay_legs rl
  where rl.squad_id = v_squad_id
    and not exists (
      select 1
      from public.entries en
      join public.events ev on ev.id = en.event_id
      join public.sessions se on se.id = ev.session_id
      where en.athlete_id = rl.athlete_id
        and se.meet_volume_id = v_volume_id
    );
  if v_not_entered > 0 then
    raise exception
      '% swimmer(s) are not entered in this meet. Relay swimmers must already have an individual entry.',
      v_not_entered;
  end if;

  -- One squad per swimmer per event, across every team — checked here rather
  -- than with a unique index because the event lives on the squad, not the leg.
  if exists (
    select 1
    from public.relay_legs rl
    join public.relay_squads rs on rs.id = rl.squad_id
    join public.relay_legs mine on mine.athlete_id = rl.athlete_id
    where mine.squad_id = v_squad_id
      and rs.event_id = v_squad.event_id
      and rs.id <> v_squad_id
  ) then
    raise exception 'A swimmer can only be in one squad per relay event.';
  end if;

  return null;
end;
$$;

drop trigger if exists validate_relay_squad_trigger on public.relay_legs;
create constraint trigger validate_relay_squad_trigger
  after insert or update or delete on public.relay_legs
  deferrable initially deferred
  for each row execute function public.validate_relay_squad();

-- Only the team's captain (or an admin) may enter or change that team's
-- squads. Everyone can read them: a heat sheet is public.
drop policy if exists "public_read_relay_squads" on public.relay_squads;
create policy "public_read_relay_squads" on public.relay_squads for select using (true);

drop policy if exists "captain_manages_relay_squads" on public.relay_squads;
create policy "captain_manages_relay_squads" on public.relay_squads
  for all
  using (public.is_admin() or public.is_team_captain_of(team_id))
  with check (public.is_admin() or public.is_team_captain_of(team_id));

drop policy if exists "public_read_relay_legs" on public.relay_legs;
create policy "public_read_relay_legs" on public.relay_legs for select using (true);

drop policy if exists "captain_manages_relay_legs" on public.relay_legs;
create policy "captain_manages_relay_legs" on public.relay_legs
  for all
  using (
    public.is_admin()
    or exists (
      select 1 from public.relay_squads rs
      where rs.id = squad_id and public.is_team_captain_of(rs.team_id)
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.relay_squads rs
      where rs.id = squad_id and public.is_team_captain_of(rs.team_id)
    )
  );

alter table public.relay_squad_payments enable row level security;

-- Read: any member of the squad's team, or the team's captain, or an admin —
-- "has our relay been paid for" is legitimate transparency for the whole
-- squad, not just the captain who paid. Write: admin only, matching
-- entry_payments — see confirm_relay_squad_payment() above for why a captain
-- cannot self-confirm.
drop policy if exists "team_or_admin_view_relay_squad_payments" on public.relay_squad_payments;
create policy "team_or_admin_view_relay_squad_payments" on public.relay_squad_payments
  for select using (
    public.is_admin()
    or exists (
      select 1 from public.relay_squads rs
      join public.team_memberships tm on tm.team_id = rs.team_id
      where rs.id = relay_squad_payments.squad_id
        and (tm.user_id = auth.uid() and tm.status = 'accepted')
    )
    or exists (
      select 1 from public.relay_squads rs
      where rs.id = relay_squad_payments.squad_id
        and public.is_team_captain_of(rs.team_id)
    )
  );

drop policy if exists "admins_manage_relay_squad_payments" on public.relay_squad_payments;
create policy "admins_manage_relay_squad_payments" on public.relay_squad_payments
  for all using (public.is_admin()) with check (public.is_admin());

-- Only an admin may confirm a relay squad's payment, mirroring
-- enforce_entry_status_change for individual entries.
create or replace function public.enforce_relay_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'confirmed' and not public.is_admin() then
    raise exception 'Only an admin may confirm relay payment.';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_relay_status_change_trigger on public.relay_squads;
create trigger enforce_relay_status_change_trigger
  before insert or update on public.relay_squads
  for each row execute function public.enforce_relay_status_change();

-- ---------------------------------------------------------------------------
-- SKINS LANES
-- ---------------------------------------------------------------------------
-- Skins qualification is derived from results, so a Skins swimmer has no
-- entry of their own — and results are written against heat_lanes, which
-- require one. The bracket UI therefore had nothing real to publish against:
-- it built placeholder ids like 'skins-<athleteId>', which are not UUIDs, so
-- every lane was skipped on publish and scoring a Skins round silently wrote
-- nothing at all.
--
-- This materialises the missing rows for one board (age group x gender):
-- entries for the Skins event, a heat, and its lanes. Idempotent — re-running
-- returns the same heat and lanes rather than duplicating them, so an admin
-- reopening the bracket does not create a second field.
-- Heat numbers must stay unique within (event, heat_group, gender) even
-- though a Skins board's real identity is (category, round, swim-off). Encode
-- all three into one number rather than widening the base constraint:
-- category tens, round units, +5 for the swim-off that settles it.
create or replace function public.skins_heat_number(
  p_category public.age_group,
  p_round integer,
  p_swim_off boolean
)
returns integer
language sql
immutable
as $$
  select (case p_category when 'U14' then 1 when 'U17' then 2 else 3 end) * 10
       + (case p_round when 6 then 1 when 4 then 2 else 3 end)
       + (case when p_swim_off then 5 else 0 end);
$$;

comment on function public.skins_heat_number(public.age_group, integer, boolean) is
  'Stable heat_number for one Skins board+round, so the per-bucket heat '
  'number constraint holds without U17 and Open colliding.';

drop function if exists public.materialise_skins_heat(uuid, public.age_group, public.gender, uuid[]);
create or replace function public.materialise_skins_heat(
  p_skins_event_id uuid,
  p_category public.age_group,
  p_gender public.gender,
  p_athlete_ids uuid[],
  p_lane_numbers integer[],
  p_round integer,
  p_swim_off boolean
)
returns table (athlete_id uuid, entry_id uuid, heat_lane_id uuid, lane_number integer)
language plpgsql
security definer
set search_path = public
as $$
-- The RETURNS TABLE columns (athlete_id, entry_id, ...) are OUT parameters,
-- and they shadow the identically named table columns — which made the
-- ON CONFLICT (event_id, athlete_id) below ambiguous and the whole function
-- fail at runtime. Resolve bare names to columns; every local is v_-prefixed
-- so nothing else is affected.
#variable_conflict use_column
declare
  v_heat_group public.heat_group;
  v_heat_id uuid;
  v_heat_number integer;
  v_athlete uuid;
  v_entry uuid;
  v_index integer := 0;
  v_count integer;
  v_matches_request boolean;
  v_already_scored boolean;
begin
  if not public.is_admin_or_referee() then
    raise exception 'Only admins or referees may set up a Skins heat.';
  end if;

  if not exists (select 1 from public.events where id = p_skins_event_id and is_skins) then
    raise exception 'materialise_skins_heat expects a Skins event (is_skins = true)';
  end if;

  if p_round not in (6, 4, 2) then
    raise exception 'Skins rounds are 6, 4 and 2 — got %', p_round;
  end if;

  v_count := coalesce(array_length(p_athlete_ids, 1), 0);
  if v_count = 0 then
    raise exception 'A Skins round needs at least one swimmer.';
  end if;

  if coalesce(array_length(p_lane_numbers, 1), 0) <> v_count then
    raise exception 'Every Skins swimmer needs exactly one lane (% swimmers, % lanes).',
      v_count, coalesce(array_length(p_lane_numbers, 1), 0);
  end if;

  if exists (select 1 from unnest(p_lane_numbers) ln where ln < 1 or ln > 6) then
    raise exception 'Skins lanes must be between 1 and 6.';
  end if;

  if exists (select 1 from unnest(p_lane_numbers) ln group by ln having count(*) > 1) then
    raise exception 'Two Skins swimmers cannot be put in the same lane.';
  end if;

  if exists (select 1 from unnest(p_athlete_ids) aid group by aid having count(*) > 1) then
    raise exception 'A swimmer cannot occupy two lanes in the same Skins round.';
  end if;

  v_heat_group := case when p_category = 'U14' then 'U13_14' else 'U17_OPEN' end;
  v_heat_number := public.skins_heat_number(p_category, p_round, p_swim_off);

  -- Keyed on the BOARD and the ROUND, not on heat_group: heat_group cannot
  -- tell U17 from Open, and every round of a board is its own heat.
  select h.id into v_heat_id
  from public.heats h
  where h.event_id = p_skins_event_id
    and h.skins_category = p_category
    and h.gender is not distinct from p_gender
    and h.skins_round = p_round
    and h.skins_swim_off = p_swim_off;

  if v_heat_id is null then
    insert into public.heats (
      event_id, heat_group, gender, heat_number, heat_order, status,
      skins_category, skins_round, skins_swim_off
    )
    values (
      p_skins_event_id, v_heat_group, p_gender, v_heat_number, v_heat_number, 'published',
      p_category, p_round, p_swim_off
    )
    returning id into v_heat_id;
  end if;

  -- Is the field already exactly as asked for? Re-rendering the bracket calls
  -- this on every mount, and a re-seed that is really a no-op must not touch
  -- the lanes — deleting them cascades results away.
  select coalesce(
    (select array_agg(hl.lane_number || ':' || en.athlete_id::text order by hl.lane_number)
     from public.heat_lanes hl
     join public.entries en on en.id = hl.entry_id
     where hl.heat_id = v_heat_id),
    array[]::text[]
  ) = coalesce(
    (select array_agg(t.lane || ':' || t.aid::text order by t.lane)
     from unnest(p_lane_numbers, p_athlete_ids) as t(lane, aid)),
    array[]::text[]
  ) into v_matches_request;

  if not v_matches_request then
    select exists (
      select 1
      from public.results r
      join public.heat_lanes hl on hl.id = r.heat_lane_id
      where hl.heat_id = v_heat_id and r.result_outcome is not null
    ) into v_already_scored;

    -- Somebody has already scored this round. Re-seeding would delete their
    -- work by cascade, so the existing field stands and the caller gets it
    -- back unchanged; changing a scored round is an explicit reopen.
    if not v_already_scored then
      delete from public.heat_lanes where heat_id = v_heat_id;

      foreach v_athlete in array p_athlete_ids loop
        v_index := v_index + 1;

        -- Skins entries are always NT: there is no seed time for a knockout.
        insert into public.entries (event_id, athlete_id, seed_time_ms, is_nt, status)
        values (p_skins_event_id, v_athlete, null, true, 'confirmed')
        on conflict (event_id, athlete_id) do update set status = 'confirmed'
        returning id into v_entry;

        insert into public.heat_lanes (heat_id, lane_number, entry_id)
        values (v_heat_id, p_lane_numbers[v_index], v_entry);
      end loop;
    end if;
  end if;

  return query
  select a.id, en.id, hl.id, hl.lane_number
  from public.heat_lanes hl
  join public.entries en on en.id = hl.entry_id
  join public.athletes a on a.id = en.athlete_id
  where hl.heat_id = v_heat_id
  order by hl.lane_number;
end;
$$;

comment on function public.materialise_skins_heat(uuid, public.age_group, public.gender, uuid[], integer[], integer, boolean) is
  'Creates (or returns) the entries, heat and lanes for ONE ROUND of one '
  'Skins board so that round can be scored and published on its own. Skins '
  'swimmers have no entry of their own because qualification comes from '
  'results, and results need a heat_lane.';

-- ---------------------------------------------------------------------------
-- SEED TIMES FROM MEET HISTORY (volume 2 onward)
-- ---------------------------------------------------------------------------
-- Volume 1 is the only meet where a swimmer declares their own seed time,
-- because it is the only meet with no history to draw on. From volume 2 the
-- seed time is FOUND, not claimed: their best official time for that same
-- stroke and distance in any earlier volume.
--
-- Matching is on (stroke, distance_m) rather than event id, so a swimmer who
-- swam the 50m Freestyle in Vol. 1 is seeded on it in Vol. 2 even though the
-- two volumes have different event rows.
--
-- Only published, valid, actually-swum times count. A DQ or an NS is not a
-- time, and a draft result is not official yet.
create or replace function public.best_previous_official_time(
  p_athlete_id uuid,
  p_event_id uuid
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select ev.stroke, ev.distance_m, s.meet_volume_id, mv.volume_number
    from public.events ev
    join public.sessions s on s.id = ev.session_id
    join public.meet_volumes mv on mv.id = s.meet_volume_id
    where ev.id = p_event_id
  )
  select min(r.official_time_ms)::integer
  from public.results r
  join public.heat_lanes hl on hl.id = r.heat_lane_id
  join public.entries en on en.id = hl.entry_id
  join public.events ev on ev.id = en.event_id
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  cross join target t
  where en.athlete_id = p_athlete_id
    and ev.stroke = t.stroke
    and ev.distance_m = t.distance_m
    and mv.volume_number < t.volume_number
    and r.status = 'published'
    and r.result_outcome = 'valid'
    and r.official_time_ms is not null;
$$;

comment on function public.best_previous_official_time(uuid, uuid) is
  'Best published valid time this athlete has swum for the same stroke and '
  'distance in any EARLIER meet volume. NULL means they have never swum it, '
  'which from volume 2 onward means they enter NT.';

-- Applies the volume-2-onward rule at the moment an entry is written.
--
-- Volume 1 is left exactly as it was: the swimmer's declared seed time stands,
-- because there is no history to override it with. From volume 2, whatever the
-- client sent is discarded and replaced by what the swimmer actually swam —
-- a declared time is a claim, and once there is a record there is no reason to
-- take the claim over the record.
create or replace function public.apply_historical_seed_time()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_volume_number integer;
  v_seeds_as_nt boolean;
  v_previous integer;
begin
  select mv.volume_number, ev.seeds_as_nt
    into v_volume_number, v_seeds_as_nt
  from public.events ev
  join public.sessions s on s.id = ev.session_id
  join public.meet_volumes mv on mv.id = s.meet_volume_id
  where ev.id = new.event_id;

  -- Volume 1, or an event nobody can declare a time for anyway: nothing to do.
  -- (force_nt_for_switch_events handles the seeds_as_nt case.)
  if v_volume_number is null or v_volume_number <= 1 or coalesce(v_seeds_as_nt, false) then
    return new;
  end if;

  v_previous := public.best_previous_official_time(new.athlete_id, new.event_id);

  if v_previous is null then
    -- Never swum it before. NT — and NT swimmers are ordered by their best
    -- event's World Aquatics points, so this is not the back of the heat by
    -- default, just an unknown time.
    new.is_nt := true;
    new.seed_time_ms := null;
  else
    new.is_nt := false;
    new.seed_time_ms := v_previous;
  end if;

  return new;
end;
$$;

drop trigger if exists apply_historical_seed_time_trigger on public.entries;
create trigger apply_historical_seed_time_trigger
  before insert on public.entries
  for each row execute function public.apply_historical_seed_time();

-- Entries for a switch event are always NT, whatever the client sends. The
-- registration form hides the seed-time input, but a hidden input is not a
-- rule — this is.
create or replace function public.force_nt_for_switch_events()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.events e where e.id = new.event_id and e.seeds_as_nt) then
    new.is_nt := true;
    new.seed_time_ms := null;
  end if;
  return new;
end;
$$;

drop trigger if exists force_nt_for_switch_events_trigger on public.entries;
create trigger force_nt_for_switch_events_trigger
  before insert or update on public.entries
  for each row execute function public.force_nt_for_switch_events();

-- Gender split migration. Heats are pure derived data — regenerated from
-- confirmed entries every time payment is confirmed — so an unscored heat can
-- simply be dropped and rebuilt with the split applied. A heat that already
-- has results is NOT touched: deleting it would cascade away real race times.
-- Those keep gender null and are labelled as legacy in the UI.
update public.heats h
set gender = sub.gender::public.gender
from (
  select hl.heat_id, min(a.gender::text) as gender
  from public.heat_lanes hl
  join public.entries en on en.id = hl.entry_id
  join public.athletes a on a.id = en.athlete_id
  group by hl.heat_id
  having count(distinct a.gender) = 1
) sub
where h.id = sub.heat_id and h.gender is null;

delete from public.heats h
where h.gender is null
  and not exists (
    select 1 from public.heat_lanes hl
    join public.results r on r.heat_lane_id = hl.id
    where hl.heat_id = h.id
  );

create or replace function public.generate_heats_for_event(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_heats integer := 0;
begin
  -- Never rebuild an event that is already being scored: deleting its heats
  -- would cascade away real results. Re-seeding is only safe pre-race.
  if exists (
    select 1
    from public.results r
    join public.heat_lanes hl on hl.id = r.heat_lane_id
    join public.heats h on h.id = hl.heat_id
    where h.event_id = p_event_id
  ) then
    return 0;
  end if;

  -- Relay and Skins events are never seeded from individual entries.
  if exists (
    select 1 from public.events
    where id = p_event_id and (is_relay = true or is_skins = true)
  ) then
    return 0;
  end if;

  delete from public.heats where event_id = p_event_id;

  -- Four seeding buckets, not two: male and female swim separately in every
  -- age group, so a bucket is (heat_group x gender). Heat numbers run
  -- U13-14 female, U13-14 male, U17/Open female, U17/Open male — the boolean
  -- ORDER BY below encodes exactly that, since false sorts before true.
  with base as (
    select
      e.id as entry_id,
      e.event_id,
      case when coalesce(e.age_group_at_entry, a.age_group) = 'U14'
        then 'U13_14' else 'U17_OPEN' end::public.heat_group as heat_group,
      a.gender,
      e.is_nt,
      e.seed_time_ms,
      a.age,
      public.athlete_best_wa_points(a.id) as wa_points
    from public.entries e
    join public.athletes a on a.id = e.athlete_id
    where e.event_id = p_event_id
      and e.status = 'confirmed'
  ),
  ranked as (
    select
      base.*,
      row_number() over (
        partition by heat_group, gender
        -- Rank 1 is the FASTEST swimmer, and rank 1 lands in the last heat
        -- (fastest heat last). So a declared time always outranks NT: this
        -- previously ordered `is_nt desc`, which ranked every NT swimmer
        -- ahead of the field and put them in the final heat ahead of
        -- swimmers who had actually declared a time.
        order by
          is_nt asc,
          case when is_nt then null else seed_time_ms end asc nulls last,
          -- Among NT swimmers only: no time to rank on, so rank on their best
          -- other event in World Aquatics points (highest first). Age is the
          -- last resort, for a swimmer with nothing rateable on file at all.
          case when is_nt then wa_points end desc nulls last,
          case when is_nt then age end desc nulls last
      ) as rank_in_bucket,
      count(*) over (partition by heat_group, gender) as bucket_size
    from base
  ),
  chunked as (
    select *,
      floor((rank_in_bucket - 1) / 6.0)::int as chunk_index,
      ceil(bucket_size / 6.0)::int as num_chunks,
      (((rank_in_bucket - 1) % 6) + 1)::int as lane_slot
    from ranked
  ),
  -- One row per bucket carrying how many heats precede it, so heat_number
  -- stays unique per event across all four buckets.
  buckets as (
    select
      heat_group,
      gender,
      max(num_chunks) as num_chunks,
      coalesce(
        sum(max(num_chunks)) over (
          order by (heat_group = 'U17_OPEN'), (gender = 'male')
          rows between unbounded preceding and 1 preceding
        ), 0
      )::int as heat_number_offset
    from chunked
    group by heat_group, gender
  ),
  plan as (
    select
      c.event_id,
      c.heat_group,
      c.gender,
      -- heat_number counts WITHIN the bucket ("17 & Under Women Heat 2"),
      -- because that is how a heat is called on deck. heat_order keeps the
      -- global running order across the whole event.
      (c.num_chunks - c.chunk_index) as heat_number,
      b.heat_number_offset + (c.num_chunks - c.chunk_index) as heat_order,
      c.lane_slot,
      c.entry_id
    from chunked c
    join buckets b on b.heat_group = c.heat_group and b.gender = c.gender
  ),
  inserted_heats as (
    insert into public.heats (event_id, heat_group, gender, heat_number, heat_order, status)
    select distinct event_id, heat_group, gender, heat_number, heat_order, 'published'::public.publish_status
    from plan
    returning id, event_id, heat_group, gender, heat_number
  ),
  inserted_lanes as (
    insert into public.heat_lanes (heat_id, lane_number, entry_id)
    select ih.id, (array[4,3,5,2,1,6])[p.lane_slot], p.entry_id
    from plan p
    join inserted_heats ih
      on ih.event_id = p.event_id
     and ih.heat_group = p.heat_group
     and ih.gender is not distinct from p.gender
     and ih.heat_number = p.heat_number
    returning 1
  )
  select count(*) into v_heats from inserted_lanes;

  return v_heats;
end;
$$;

comment on function public.generate_heats_for_event(uuid) is
  'Seeds heats + lanes for one event from its CONFIRMED entries. No-op if the '
  'event already has any result (re-seeding would destroy live scoring) or if '
  'the event is a relay/skins event.';

-- Approving a swimmer confirms their entries; that is the moment heats can be
-- built. Statement-level so a multi-row confirm (one swimmer, four events)
-- rebuilds each affected event exactly once instead of once per row.
create or replace function public.generate_heats_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
begin
  for v_event_id in
    select distinct event_id from new_entries where status = 'confirmed'
  loop
    perform public.generate_heats_for_event(v_event_id);
  end loop;
  return null;
end;
$$;

drop trigger if exists generate_heats_on_confirm_insert on public.entries;
create trigger generate_heats_on_confirm_insert
  after insert on public.entries
  referencing new table as new_entries
  for each statement execute function public.generate_heats_on_confirm();

drop trigger if exists generate_heats_on_confirm_update on public.entries;
-- No column list: Postgres forbids `update of <col>` together with a
-- transition table, and the statement-level transition table is what makes
-- one multi-row confirm rebuild each event once instead of once per entry.
create trigger generate_heats_on_confirm_update
  after update on public.entries
  referencing new table as new_entries
  for each statement execute function public.generate_heats_on_confirm();

-- ===========================================================================
-- EVENT RESULTS — overall standings across every heat of an event.
-- ===========================================================================
-- recompute_heat_finish_places() ranks WITHIN a heat, which is what a referee
-- needs on deck. It is not the event result: heats are seeded by speed, so
-- winning heat 1 is not the same as winning the event. This view is the
-- combined ranking a spectator means by "the results", partitioned the same
-- way the meet is scored (event x age group x gender).
--
-- A view rather than a table: it is derived entirely from published results,
-- so it can never drift out of sync the way a trigger-maintained copy would.
-- Overall standings across every heat of an event.
--
-- CATEGORIES ARE NOT MUTUALLY EXCLUSIVE. Each board means "this age and
-- younger": a 14 & Under swimmer is ranked in 14 & Under, 17 & Under AND
-- Open; a 17 & Under swimmer in 17 & Under and Open; an Open swimmer only in
-- Open. So one result produces up to three rows, one per board it belongs to.
--
-- Ranking is rank(), so equal times share a place and skip the next (1,1,3).
--
-- DQ AND NS ARE IN THIS VIEW. They used to be filtered out entirely, which
-- meant a disqualified swimmer did not appear in the standings at all —
-- indistinguishable from never having entered. They now carry a NULL
-- event_place (they have no place; a 0 would read as one) and NULL time, and
-- every consumer sorts them below all valid swims. `is_ranked` is the flag to
-- sort on; see compareResultStanding() in lib/results.ts for the mirror.
drop view if exists public.event_results;
create or replace view public.event_results as
with scored as (
  select
    ev.id                                             as event_id,
    ev.name                                           as event_name,
    ev.stroke,
    ev.distance_m,
    ev.session_id,
    s.meet_volume_id,
    coalesce(en.age_group_at_entry, a.age_group)      as own_age_group,
    a.gender,
    a.id                                              as athlete_id,
    u.full_name                                       as athlete_name,
    t.name                                            as team_name,
    h.heat_number,
    h.heat_order,
    hl.lane_number,
    r.official_time_ms,
    r.result_outcome,
    r.dq_code,
    -- A swim only earns a place if it produced a time. DQ and NS never do.
    (r.result_outcome = 'valid' and r.official_time_ms is not null) as is_ranked,
    -- NULL for relays, Skins and the switch events, which have no base time
    -- on file and are deliberately unrateable — callers must render that as
    -- an em dash, never as zero points.
    public.world_aquatics_points(ev.stroke, ev.distance_m, a.gender, r.official_time_ms)
                                                      as wa_points
  from public.results r
  join public.heat_lanes hl on hl.id = r.heat_lane_id
  join public.heats h       on h.id = hl.heat_id
  join public.events ev     on ev.id = h.event_id
  join public.sessions s    on s.id = ev.session_id
  join public.entries en    on en.id = hl.entry_id
  join public.athletes a    on a.id = en.athlete_id
  join public.users u       on u.id = a.user_id
  left join public.teams t  on t.id = a.team_id
  where r.status = 'published'
    and r.result_outcome is not null
),
categorised as (
  select scored.*, cat.age_group, (cat.age_group <> scored.own_age_group) as is_open_entry
  from scored
  -- distinct collapses the duplicate for a swimmer whose own group IS Open.
  -- Boards are CUMULATIVE, not exclusive: a 14 & Under swimmer is ranked in
  -- 14 & Under, in 17 & Under, and in Open; a 17 & Under swimmer in 17 & Under
  -- and Open. Each board is "this age and younger", with Open meaning open to
  -- everyone. distinct collapses the duplicate for a swimmer whose own group
  -- already is the board.
  cross join lateral (
    select distinct unnest(
      case scored.own_age_group
        when 'U14' then array['U14', 'U17', 'Open']::public.age_group[]
        when 'U17' then array['U17', 'Open']::public.age_group[]
        else array['Open']::public.age_group[]
      end
    ) as age_group
  ) cat
)
select
  event_id,
  event_name,
  session_id,
  meet_volume_id,
  age_group,
  own_age_group,
  -- True when this row is a younger swimmer ranked up into an older board,
  -- so the UI can say so rather than looking like a mis-categorised entry.
  is_open_entry,
  gender,
  athlete_id,
  athlete_name,
  team_name,
  -- heat_number restarts per (age group, gender), so it identifies a heat
  -- only together with those. heat_order is the event-wide running order and
  -- is what actually distinguishes one heat from another.
  heat_number,
  heat_order,
  lane_number,
  official_time_ms,
  result_outcome,
  dq_code,
  is_ranked,
  wa_points,
  -- Partitioning on is_ranked as well restarts the numbering for the
  -- unranked group, and the CASE then discards it: a DQ has no place, and
  -- giving it "1" (or "0") would state something untrue about the swim.
  case when is_ranked then
    rank() over (
      partition by event_id, age_group, gender, is_ranked
      order by official_time_ms asc
    )
  end                                               as event_place
from categorised;

comment on view public.event_results is
  'Overall per-event standings across ALL heats, partitioned by event x age '
  'group x gender. Distinct from results.finish_place, which ranks only '
  'within a single heat. Includes DQ and NS rows with a NULL event_place and '
  'is_ranked = false, so they can be shown honestly at the bottom of a '
  'standing instead of vanishing from it.';


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

    -- Lane reassignments must reach referees behind the blocks live.
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

-- ---------------------------------------------------------------------------
-- TRIGGER INVENTORY (schema drift guard support)
-- ---------------------------------------------------------------------------
-- scripts/verify-db.ts checks the live database through the ordinary anon
-- PostgREST surface, which exposes no pg_catalog access. That blind spot let
-- a retired trigger (enforce_athlete_approval_change_trigger) survive on the
-- live database while every drift check passed: it silently rewrote each new
-- signup back to approved_by_admin = false, and made schema.sql itself
-- un-rerunnable. Column and policy drift were caught; trigger drift was not.
--
-- This function is the narrow window that closes it. It returns only object
-- NAMES — never row data — and those names are already public in this file,
-- so exposing it to anon leaks nothing while letting the guard run in CI and
-- on Vercel without a service-role key.
--
-- Scope: every non-internal trigger on a public table, plus auth.users (which
-- carries on_auth_user_created, the entire signup path). tgisinternal filters
-- out the constraint-backing triggers Postgres creates for foreign keys.
create or replace function public.trigger_inventory()
returns table (schema_name text, table_name text, trigger_name text)
language sql
stable
security definer
set search_path = public
as $$
  select n.nspname::text, c.relname::text, t.tgname::text
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and (n.nspname = 'public' or (n.nspname = 'auth' and c.relname = 'users'))
  order by 1, 2, 3;
$$;

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
    (1, 'Session 1 — Morning', '09:00'::time, '13:00'::time),
    (2, 'Session 2 — Afternoon', '13:30'::time, '17:00'::time),
    (3, 'Session 3 — Skins', '17:30'::time, '21:00'::time)
) as s(session_number, name, start_time, end_time)
where v.volume_number = 1
on conflict (meet_volume_id, session_number) do nothing;

-- Every volume gets its Control Unit row, its pricing matrix and its tier
-- windows, on the defaults. do-nothing, not do-update: re-running this file
-- must never reset a price an admin has already changed on a live meet. These
-- repeat the backfills next to the table definitions deliberately — a volume
-- created by the block above did not exist when those ran.
insert into public.meet_settings (meet_volume_id)
select v.id from public.meet_volumes v
on conflict (meet_volume_id) do nothing;

insert into public.pricing_packages (meet_volume_id, race_count, tier, price_egp)
select v.id, m.race_count, m.tier::public.pricing_tier, m.price_egp
from public.meet_volumes v
cross join (values
  (0, 'early_bird', 200), (0, 'standard', 300), (0, 'late', 400),
  (1, 'early_bird', 200), (1, 'standard', 300), (1, 'late', 400),
  (2, 'early_bird', 380), (2, 'standard', 560), (2, 'late', 740),
  (3, 'early_bird', 540), (3, 'standard', 700), (3, 'late', 960),
  (4, 'early_bird', 680), (4, 'standard', 900), (4, 'late', 1200)
) as m(race_count, tier, price_egp)
on conflict (meet_volume_id, race_count, tier) do nothing;

insert into public.pricing_tiers (meet_volume_id, tier, starts_at, ends_at)
select
  v.id,
  w.tier::public.pricing_tier,
  (coalesce(v.meet_date, current_date) + w.starts_days)::timestamptz,
  (coalesce(v.meet_date, current_date) + w.ends_days)::timestamptz
from public.meet_volumes v
cross join (values
  ('early_bird', -180, -42),
  ('standard',    -42,  -7),
  ('late',         -7,   1)
) as w(tier, starts_days, ends_days)
on conflict (meet_volume_id, tier) do nothing;

-- System creator / first-boot admin. Subsequent admins must be promoted via
-- the user-role-management panel by an existing admin. Uses do-update (not
-- do-nothing) so re-running this file always enforces the configured email,
-- even against a project that was already seeded with a placeholder value.
insert into public.app_settings (id, superadmin_email)
values (true, 'elewakareem2002@gmail.com')
on conflict (id) do update set
  superadmin_email = excluded.superadmin_email,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- public.pending_cash_total — what the desk is owed for a volume.
-- ---------------------------------------------------------------------------
-- Sums each athlete's own quote rather than multiplying an entry count by a
-- unit price. Under package pricing there IS no unit price: four swimmers with
-- one race each and one swimmer with four races enter the same number of races
-- and owe very different totals. The old count-times-price arithmetic would
-- have been quietly wrong on every meet.
create or replace function public.pending_cash_total(p_meet_volume_id uuid)
returns table (athlete_count integer, total_egp integer)
language sql
stable
as $$
  with owing as (
    select distinct en.athlete_id
    from public.entries en
    join public.events e on e.id = en.event_id
    join public.sessions s on s.id = e.session_id
    where s.meet_volume_id = p_meet_volume_id
      and en.status = 'pending_payment'
  )
  select
    (select count(*) from owing)::integer,
    coalesce((
      select sum(q.amount_egp)
      from owing
      cross join lateral public.quote_athlete_entries(owing.athlete_id, p_meet_volume_id) q
    ), 0)::integer;
$$;

comment on function public.pending_cash_total(uuid) is
  'Athletes owing money and the total owed, summed from each athlete''s own '
  'quote. There is no unit price to multiply by under package pricing.';

-- =============================================================================
-- CAPACITY HELPERS FOR THE CLIENT
-- =============================================================================

-- ---------------------------------------------------------------------------
-- public.events_capacity_bulk — capacity for many races in one round trip.
-- ---------------------------------------------------------------------------
-- A registration form lists twenty races. Calling event_capacity() per race
-- would be twenty HTTP requests; this takes the list. It delegates to the
-- per-race function rather than reimplementing the arithmetic, so there is
-- still exactly one definition of what "full" means.
create or replace function public.events_capacity_bulk(p_event_ids uuid[])
returns table (
  event_id uuid,
  capacity_cap integer,
  paid_count integer,
  held_count integer,
  free_count integer,
  availability public.event_availability
)
language sql
stable
as $$
  select e.id, c.capacity_cap, c.paid_count, c.held_count, c.free_count, c.availability
  from unnest(p_event_ids) as e(id)
  cross join lateral public.event_capacity(e.id) c;
$$;

comment on function public.events_capacity_bulk(uuid[]) is
  'Capacity for many races at once. Delegates to event_capacity() so "full" '
  'has one definition.';

-- ---------------------------------------------------------------------------
-- public.reclaim_entry_slot — [Pay now] on an expired hold.
-- ---------------------------------------------------------------------------
-- Returns true when the slot was re-acquired, false when the race filled up in
-- the meantime (the caller then offers the waitlist).
--
-- The capacity check happens HERE rather than in the browser, and that is the
-- point of the function existing: checking in the client and then writing is a
-- race, and two athletes reclaiming the last place would both see room and
-- both succeed. Inside one statement, the count and the update cannot be
-- separated by another transaction's insert.
create or replace function public.reclaim_entry_slot(p_entry_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_free integer;
  v_hours integer;
begin
  select en.id, en.event_id, en.athlete_id, en.status
    into v_entry
  from public.entries en
  where en.id = p_entry_id;

  if not found then
    raise exception 'Entry not found';
  end if;

  -- SECURITY DEFINER bypasses RLS, so the ownership check that RLS would have
  -- done has to be made explicitly. Without this any signed-in user could
  -- reclaim anyone's slot by id.
  if not (
    public.is_admin()
    or exists (
      select 1 from public.athletes a
      where a.id = v_entry.athlete_id
        and (a.user_id = auth.uid() or a.parent_id = auth.uid())
    )
  ) then
    raise exception 'Not permitted to reclaim this entry';
  end if;

  -- Already holding a live slot: nothing to reclaim, and saying "true" is
  -- honest — the athlete does have their place.
  if v_entry.status = 'confirmed' then
    return true;
  end if;

  select ec.free_count into v_free from public.event_capacity(v_entry.event_id) ec;
  if coalesce(v_free, 0) <= 0 then
    return false;
  end if;

  select ms.hold_window_hours into v_hours
  from public.meet_settings ms
  join public.sessions s on s.meet_volume_id = ms.meet_volume_id
  join public.events e on e.session_id = s.id
  where e.id = v_entry.event_id;

  update public.entries
  set status = 'pending_payment',
      hold_expires_at = now() + make_interval(hours => coalesce(v_hours, 48))
  where id = p_entry_id;

  return true;
end;
$$;

comment on function public.reclaim_entry_slot(uuid) is
  'Re-acquires a hold on an expired entry if the race still has room. Returns '
  'false when it is full. Re-checks capacity server-side so two athletes '
  'cannot both reclaim the last place.';

-- ---------------------------------------------------------------------------
-- public.claim_waitlist_offer — take the slot that was offered.
-- ---------------------------------------------------------------------------
create or replace function public.claim_waitlist_offer(p_waitlist_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_free integer;
begin
  select w.id, w.event_id, w.athlete_id, w.status, w.offer_expires_at
    into v_row
  from public.event_waitlist w
  where w.id = p_waitlist_id;

  if not found then
    raise exception 'Waitlist entry not found';
  end if;

  if not (
    public.is_admin()
    or exists (
      select 1 from public.athletes a
      where a.id = v_row.athlete_id
        and (a.user_id = auth.uid() or a.parent_id = auth.uid())
    )
  ) then
    raise exception 'Not permitted to claim this offer';
  end if;

  -- An offer that has lapsed is not claimable even if the sweep has not yet
  -- marked it expired: the deadline is the deadline, and the next swimmer is
  -- entitled to the place.
  if v_row.status <> 'offered' or v_row.offer_expires_at <= now() then
    return false;
  end if;

  select ec.free_count into v_free from public.event_capacity(v_row.event_id) ec;
  if coalesce(v_free, 0) <= 0 then
    return false;
  end if;

  insert into public.entries (event_id, athlete_id, is_nt, status)
  values (v_row.event_id, v_row.athlete_id, true, 'pending_payment')
  on conflict (event_id, athlete_id) do update
    set status = 'pending_payment';

  update public.event_waitlist
  set status = 'claimed', resolved_at = now()
  where id = p_waitlist_id;

  return true;
end;
$$;

comment on function public.claim_waitlist_offer(uuid) is
  'Converts a live waitlist offer into an entry with a fresh hold. False when '
  'the offer lapsed or the race filled first.';

-- =============================================================================
-- SCHEDULED JOBS
-- =============================================================================
-- The hold sweep runs every 15 minutes: it expires lapsed holds, lapses
-- unclaimed waitlist offers, and hands freed slots to the queue — with the
-- notification each of those implies.
--
-- pg_cron rather than a host-level scheduler, because it works on any Supabase
-- plan and does not depend on where the frontend is deployed. (Vercel's Hobby
-- plan allows one cron run per DAY, which would leave a lapsed hold sitting on
-- a slot for up to 24 hours.) /api/cron/process-expired-holds calls the same
-- function, so a host scheduler can drive it instead where one is available.
--
-- Wrapped in an exception handler: pg_cron is an extension a project may not
-- have enabled, and a missing scheduler must not stop the schema from applying.
-- Capacity is computed live by event_capacity() regardless of whether this
-- sweep ever runs, so the failure mode here is delayed notifications, not
-- wrong numbers.
do $$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('ssc-sweep-expired-holds')
  where exists (
    select 1 from cron.job where jobname = 'ssc-sweep-expired-holds'
  );

  perform cron.schedule(
    'ssc-sweep-expired-holds',
    '*/15 * * * *',
    'select public.sweep_expired_holds()'
  );
exception
  when others then
    raise notice
      'pg_cron not available (%). Hold expiry will not be swept automatically; '
      'drive /api/cron/process-expired-holds from a host scheduler instead. '
      'Capacity figures remain correct either way.', sqlerrm;
end $$;
