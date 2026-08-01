-- =============================================================================
-- Hotfix: make seeded demo accounts actually able to sign in
-- =============================================================================
-- Apply with:  paste into Supabase Dashboard → SQL Editor → Run
--
-- Symptom: every Seeded test credentials login shows
--   "Sign-in failed. Check your email and password."
-- even with Password123!. Teams/data may already exist from an earlier
-- seed-demo.sql run that inserted auth.users WITHOUT auth.identities.
-- GoTrue requires the identities row for email/password sign-in.
--
-- This script:
--   1. Backfills missing email identities for all @ssc-demo.test users
--   2. Resets those users' passwords to Password123! and confirms email
-- It does NOT touch elewakareem2002@gmail.com (keep your real admin password).
-- Safe to re-run.
-- =============================================================================

-- 1) Password + email confirmation for every demo-domain account
update auth.users
set encrypted_password = crypt('Password123!', gen_salt('bf')),
    email_confirmed_at = coalesce(email_confirmed_at, now()),
    updated_at = now(),
    confirmation_token = coalesce(confirmation_token, ''),
    recovery_token = coalesce(recovery_token, ''),
    email_change_token_new = coalesce(email_change_token_new, ''),
    email_change = coalesce(email_change, '')
where lower(email) like '%@ssc-demo.test';

-- 2) Companion identity rows GoTrue looks up on sign-in
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
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true
  ),
  'email',
  u.id::text,
  now(),
  now(),
  now()
from auth.users u
where lower(u.email) like '%@ssc-demo.test'
  and not exists (
    select 1 from auth.identities i
    where i.user_id = u.id and i.provider = 'email'
  );

-- Sanity check: should list usher1 / coaches / athletes with has_identity = true
select
  u.email,
  (u.encrypted_password is not null) as has_password,
  (u.email_confirmed_at is not null) as email_confirmed,
  exists (
    select 1 from auth.identities i
    where i.user_id = u.id and i.provider = 'email'
  ) as has_identity
from auth.users u
where lower(u.email) like '%@ssc-demo.test'
order by u.email
limit 20;
