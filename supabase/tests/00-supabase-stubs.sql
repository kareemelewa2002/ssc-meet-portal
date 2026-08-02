-- =============================================================================
-- Supabase platform stubs — ONLY for the local RLS/trigger test harness.
-- =============================================================================
-- supabase/schema.sql targets a real Supabase project, where the `auth` and
-- `storage` schemas plus the anon/authenticated/service_role roles already
-- exist. A stock Postgres instance has none of that, so this file recreates
-- the minimum surface schema.sql touches, letting the whole schema + seed be
-- applied to a throwaway database and exercised under genuine RLS.
--
-- This is NEVER applied to a real database — see scripts/run-rls-tests.sh.
-- Column sets mirror what supabase/seed-demo.sql's _seed_get_or_create_user()
-- actually inserts into auth.users / auth.identities.
-- =============================================================================

create extension if not exists pgcrypto;

create schema if not exists auth;
create schema if not exists storage;

create table if not exists auth.users (
  instance_id uuid default '00000000-0000-0000-0000-000000000000',
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  confirmation_token text default '',
  recovery_token text default '',
  email_change_token_new text default '',
  email_change text default '',
  is_super_admin boolean default false,
  phone text,
  last_sign_in_at timestamptz,
  confirmed_at timestamptz
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  provider_id text,
  provider text,
  identity_data jsonb default '{}'::jsonb,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.buckets (
  id text primary key,
  name text,
  public boolean default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);

-- GoTrue reads the JWT claims from these GUCs; the harness sets them with
-- set_config(..., is_local => true) to impersonate a signed-in user.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')::text;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
