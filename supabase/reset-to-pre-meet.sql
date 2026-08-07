-- =============================================================================
-- Reset a meet volume to pre-meet configuration.
-- =============================================================================
-- Apply with: paste into the Supabase Dashboard > SQL Editor for the
-- PRODUCTION project (the one Vercel's NEXT_PUBLIC_SUPABASE_URL points at),
-- or: psql "$PRODUCTION_DATABASE_URL" -f supabase/reset-to-pre-meet.sql
--
-- I do NOT have credentials for that project and have never run this
-- script myself, on any database — it is written for YOU to review and run.
--
-- READ THIS FIRST — WHAT "RESET" MEANS HERE
-- -------------------------------------------
-- `npm run db:reset:test` (schema.sql + seed-demo.sql) is NOT a wipe — both
-- files are written to be idempotently re-runnable, which means they UPSERT
-- their own known fixtures and never delete anything they didn't create.
-- Confirmed directly: running it against a database that already had extra
-- rows (confirmed entries, generated heats, an extra registered team) left
-- every one of those rows untouched. On a fresh/disposable test database
-- that is exactly what you want. On a production database that may already
-- have REAL athletes, teams, and registrations, it does nothing useful —
-- this script is what an actual wipe requires.
--
-- SCOPE — SURGICAL BY DEFAULT
-- -----------------------------
-- Section 1 below clears MEET PROGRESS ONLY: confirmed entries roll back to
-- pending_payment, every heat/lane/result/relay-squad/skins-round is
-- deleted, every payment record is deleted. It does NOT touch teams,
-- athletes, users, pricing, or the meet_volumes/sessions/events
-- configuration itself — those are left exactly as they are, real
-- registrants and real teams included. This is "pre-meet configuration" in
-- the most literal, defensible sense: everything about WHO is registered
-- and WHAT the meet looks like stays; everything about what has HAPPENED
-- in the meet is cleared.
--
-- Section 2, separate and commented out, is the more aggressive "wipe
-- teams/athletes back to only supabase/seed-demo.sql's fixtures" — what
-- "full wipe to demo baseline" literally means. Uncomment it ONLY if you
-- specifically want every real, non-demo team/athlete/registration deleted
-- too, not just this meet's progress. On a database with any real
-- registrants, that is very likely NOT what you want — read Section 2's own
-- header before touching it.
--
-- admin_actions is never touched by either section — it is an append-only
-- audit log by design (schema.sql: no UPDATE/DELETE policy exists on it at
-- all), and a "reset" of what actually happened administratively would
-- defeat the entire point of keeping it.
-- =============================================================================

-- Step 0 — see what exists before changing anything.
select
  (select count(*) from public.entries where status = 'confirmed') as confirmed_entries,
  (select count(*) from public.heats) as heats,
  (select count(*) from public.results) as results,
  (select count(*) from public.entry_payments) as entry_payments,
  (select count(*) from public.relay_squads) as relay_squads,
  (select count(*) from public.skins_qualifications) as skins_qualifications,
  (select count(*) from public.teams) as teams,
  (select count(*) from public.athletes) as athletes;

-- =============================================================================
-- SECTION 1 — clear meet progress. Safe on a database with real registrants.
-- =============================================================================
begin;

-- Results and everything scored from them.
delete from public.leaderboards;
delete from public.results;
delete from public.skins_qualifications;
delete from public.heat_lanes;
delete from public.heats;

-- Relay squads (their legs/payments cascade via FK on delete).
delete from public.relay_squad_payments;
delete from public.relay_legs;
delete from public.relay_squads;

-- Individual-entry payments.
delete from public.entry_payment_items;
delete from public.entry_payments;

-- Every entry rolls back to pending_payment rather than being deleted —
-- the registrant's choice of events is configuration, not meet progress.
-- generate_heats_on_confirm() only fires on a transition INTO 'confirmed',
-- so this update alone does not regenerate anything.
update public.entries set status = 'pending_payment' where status <> 'pending_payment';

-- Capacity holds tied to the entries above.
delete from public.event_waitlist;

-- Team announcements and notifications are meet-cycle chatter, not
-- configuration — cleared so the next cycle starts with an empty feed.
delete from public.team_announcements;
delete from public.notifications;

-- Awards are earned FROM a completed meet's results — with the results
-- gone, any awards referencing this cycle are stale too.
delete from public.awards;

commit;

-- Step 1 result — confirm the rollback took.
select
  (select count(*) from public.entries where status = 'confirmed') as confirmed_entries_should_be_0,
  (select count(*) from public.heats) as heats_should_be_0,
  (select count(*) from public.results) as results_should_be_0,
  (select count(*) from public.entry_payments) as entry_payments_should_be_0,
  (select count(*) from public.teams) as teams_unchanged,
  (select count(*) from public.athletes) as athletes_unchanged;

-- =============================================================================
-- SECTION 2 — OPTIONAL, DESTRUCTIVE, COMMENTED OUT.
-- =============================================================================
-- Wipes teams, athletes, and their user accounts back to ONLY
-- supabase/seed-demo.sql's fixtures — every real, non-demo team and
-- registrant is permanently deleted, not just this meet's progress. The
-- admin account (whatever email is set as app_settings.superadmin_email) is
-- explicitly spared, matching seed-demo.sql's own convention of never
-- deleting/recreating it.
--
-- Do not uncomment this unless you specifically mean "throw away every real
-- registration on this project," not "reset this meet." If you only got
-- here because Section 1 didn't remove enough, re-read this file's header —
-- it almost certainly means Section 1 was actually sufficient.
--
-- begin;
--
-- delete from public.team_memberships;
-- delete from public.team_invite_links;
-- delete from public.volume_team_affiliations;
--
-- delete from public.athletes
--   where user_id not in (
--     select id from public.users where lower(email) = (select lower(superadmin_email) from public.app_settings limit 1)
--   );
--
-- delete from public.teams;
--
-- delete from public.users
--   where lower(email) <> coalesce((select lower(superadmin_email) from public.app_settings limit 1), '');
--
-- -- Re-apply supabase/seed-demo.sql after this to restore the demo fixtures.
--
-- commit;
