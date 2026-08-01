-- =============================================================================
-- Hotfix: restore PostgREST privileges for anon / authenticated / service_role
-- =============================================================================
-- Apply with:  psql "$DATABASE_URL" -f supabase/fix-api-grants.sql
--         or:  paste into Supabase Dashboard → SQL Editor → Run
--
-- Use this when REST calls fail with "permission denied for table <name>"
-- (e.g. public.teams) even though RLS policies look correct. That error means
-- the role lacks a table GRANT — Postgres never reaches RLS.
--
-- Safe to re-run. Identical to section 6d in supabase/schema.sql.
-- =============================================================================

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public
  to anon, authenticated, service_role;

grant usage, select on all sequences in schema public
  to anon, authenticated, service_role;

grant execute on all functions in schema public
  to anon, authenticated, service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables
  to anon, authenticated, service_role;

alter default privileges in schema public
  grant usage, select on sequences
  to anon, authenticated, service_role;

alter default privileges in schema public
  grant execute on functions
  to anon, authenticated, service_role;
