-- =============================================================================
-- Skins invitations move to in-person acceptance.
-- =============================================================================
-- Apply with: psql "$DATABASE_URL" -f supabase/migrations/20260810_skins_invites_in_person.sql
--         or: paste into the Supabase SQL Editor. Idempotent, and safe on a
--         live meet database — it drops one policy and touches no rows.
--
-- WHY
-- ---
-- Skins slots are now accepted or declined at the venue, not in the app. The
-- athlete-facing accept/decline card and its modal are gone from /dashboard,
-- and an admin records the outcome instead (components/admin/skins-
-- qualifiers.tsx, on the Session 3 tab of /admin/seeding).
--
-- Dropping the policy is the part that actually enforces it. RLS is what
-- PostgREST honours, so leaving the policy in place while removing the UI
-- would keep the write reachable by anyone who can issue an HTTP request —
-- hidden, not removed.
--
-- Admins and referees keep full control through
-- admins_referees_manage_skins_qualifications, and athletes keep their read
-- (athlete_view_own_skins_qualification), so a swimmer can still see whether
-- they qualified.
--
-- Withdrawal writes response = 'declined' — the same value the athlete path
-- used to write — so the existing rollover promotes the next ranked swimmer
-- with no other change.
-- =============================================================================

drop policy if exists "athlete_respond_own_skins_qualification" on public.skins_qualifications;

-- Verification: expect 0.
select count(*) as athlete_respond_policy_should_be_0
from pg_policies
where schemaname = 'public'
  and tablename = 'skins_qualifications'
  and policyname = 'athlete_respond_own_skins_qualification';
