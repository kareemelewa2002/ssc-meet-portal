# Tech Stack Decisions

Architectural decisions for the SSC meet portal, and the reasoning behind
them. This file exists so a later reader does not have to reverse-engineer
*why* something is shaped the way it is from the code alone — the code says
what happens, this says why it happens that way.

Where a decision is explained in depth by a comment already sitting next to
the code (schema.sql and the `lib/` files are heavily annotated), this file
gives the short version and points at the source rather than duplicating it.

---

## Stack

- **Next.js 15 (App Router)**, TypeScript, Tailwind v4, Base UI primitives
- **Supabase** — Postgres, Auth, Realtime, Row Level Security
- **Playwright** for end-to-end tests, **Vitest** for unit tests
- Deployed on **Vercel**

---

## Database & Authorization

### RLS is the enforcement layer, not the app

Every access rule that matters is a Postgres Row Level Security policy, not a
`if (user.role === "admin")` check in a React component. A page-level check
can be bypassed by anyone who calls the Supabase REST API directly with a
valid anon key — which is trivial, since that key ships in the browser bundle
by design. Only a database-level policy is actually enforced regardless of
which client is asking.

App-level checks still exist throughout the codebase, but they are UX, not
security: they exist to show the right screen quickly and give a clear error,
not to be the last line of defense. `supabase/tests/rls.spec.sql` is what is
actually trusted to prove a rule holds, run against a scratch Postgres cluster
under genuine RLS (`npm run test:rls`).

### is_public vs. status — two axes, not one

`meet_volumes` carries two independent columns that are easy to conflate and
must not be:

| Column | What it answers | Who changes it, and when |
| --- | --- | --- |
| `status` (`planned` / `scheduled` / `completed`) | Where the meet is in its own lifecycle | Moves forward automatically as the meet is organized — a date gets set, the meet happens |
| `is_public` (boolean, default `false`) | Whether the meet has been announced to clients | Flipped once, explicitly, by an admin — a business decision, not a lifecycle event |

**Why not one column.** Before `is_public` existed, `status = 'planned'` was
the only visibility signal, and it conflated two genuinely different
questions: *is this meet ready* and *has anyone outside the organization been
told about it*. That forced a bad tradeoff — an admin could not build out a
volume's sessions, events and pricing (which requires moving it toward
`scheduled`) without the act of doing so making it visible to the public,
because visibility and progress were the same bit.

`is_public` decouples them. A volume can be fully `scheduled` — real date,
full session schedule, priced — while `is_public` stays `false`, which is
exactly the state a meet sits in during the "not yet agreed with clients"
window. Announcing it is then a single, deliberate action (`/admin/control-unit`
→ **Publish to clients**), not a side effect of any other edit.

**The visibility rule, and why it needs both.**

```
a volume is visible to a non-admin caller
  <=>  is_public = true  AND  status <> 'planned'
```

Both conditions are required, not either. `is_public = true` alone on a
`planned` volume is deliberately insufficient: a `planned` volume has no
`meet_date` and nothing scheduled, so a "public, planned" volume would render
as a card with a name and nothing else — the exact "pure noise" problem the
`status <> 'planned'` filter was originally built to prevent (see the history
in `app/meets/page.tsx`). Requiring both means an admin cannot accidentally
publish an empty placeholder by only flipping one switch; the meet has to be
real *and* announced.

**Where the rule is enforced — once.** `public.volume_is_public(uuid)` in
`supabase/schema.sql` is the single definition:

```sql
create or replace function public.volume_is_public(p_meet_volume_id uuid)
returns boolean language sql stable as $$
  select coalesce(
    (select mv.is_public and mv.status <> 'planned'
       from public.meet_volumes mv where mv.id = p_meet_volume_id),
    false
  );
$$;
```

Every "public read" RLS policy on a volume-scoped table calls this (or the
inline two-column check, for `meet_volumes`' own policy) rather than repeating
the predicate. Six tables read through it: `meet_volumes`, `sessions`,
`events`, `meet_settings`, `pricing_packages`, `pricing_tiers`. Before this,
those tables were `for select using (true)` — fully public over the REST API
regardless of any route-level gate, which meant a "hidden" volume's schedule
and prices were one `GET /rest/v1/pricing_packages` away from anyone who knew
or guessed its id. App-level route gates (the `/events/[volId]` layout,
`/meets`, `/leaderboards`) do not re-derive this rule in TypeScript; they
query the tables normally and let RLS decide what comes back, then treat an
empty result as "not found" or "not listed." One definition, in the database,
rather than a copy in SQL and a second, driftable copy in application code —
the same anti-pattern this codebase has hit before (the retired `coach` role
sitting alongside `teams.captain_id`; heat turnaround briefly duplicated
across two tables).

**Admins bypass entirely, and this is also enforced in RLS**, not just by
hiding the toggle from non-admin UI: every policy above is
`is_admin() or volume_is_public(...)`, so an admin's own session sees every
volume — planned, unpublished, whatever state — through the exact same query
every other caller uses. There is no separate "admin view" code path to drift
out of sync with the public one.

**Known, accepted limitation.** Cascading the rule to `sessions` and `events`
protects those tables everywhere they are read, not only on the three public
routes — including the referee scoring deck. This means `is_public = false`
cannot later be used to "pause" an already-running, already-public meet
without also cutting referees off from scoring it, since they are not admins.
If that becomes a real need, it requires a distinct mechanism (a referee
bypass, or a separate "paused" state) rather than overloading `is_public` for
it — it is not something this implementation tries to solve.

**Migration safety.** `is_public` defaults to `false` for new rows, but the
migration backfills `is_public = true` for every volume that was already
visible under the old `status <> 'planned'` rule, guarded to run exactly once
(inside the same `information_schema` existence check used elsewhere in
`schema.sql` for one-time migrations). Without that backfill, shipping this
column would have silently taken every already-public, already-running meet
offline the moment the migration ran. The backfill only ever fires when the
column does not yet exist, so an admin who later deliberately unpublishes a
scheduled volume can never have that choice reverted by re-running
`schema.sql` — the file is meant to be safely re-appliable at any time.
