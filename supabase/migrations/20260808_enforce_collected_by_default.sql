-- =============================================================================
-- Harden payment audit attribution: collected_by is now server-derived.
-- =============================================================================
-- Apply with: psql "$DATABASE_URL" -f supabase/migrations/20260808_enforce_collected_by_default.sql
--         or: paste into the Supabase SQL Editor.
--
-- Safe to run on a LIVE meet database. It touches no existing payment row —
-- only the default, a trigger, and one function signature. Idempotent.
--
-- WHY
-- ---
-- public.entry_payments.collected_by and public.relay_squad_payments
-- .collected_by are the "who took the money" record on the cash desk. Both
-- were written from a value the CLIENT supplied: lib/admin-cash-payments.ts
-- inserted collected_by straight from the browser, and
-- confirm_relay_squad_payment() took it as a parameter. Neither column had a
-- default, and no trigger checked it, so an authenticated admin could record
-- any user id as the collector — including another admin's.
--
-- Worth being precise about the blast radius, because it is smaller than it
-- sounds: public.admin_actions ALREADY records the true actor for both of
-- these inserts (audit_entry_payment_insert / audit_relay_squad_payment_insert
-- both call log_admin_action(), which writes actor_id := auth.uid() and is
-- append-only by design). The tamper-proof audit trail was never the thing at
-- risk. collected_by is the denormalized, human-readable copy that the cash
-- desk and the payment-status screens actually display — so the two could
-- disagree, and the one people READ was the forgeable one.
--
-- WHAT THIS DOES
-- --------------
--   1. DEFAULT auth.uid() on both columns, so an insert that simply omits the
--      column records the real collector rather than NULL.
--   2. A BEFORE INSERT trigger that OVERRIDES collected_by with auth.uid()
--      whenever there IS an authenticated session. A default alone cannot do
--      this — a default only applies when the column is omitted, and the whole
--      problem was a caller supplying the wrong value explicitly.
--   3. Drops p_collected_by from confirm_relay_squad_payment(). The parameter
--      is not merely redundant after (2), it is actively misleading: it would
--      accept an id and silently ignore it. Callers are updated in
--      lib/relay-payments.ts in the same change.
--
-- NOT UNCONDITIONAL, DELIBERATELY
-- -------------------------------
-- The trigger overrides only when auth.uid() is not null. A psql session, a
-- service-role backfill, or an ops script has no auth.uid(), and forcing the
-- column there would silently write NULL over an attribution the operator
-- passed on purpose. Those paths are already outside RLS entirely — anyone
-- who can reach them can write any row they like, so refusing them here would
-- buy no security and would break legitimate seeding. The case this closes is
-- the one that matters: an authenticated client asserting someone else's id.
-- =============================================================================

begin;

-- 1. Defaults -----------------------------------------------------------------
-- Via a SECURITY DEFINER wrapper rather than a bare `default auth.uid()`: a
-- column default is evaluated as the INSERTING role, which is not guaranteed
-- USAGE on schema auth. (RLS policies call auth.uid() directly and are fine
-- because policy expressions are evaluated as the table owner — defaults and
-- SECURITY INVOKER triggers are not.)
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

alter table public.entry_payments
  alter column collected_by set default public.current_collector();

alter table public.relay_squad_payments
  alter column collected_by set default public.current_collector();

-- 2. Override trigger ---------------------------------------------------------
-- One function for both tables: the rule is identical and genuinely shared,
-- unlike the audit triggers above it in schema.sql, which each report a
-- different payload and so are deliberately kept separate.
create or replace function public.enforce_collected_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := public.current_collector();
begin
  -- Authenticated request: the session is the authority on who collected,
  -- never the payload. Overrides rather than fills, so an explicit wrong id
  -- is corrected instead of trusted.
  if v_actor is not null then
    new.collected_by := v_actor;
  end if;
  -- No session (psql / service role): whatever the operator supplied stands,
  -- including NULL. See the header for why this is not tightened further.
  return new;
end;
$$;

comment on function public.enforce_collected_by() is
  'BEFORE INSERT on the payment tables: forces collected_by to auth.uid() for '
  'any authenticated request, so the displayed collector cannot disagree with '
  'the admin_actions audit row. No-op when there is no session (seeds, ops).';

create or replace trigger enforce_entry_payment_collected_by
  before insert on public.entry_payments
  for each row execute function public.enforce_collected_by();

create or replace trigger enforce_relay_squad_payment_collected_by
  before insert on public.relay_squad_payments
  for each row execute function public.enforce_collected_by();

-- 3. confirm_relay_squad_payment loses p_collected_by --------------------------
-- Dropped by full signature: Postgres treats the 3-arg and 2-arg forms as
-- different functions, so without this the old one lingers and PostgREST can
-- still resolve a call that supplies p_collected_by.
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

  -- collected_by is deliberately absent from the column list: the default and
  -- the BEFORE INSERT trigger above both resolve it to auth.uid(). Note this
  -- function is SECURITY DEFINER and so runs as the owner with RLS bypassed —
  -- auth.uid() still reads the request's JWT claim, which is exactly why the
  -- rule had to live in a trigger rather than in an insert policy's WITH CHECK.
  insert into public.relay_squad_payments (squad_id, amount_egp, note)
  values (p_squad_id, v_quote.amount_egp, p_note);

  update public.relay_squads set status = 'confirmed' where id = p_squad_id;

  return p_squad_id;
end;
$$;

commit;

-- Verification ----------------------------------------------------------------
select
  (select count(*) from pg_trigger
    where tgname in ('enforce_entry_payment_collected_by',
                     'enforce_relay_squad_payment_collected_by')) as triggers_should_be_2,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'confirm_relay_squad_payment') as relay_fn_should_be_1;
