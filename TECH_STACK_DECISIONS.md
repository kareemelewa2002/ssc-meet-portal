# Tech Stack Decisions

Architectural decisions for the SSC meet portal, and the reasoning behind
them. This file exists so a later reader does not have to reverse-engineer
*why* something is shaped the way it is from the code alone — the code says
what happens, this says why it happens that way.

Where a decision is explained in depth by a comment already sitting next to
the code (schema.sql and the `lib/` files are heavily annotated), this file
gives the short version and points at the source rather than duplicating it.

Every claim below was checked against the current codebase while writing it,
not transcribed from a spec. Where an earlier draft of this file, or a verbal
description of the system, got a detail wrong, the correction is folded in
silently — this file states what is true now, not a history of what people
thought was true.

---

## Stack

- **Next.js 15 (App Router)**, TypeScript, Tailwind v4, Base UI primitives
- **Supabase** — Postgres, Auth, Realtime, Row Level Security, `pg_cron`
- **Resend** for outbound email (`lib/email.ts`, plain HTML string templates —
  no `@react-email/components`; see §5)
- **Playwright** for end-to-end tests, **Vitest** for unit tests
- Deployed on **Vercel**

---

## 1. Database & Security Architecture

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
under genuine RLS (`npm run test:rls`) — 183 assertions as of this writing,
each a `perform ssc_test.check(...)` call, and the ones guarding a genuine
security boundary (payments, notifications, `is_public`) pair every allowed
path with a negative control that attempts the thing that must be refused.
Proving only the allowed path works proves nothing on a money or privacy
surface — a policy that accidentally allows everything passes a suite that
only checks the happy path.

### Notable SQL functions, and why logic lives in Postgres rather than TypeScript

A recurring pattern in this schema: any rule that a client needs to *quote*
(a price, an eligibility check, an ordering) is computed in SQL and read by
the client, not computed twice in two languages that can drift apart.

- **`can_captain_team()`** — `security definer`, keyed off `auth.uid()`.
  Answers *eligibility to found and captain a team* (admin, or an Open-age
  athlete), which is deliberately a different question from *does this person
  captain team X* (`is_team_captain_of()`, used by relay management).
  Conflating the two breaks team creation outright — requiring that you
  already captain a team in order to create one means nobody can ever create
  the first.
- **`category_sort_order(heat_group, gender)`** — the running order of the
  four heat buckets (U13_14 Women → U13_14 Men → U17_OPEN Women → U17_OPEN
  Men). Ordering only, never a gate on scoring — a later category is not
  blocked from swimming before an earlier one finishes, the schedule just
  presents them in this order.
- **`volume_is_public(meet_volume_id)`** — the single definition of meet
  visibility; see below.
- **`quote_athlete_entries(athlete_id, meet_volume_id)`** — the single
  definition of what an athlete owes; see §3.
- **`event_capacity(event_id)`** — the single definition of whether a race is
  full; see §4.

### `is_public` vs. `status` — two axes, not one

`meet_volumes` carries two independent columns that are easy to conflate and
must not be:

| Column | What it answers | Who changes it, and when |
| --- | --- | --- |
| `status` (`planned` / `scheduled` / `completed`) | Where the meet is in its own lifecycle | Moves forward as the meet is organized — a date gets set, the meet happens |
| `is_public` (boolean, default `false`) | Whether the meet has been announced to clients | Flipped once, explicitly, by an admin — a business decision, not a lifecycle event |

There is no fourth state and no `active` status — three values, no more.
"Live now" (shown on `/meets`) is a *derived* UI label, not a stored state:
`app/meets/page.tsx` treats the most recent `scheduled` volume as the live
one client-side. If a meet needs a real "currently running" signal in the
database later, that is a new, explicit column — not a reinterpretation of
`scheduled`.

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
`status <> 'planned'` filter was originally built to prevent. Requiring both
means an admin cannot accidentally publish an empty placeholder by only
flipping one switch; the meet has to be real *and* announced.

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
the predicate. **Six tables** read through it: `meet_volumes`, `sessions`,
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

`race_shape_templates` is deliberately **not** part of this cascade — it
carries no `meet_volume_id` at all, being the shared default table every
volume's events are seeded from rather than a volume-scoped one. Routing it
through `volume_is_public()` would make every template row vanish for every
non-admin, since there is no volume to join on.

**Admins bypass entirely, and this is also enforced in RLS**, not just by
hiding the toggle from non-admin UI: every policy above is
`is_admin() or volume_is_public(...)`, so an admin's own session sees every
volume — planned, unpublished, whatever state — through the exact same query
every other caller uses. There is no separate "admin view" code path to drift
out of sync with the public one.

**Trade-off, stated plainly.** Cascading the rule to `sessions` and `events`
protects those tables everywhere they are read, not only on the three public
routes — including the referee scoring deck, since referees are not admins.
This means `is_public = false` cannot later be used to "pause" an
already-scheduled, already-public meet without also cutting referees off from
scoring it mid-meet. Live meet operation (referees scoring, athletes entering
races already in progress) is governed by `status`, not `is_public` — a
`scheduled` volume stays fully operable for every role regardless of its
publication flag, right up until an admin unpublishes it, at which point
operation stops for non-admins too. If a genuine need arises to hide a meet
from *new* audiences while keeping it operable for people already working it,
that is a distinct mechanism (a referee-specific bypass, or a third state
disentangled from both existing columns) — not something this implementation
tries to solve by overloading `is_public`.

**Migration safety.** `is_public` defaults to `false` for new rows, but the
migration backfills `is_public = true` for every volume that was already
visible under the old `status <> 'planned'` rule, guarded to run exactly once
(inside the same `information_schema` existence check used elsewhere in
`schema.sql` for one-time migrations). Without that backfill, shipping this
column would have silently taken every already-public, already-running meet
offline the moment the migration ran. The backfill only ever fires when the
column does not yet exist, so an admin who later deliberately unpublishes a
scheduled volume can never have that choice reverted by re-running
`schema.sql` — the file is meant to be safely re-appliable at any time. On a
**fresh** database (nothing for that backfill to act on — exactly what
`npm run test:rls` and `db:reset:test` build), `seed-demo.sql` sets
`is_public` explicitly on the seeded volume rather than leaving it to the
column default, for the same reason.

---

## 2. Admin Control Unit & Event Scheduling

`/admin/control-unit` is the single screen for every configurable meet
variable — pricing, capacity, holds, the waitlist, refunds, per-race
turnaround, and now publication.

### Volume selector

The page used to auto-pick "the most recent non-`planned` volume"
(`fetchActiveVolume()`), which meant a volume still sitting at `planned` — the
normal state for a meet being built before anything is agreed — could not be
opened here at all. `fetchAllVolumes()` (RLS-scoped, so an admin session
genuinely sees every volume regardless of status or `is_public`) backs a
`<select>` at the top of the page instead. No heuristic: whichever volume the
admin picks is the one every section below edits, and it defaults to the most
recently created one only as a starting point, not a hidden constraint.

### Per-event turnaround, not a flat session number

Turnaround — the wall-clock budget for one heat, swim plus clearing the water
plus getting the next field behind the blocks — is a column on `events`
(`turnaround_seconds`), not a single number on the session or the volume. A
50m sprint clears the pool in a fraction of the time a 400m IM or a relay
does; one shared number was either too short for the slow events or wasted
time on every fast one.

`race_shape_templates` (keyed by distance + stroke + relay flag, most-specific
match wins) supplies the *starting* value when an event is created — so a
freshly seeded volume does not need forty numbers typed by hand — but every
event's value is independently editable afterward. The template constrains
nothing once an event exists; it is a default, not a cap. The same template
row also carries the event's price surcharge (see §3).

### Publish is its own action, not a field

The **Publish to clients** / **Unpublish** control writes `is_public`
immediately, on its own click, separately from the page's large **Save**
button (which persists pricing, capacity, holds, refunds and every per-event
row in one batch). This split is deliberate: an admin fixing one turnaround
number must never announce an unagreed meet to clients as a side effect of an
unrelated save. Publishing is consequential enough to warrant its own,
unambiguous control — and the confirmation toast is explicit about *why* a
click did or did not actually change what the public sees (see the `planned`
interaction in §1: publishing a still-`planned` volume flips the flag but
says outright that nothing is visible yet).

---

## 3. Tiered & Package Pricing Matrix

### Model

```
total = package(individual race count, active tier)
      + one "additional race" charge per race past the 4th
      + each entered race's own surcharge
      + one relay fee per relay leg (flat, not tiered, not counted
        toward the individual race count)
```

Computed once, in SQL, by `public.quote_athlete_entries()`, and returned as
**line items** — package, additional races, per-race surcharges, relay legs —
not a bare total. Every screen that asks an athlete for money (registration,
the cash desk) renders that same breakdown rather than recomputing a number
independently; two independently-computed totals disagreeing in front of a
paying swimmer is the failure mode this avoids.

### 3 tiers

`early_bird` / `standard` / `late`, each with a date window in
`pricing_tiers` (`meet_volume_id, tier, starts_at, ends_at`). The **active**
tier is resolved by `public.active_pricing_tier()`: whichever window contains
`now()`, or the nearest window if the calendar has not caught up yet (before
the first window: earliest tier; after the last: latest tier — a meet never
quotes Early Bird by accident once selling has closed). `meet_settings`
carries an optional `pinned_pricing_tier` that overrides the calendar
entirely, for holding a deadline open or covering an outage.

Tier boundaries are **auto-generated on seed**, anchored to the volume's
`meet_date` (roughly six weeks / one week / meet day), and are a starting
point an admin edits in the Control Unit — not a fixed schedule the system
enforces on its own.

**Price is settled at payment time, never snapshotted at registration.** An
athlete who registers during Early Bird and pays after the boundary pays
Standard. The registration form states this outright, with the current tier's
end date, rather than letting an athlete discover it at the desk.

### 4 packages, priced per tier

`pricing_packages` holds one row per `(meet_volume_id, race_count, tier)`.
`race_count` 1–4 are the four packages (bundled pricing for entering that many
individual races across the **whole volume** — not per session, since a
swimmer's races can span sessions). `race_count = 0` is not a package; it is
the **per-race price for anything beyond the 4th**, used both when an athlete
adds a race after already paying, and for every race past the 4th when an
admin raises the per-athlete event limit above four.

---

## 4. Hold Expiration & Inventory Sweeping

### Mechanism

Registering for a race takes a capacity slot immediately. An **unpaid** entry
only *holds* that slot for a configurable window
(`meet_settings.hold_window_hours`, seeded at 48 — an admin dial per volume,
not a hardcoded constant). Past that window the entry transitions to
`'hold_expired'` (the literal enum value on `entry_status`; there is no
uppercase `HOLD_EXPIRED` variant — Postgres enum labels in this schema are
lowercase throughout).

The entry is **never deleted**. A deleted entry would make a swimmer's
registration vanish with nothing to reclaim; instead it survives in the
expired state, visible to the athlete and to admins, and its slot is released
back to the event's free capacity. `[Pay now]` on an expired hold calls
`public.reclaim_entry_slot()`, which re-checks capacity **inside the same SQL
statement** (not in the browser, then a separate write — that would be a race
two athletes reclaiming the last slot could both win) and either re-acquires
a fresh hold or reports the race full, at which point the athlete is offered
the waitlist.

### Correctness does not depend on the sweep running

This is the load-bearing design choice, not a footnote: `public.event_capacity()`
computes whether a race is full by comparing every unpaid entry's
`hold_expires_at` against `now()` **live, at read time** — not by reading a
`status` column that something else has to have already updated. A race can
never read as full because a background job failed to run, and it can never
under-report capacity either.

`public.sweep_expired_holds()` is what performs the *side effects* that
capacity math does not need but people do: flipping lapsed holds to
`'hold_expired'`, lapsing unclaimed waitlist offers, and handing freed slots
to the next athlete in the queue — each with a notification. Driven by
`pg_cron` inside Postgres, every 15 minutes (`select cron.schedule('ssc-sweep-expired-holds', '*/15 * * * *', ...)`
in `schema.sql`), wrapped in an exception handler so a project without the
`pg_cron` extension enabled still applies the rest of the schema — the
tradeoff there is explicit: notifications and waitlist offers arrive late (or
not at all) without it, but nothing about *what a swimmer is charged or
whether a race is full* is ever wrong as a result.

`pg_cron` was chosen over a host-level scheduler (Vercel Cron, GitHub Actions)
specifically so this does not depend on hosting: it runs inside Postgres
itself, works on any Supabase plan, and needs nothing coordinated with
whatever platform serves the Next.js app. `/api/cron/process-expired-holds`
calls the identical `sweep_expired_holds()` function and exists purely so a
host-level scheduler *can* also drive it where one is available — running
both is harmless, since the sweep only ever acts on rows whose deadline has
genuinely passed.

---

## 5. Email & Notifications Engine

### In-app is the primary channel; email is layered on top

Every notice is written to `public.notifications` first, via the single entry
point `public.raise_notification()`, and shown in the header bell
(`components/notifications/notification-bell.tsx`, subscribed to
`postgres_changes` so a live offer appears without a reload). Email is a
**second**, optional-per-category channel queued into `public.email_outbox` by
that same function — never the only place a notice exists. `entry_payment`
and `waitlist` categories cannot have their email disabled: a `CHECK`
constraint on `notification_preferences` refuses to store that opt-out,
because those two categories carry deadlines (a released hold, an unclaimed
waitlist offer) that cost the athlete their slot if missed.

`notification_preferences` is a **relational table** —
`(user_id, category, email_enabled, updated_at)`, primary key
`(user_id, category)` — not a JSONB column on `public.users`. A typed table
gets the mandatory-category rule enforced as a real `CHECK` constraint at the
database boundary; a JSONB blob would have pushed that enforcement into
application code, which is exactly the kind of rule this codebase insists on
having the database itself refuse to violate.

### Delivery stack

**Resend**, called from `lib/email.ts` — plain HTML string templates built and
escaped by hand, **not** `@react-email/components`; that package is not a
dependency of this project. The from-address is env-driven
(`RESEND_FROM_EMAIL`) so verifying a sending domain later is a configuration
change, not a code change. Until a domain is verified, mail runs through
Resend's shared `onboarding@resend.dev` sender, which Resend delivers only to
the account owner — the whole pipeline (queue, send, mark-sent) is exercisable
in that state, but no real athlete receives anything until a domain exists.

Sending needs the Resend key and the Supabase **service-role** key, neither of
which can live in the browser — this is the first genuinely server-side code
in the app. `lib/supabase/service.ts` imports the `server-only` package
specifically so a client component that reaches for the service key fails the
*build*, rather than shipping the key to a browser. `POST /api/notifications/dispatch`
drains the outbox and is the only thing that reads it — `email_outbox` has no
RLS policy granting any signed-in user or anon access at all.

### Delivery strategy: instant vs. digest

Only two categories batch. `raise_notification()` marks a queued email
`is_digest = true` if and only if its category is `results_schedule`
(published results, heat/lane assignments, session-time changes) —
everything else (`entry_payment`, `waitlist`, `team`) sends **immediately**.
This is a hard-coded split on category, not a per-notice choice: anything
carrying a real deadline (hold expiry, payment recorded, a waitlist offer)
must not wait for a digest window, while results and schedule churn can
reasonably wait to be collected into one email rather than firing one per
event. `/api/notifications/dispatch` sends non-digest rows one at a time and
collapses a recipient's queued digest rows into a single message via
`renderDigest()`.

---

## 6. Relay Squad Payments

### One relay squad is one payable unit, billed to the captain

`public.quote_athlete_entries()` no longer includes any relay charge in a
swimmer's own quote — the `relay_legs` line item was removed outright, not
zeroed out or hidden. A relay is priced and paid **once per squad**
(`quote_relay_squad_egp(squad_id)`), owed by and paid by the team captain, not
split four ways or folded into any individual swimmer's total. This replaced
the previous model (each of the four swimmers carried a `1/4`-style relay
charge in their own quote) rather than running the two side by side, because a
squad member choosing not to swim the relay while their three teammates still
do was previously unrepresentable — a per-swimmer charge implies a per-swimmer
opt-out, which the relay-legs-in-`quote_athlete_entries()` design never
actually supported.

A squad must be **complete (4/4 legs filled)** before it is payable at all —
this is not a policy choice made in application code, it is the pre-existing
`validate_relay_squad()` deferred constraint trigger, which refuses to let any
relay squad persist with fewer than four legs regardless of payment state.
`quote_relay_squad_egp()`'s `payable` output column is therefore defensive,
not reachable in current schema: a squad that fails to reach 4/4 cannot exist
in the table to be quoted incomplete in the first place. It is kept, and
commented as such in `schema.sql`, in case that constraint is ever relaxed to
allow persisting a draft/incomplete squad — see the note on that trade-off
below.

### Payment confirmation is admin-only, matching every other cash flow

`confirm_relay_squad_payment()` checks `is_admin()` and refuses a captain
attempting to confirm their own squad's payment. This was not the first
design tried — a captain-self-service confirm was the initial approach, and it
directly conflicted with the pre-existing `enforce_relay_status_change_trigger`
on `relay_squads`, which already assumes only an admin transitions squad
status. The app has exactly one payment-confirmation pattern everywhere else
(cash is physically collected, an admin confirms it in the UI) — relay squad
payments follow the same pattern rather than becoming the one exception.
`components/admin/relay-squad-payments.tsx` is a separate table from
`<CashPayments>` on `/admin`'s cash tab (not merged into it), because the
payer differs — a relay row's payer is a captain, not the swimmer whose name
is on the entry.

### Holds, and a relay-specific capacity cap

A relay squad hold expires on the same mechanism as an individual entry hold
(`hold_expires_at`, computed at insert by
`set_relay_squad_hold_expiry_trigger`, keyed through
event → session → volume → `meet_settings.hold_window_hours` exactly like
`set_entry_hold_expiry()`), and `sweep_expired_holds()` now sweeps
`relay_squads` in the same run as individual entries — a fourth return column,
`relay_holds_expired`, was added to that function's signature for this.
A relay event additionally has its own capacity ceiling:
`relay_event_capacity(event_id)` counts `relay_squads` rows against
`events.capacity_cap`, the same column `event_capacity()` already reads for
individual events — `events.capacity_cap` existed before this work but was
never actually counted for relay events until now.

### What was explicitly not built: a persisted "incomplete squad" view

The original ask included a read-only widget showing partially-filled squads
("Relay A: 3/4 swimmers assigned"). Mid-implementation, this was found to
directly contradict `validate_relay_squad()`'s hard requirement that a squad
have exactly 4 legs to exist in the table at all — there is no persisted row
for a 3/4 squad to read and display. Raised back to the requester rather than
silently working around it (e.g. relaxing the constraint, or inventing a
parallel "draft squad" concept); the explicit decision was **leave the
constraint as-is**. `components/captain/relay-payments.tsx` therefore shows
readiness/payment status only for squads that have actually reached 4/4 and
been persisted — there is no in-progress/partial state in this UI, by design,
not by oversight.

**Shift trigger.** If a future requirement genuinely needs to show or manage
partially-built squads before they reach 4/4, that requires a schema change
(a `status = 'draft'` value that `validate_relay_squad()` is taught to skip,
or a separate staging table) — not a UI-only fix, since the data to display
does not currently exist.

---

## 7. Team Announcements

### `team_announcements`, one new notification category, broadcast not transactional

A `team_announcements` table (`team_id, author_id, title, body, pinned,
created_at, updated_at`) backs a captain-only composer on `/teams`' existing
roster dialog and a feed visible to every team member. This is the first
**broadcast** notification path in the app — `raise_notification()` and every
existing category (`entry_payment`, `waitlist`, `team`, `results_schedule`)
fire for one specific recipient reacting to one specific event; posting an
announcement fans a single INSERT out to every member of the team via
`notify_team_announcement_trigger` (`AFTER INSERT`, not `AFTER INSERT OR
UPDATE` — editing or pinning an existing announcement does not re-notify the
team, only the original post does).

`announcement` was added as its own `notification_category` enum value
(`alter type ... add value if not exists`, as a bare statement rather than
inside a `DO` block, matching the existing `hold_expired`-style idiom for this
schema — `ALTER TYPE ... ADD VALUE` cannot run inside the same transaction
that then uses the new label) rather than reusing the existing `team`
category, so a member can mute captain broadcasts independently of the other
things `team` already covers. Unlike `entry_payment` and `waitlist`,
`announcement` is not in `MANDATORY_EMAIL_CATEGORIES` — there is no deadline
attached to a broadcast message, so muting its email is a legitimate user
choice, not a risk of losing a slot.

### Read access keys off `athletes.team_id`, not `team_memberships`

Both the RLS read policy on `team_announcements` and
`notify_team_announcement()`'s recipient fan-out determine "who is on this
team" via `athletes.team_id = team_announcements.team_id`, **not**
`team_memberships`. `team_memberships` is only the one-time join-request
record (created when an athlete asks to join a team); live roster membership
lives on `athletes.team_id`, synced once on approval by
`sync_athlete_team_on_membership_accept_trigger`. Using `team_memberships` to
mean "current members" undercounts the roster — most athletes seeded with a
team have no `team_memberships` row at all if they were assigned directly.
This exact confusion has now caused a real bug twice in this codebase (the
first time predates this batch of work); anything answering "who is currently
on team X" should read `athletes.team_id`, and anything answering "did this
person ever request to join team X" reads `team_memberships`.

---

## 8. Progression Charts — no charting dependency added

`components/athletes/progression-chart.tsx` renders one hand-built inline SVG
line chart per event shape (stroke + distance) on an athlete's profile, using
`currentColor` and this app's existing brutalist border/shadow tokens rather
than a charting library's own default look. **Custom SVG was chosen over
Recharts** (the option originally suggested in the audit) because the actual
shape needed — a handful of points on one line, repeated per event, on a
profile page that already has no chart anywhere else in the app — does not
need a general-purpose charting library's API surface, and this app has zero
existing charting dependency to build on or stay consistent with. Recharts
remains the right call if this app ever needs interactive/zoomable charts,
stacked series, or charts in more than a couple of places; a second, unrelated
chart requirement appearing elsewhere is the trigger to revisit this and add
the dependency once, rather than hand-rolling a second bespoke SVG component.

The Y-axis is deliberately inverted: a swimmer's improvement is a *smaller*
time in milliseconds, and plotting that value directly would draw every good
season as a downward line. Faster times are placed higher on the chart, so
the line reads the way this app's own results tables already read — better is
up. An event shape with fewer than two results with a real `officialTimeMs`
(DQ/NS excluded) renders nothing rather than a single meaningless dot.

---

## 9. Heat Sheet Print Export

No new dependency, no PDF-generation library (`@react-pdf/renderer` was the
option the audit suggested). The seeding/heat data driving `/events/[volId]/heats`
and `/events/[volId]/live` is already fully computed client-side by the time
it renders, so the print output is that same page with a `@media print`
stylesheet — `window.print()` behind a **Print** button, not a second
server-rendered artifact that could drift from what the screen shows.

This app already had an established print-CSS convention before this work:
`[data-print-hide]` (an attribute, not Tailwind's `print:` utility class) on
any element that should vanish when printing, defined once in
`app/globals.css`'s `@media print` block and already used by
`app/admin/seeding/page.tsx`. This work applied the existing convention to
`components/events/live-client.tsx` (top nav, session tabs, and filter
controls) and `components/layout/bottom-tab-nav.tsx`, rather than introducing
Tailwind's `print:` utility as a second, parallel hide/show mechanism — the
one exception is `print:bg-white print:text-black` on `live-client.tsx`'s root
`div`, a Tailwind utility used for a *color* override (outdoor mode's
black-background/yellow-text theme), because no existing convention already
covered color overrides for this app to conform to; the global stylesheet's
own print block only forces `body`'s colors, not a component's own explicit
theme classes layered on top.

Verified against real seeded heat/lane data (not just structurally, against
an empty page) by emulating print media in a real browser: chrome (`header`,
`nav`, session tabs, filters) confirmed hidden, actual lane assignments and
seed times confirmed still present and readable in the print-rendered output.

---

## 10. Admin Audit Log

### Trigger-driven, not app-called — because there was nothing to call

`admin_actions` (append-only: `actor_id`, `action`, `target_table`,
`target_id`, `details jsonb`) is written exclusively by `AFTER` triggers, via
one shared `public.log_admin_action()`. This wasn't the first design
considered — a `log_admin_action()` called explicitly from the app's payment
and role-change code paths looked simpler at first — but a look at those
paths first (per Rule 2) found none of the three audited surfaces
(`users.role`, `entry_payments`, `pricing_packages` / `pricing_tiers`) go
through a dedicated RPC at all: `components/admin/user-role-management.tsx`
does a plain `supabase.from("users").update({ role })`, cash confirmation is
a plain `.from("entry_payments").insert(...)`, and Control Unit pricing saves
are plain `.update()` calls, every one of them gated by RLS alone, exactly
per §1's "RLS is the enforcement layer, not the app". There was no call site
to add an audit call to that wouldn't eventually be bypassed by some other
future write to the same table — a trigger is the only place that sees every
write regardless of which code path produced it, which is also why every
other cross-cutting rule in this schema (`enforce_role_change`,
`set_entry_hold_expiry`, `sync_athlete_team_on_membership_accept`) is a
trigger and not an app-level call.

### One trigger function per table, not a shared dispatcher

The first pass wrote one shared function per category (`audit_payment_insert()`
for both `entry_payments` and `relay_squad_payments`, `audit_pricing_change()`
for both `pricing_packages` and `pricing_tiers`), keyed on `tg_table_name`
inside a `case` expression. Caught by the scratch-cluster RLS suite the first
time it ran against `seed-demo.sql` (which updates `pricing_packages` during
its own seeding pass): `record "new" has no field "race_count"` — thrown
while processing a `pricing_tiers` row, which has no such column. `NEW`/`OLD`
inside a multi-table trigger function are the generic Postgres `record` type,
not a fixed row type, and every branch of a `case` expression referencing
`new.<column>` is resolved against the actual record at runtime regardless of
which branch's condition matched — a branch that is never taken still fails
if the column it names does not exist on that particular row. Fixed by
splitting into `audit_entry_payment_insert()`, `audit_relay_squad_payment_insert()`,
`audit_pricing_package_change()`, `audit_pricing_tier_change()` — five small,
single-table functions instead of two shared ones. The scratch-cluster suite
catching this before it ever reached a real database is exactly the class of
bug §6's migration-safety section describes: obvious once seen, invisible
until something actually re-runs the schema against real data.

### `SECURITY DEFINER`, with its own `is_admin()` check standing in for RLS

`log_admin_action()` is `security definer` — every other function in this
schema that reads `auth.uid()` is, for the same reason: a plain
(`security invoker`) function run from a trigger executes with the *caller's*
grants, and the `authenticated` Postgres role has no `USAGE` on the `auth`
schema, so a first attempt without this hit `permission denied for schema auth`
the moment a real (non-superuser) admin session triggered a write — caught by
the RLS suite regressing an already-passing pricing assertion (DB-31) the
moment the new trigger was added to `pricing_packages`.

`security definer` functions in this schema are owned by a superuser, which
means Postgres's row-level security is bypassed entirely for whatever the
function itself writes — the `admins_insert_admin_actions` RLS policy on
`admin_actions` is real and correct, but it is never actually consulted for
this specific insert path. `log_admin_action()` therefore re-checks
`is_admin()` itself before writing, exactly like `confirm_relay_squad_payment()`
already does for the same reason (see §6) — without that inline check, the
function would be safely un-callable from a trigger but *unsafely* callable
directly as a client RPC (PostgREST exposes every `public` schema function by
default), since a non-admin's direct `rpc("log_admin_action", …)` call would
otherwise sail straight through with no RLS check to stop it.

### Silently skipped, not logged, when there is no authenticated actor

`actor_id` is `not null`, and `log_admin_action()` returns early — writing
nothing — when `auth.uid()` is null. This is not an edge case handled
defensively; it is hit on every single application of `schema.sql` and
`seed-demo.sql`/`seed-played-meet.sql`, all of which run over a raw superuser
`psql` connection with no JWT at all. Seeding a demo admin's role or
confirming a batch of demo payments is bootstrapping test fixtures, not a
privileged action taken through the app, and without this guard every
re-application of `schema.sql` — which this project's whole schema-safety
model depends on being safely re-runnable (see §1, §6) — would manufacture
audit rows for events that never happened in the app. Verified directly (RLS
suite DB-60): a superuser write with no JWT claim still succeeds (`role =
'postgres'` bypasses RLS regardless), and produces zero new `admin_actions`
rows.

### No UPDATE or DELETE policy — append-only by omission, not by a rule that says no

`admin_actions` has RLS enabled and exactly two policies: `SELECT` (admin
only) and `INSERT` (admin only, though see above — in practice only ever hit
by a superuser-owned trigger function, whose own `is_admin()` check is what
actually gates it). There is no `UPDATE` or no `DELETE` policy at all.
Postgres RLS denies a command by default when no policy grants it for that
command, on that table, for that role — so immutability here is a *property
of what's absent*, not an explicit `USING (false)` rule that could be
mistaken for a placeholder and "completed" later. Verified (RLS suite
DB-55): an admin session attempting either an `UPDATE` or a `DELETE` against
an existing row affects zero rows, and the row is still there afterward.

### UI reads batch actor names rather than embedding

`lib/audit-log.ts` fetches `admin_actions` and separately batches
`(id, full_name, email)` for the distinct `actor_id`s in the page, the same
pattern `lib/relay-payments.ts` uses for captain names (see §6) — the
hand-maintained `Database` type in `lib/supabase/types.ts` carries no FK
relationship metadata, so a PostgREST embed (`admin_actions.select("*, users(...)")`)
fails TypeScript inference the same way every other embed in this codebase
does. `/admin/audit-logs` filters by action type, admin, and a date range
(plain `<input type="date">`, no new dependency), with an expandable row
revealing `details` as formatted JSON — built with a plain `<table>` and a
`useState`-driven expand rather than a new component, since this codebase has
no collapsible/accordion primitive to reach for yet and one table's worth of
rows did not justify adding one. The page carries no client-side `is_admin()`
redirect — consistent with every other `/admin/*` page in this app (`/admin`,
`/admin/seeding`, `/admin/control-unit`), none of which gate client-side;
RLS returning nothing to a non-admin already is the gate, and adding a
redundant client check here would be the one `/admin` page that does it
differently for no reason.

### A verification-script finding: `expect.poll()`, not a fixed sleep, for a trigger-driven side effect

The Playwright assertion that a Cash Payments confirm produces a matching
`admin_actions` row (`e2e/06-admin.spec.ts`) initially read the count once,
after a fixed `waitForTimeout(1500)`. It failed twice under a full parallel
suite run despite the underlying insert and trigger being independently
proven correct three separate ways (the RLS suite, a direct `psql`
reproduction against the persistent instance, and — on inspection after the
"failure" — the row actually present in the database with the exact expected
timestamp). The gap was never eventual consistency; Postgres commits are
immediate. It was ordinary request latency (a second, separate REST request,
racing a UI click handler, under load from 70+ other specs running at once)
exceeding a fixed budget that had no margin. Replaced with `expect.poll(...)`
polling up to 15s. The general lesson, not specific to this one test: a
side effect produced by a database trigger rather than the awaited
client call itself needs to be *polled for*, not read once after a guessed
delay — the same reasoning `login()`'s own extended timeout in
`e2e/helpers.ts` already documents for GoTrue under load.

---

## 11. Test Suite & Findings

### Baseline

| Suite | Count | Command |
| --- | --- | --- |
| RLS assertions, scratch Postgres cluster | 202 | `npm run test:rls` |
| Schema drift guard (trigger/policy/column inventory) | 59 checks | `npm run db:verify` |
| Vitest unit tests | 292 | `npm run test` |
| Playwright E2E specs | 71 | `npx playwright test` |

The RLS and Vitest numbers are exact and re-verified every time this file is
updated; treat the Playwright figure as approximate if it is read long after
this was written — specs get added.

### `CREATE OR REPLACE FUNCTION` cannot change a function's return shape

Postgres refuses `create or replace function` when the new definition's
return type or OUT-parameter shape differs from what is already installed —
it errors with `cannot change return type of existing function`, not a silent
replace. `sweep_expired_holds()` gained a fourth return column
(`relay_holds_expired`, see §6) in this batch of work, and `schema.sql`'s
existing `create or replace function public.sweep_expired_holds()` block hit
exactly this error the first time it was reapplied to a database that already
had the three-column version installed. Fixed with an explicit
`drop function if exists public.sweep_expired_holds();` immediately before
the `create or replace`. Any future change to a function's return row shape
(adding/removing/reordering OUT parameters, not just changing the body) needs
the same `drop function if exists` guard, or the same class of bug ships
silently to any database that isn't freshly created.

**Why this only surfaced late.** This codebase's fast feedback loops
(`npm run test:rls`, `check-schema.sh`) run against throwaway scratch Postgres
clusters built fresh via `initdb` for every run — `create or replace function`
never fails there, because there is nothing pre-existing to conflict with. The
bug was only caught by explicitly reapplying `schema.sql` to the
**persistent** local Supabase instance (127.0.0.1:54321/54322, the one
`npm run db:verify` and Playwright's `global-setup.ts` use, which retains
state across sessions rather than resetting per run) — the same shape of gap
that let an earlier `is_public` backfill bug through in this project's
history. Scratch-cluster-only testing is fast and correct for logic bugs, but
structurally blind to "does this schema change apply cleanly to a database
that already has the old schema" — that question can only be answered by
actually reapplying `schema.sql` to a non-fresh database, which is not
something the fast loop does on its own and has to be done deliberately when
a change touches an existing function's, table's, or trigger's shape.

### The signup-form "empty alert" finding — corrected on closer reading

An earlier investigation into a flaky Playwright checkbox interaction on the
signup form (`app/register/page.tsx`) found an unlabelled `role="alert"` node
in the accessibility snapshot and traced it to Base UI's `<Toaster />`
component (`components/ui/toast.tsx`), mounted globally in `app/layout.tsx` on
every page. That first pass concluded the node was **unconditionally**
present — which was wrong, and is corrected here rather than left standing:

Reading `ToastViewport`'s actual source (`@base-ui/react`), the `role="alert"`
element only renders when `highPriorityToasts.length > 0` — i.e., only while a
real toast is active — and even then it is styled with Base UI's
`visuallyHidden` (a genuine screen-reader-only style: `position: fixed`,
`width: 1px`, `height: 1px`, `clip-path: inset(50%)`). `position: fixed`
removes it from normal document flow entirely, so it cannot shift sibling
layout regardless of when it mounts or how large its notional box is — that
part of the original "harmless" conclusion holds. What does not hold is "it is
always there and therefore irrelevant": if the empty-alert symptom resurfaces
in a Playwright accessibility snapshot, the correct next step is identifying
**which toast fired** during that flow (an earlier `toast.success()` /
`toast.error()` call in the same test, not yet auto-dismissed) rather than
assuming the region is a constant, inert fixture of every page.

Separately, and independently of the above: `app/register/page.tsx`'s own two
`<Alert>` elements are both already correctly conditional
(`{error && <Alert>...}` and `{needsParentEmail && <Alert>...}`). There is
nothing to fix in the signup form itself.

---

## Permanent Operational Standing Rules

These are not architectural notes — they are binding process rules for every
future session working in this repository, regardless of who or what is
doing the work.

### Rule 1 — Stack documentation is updated as part of the change, not after

Whenever a new technical component, database extension, schema modification,
or third-party API/service is introduced or materially changed, this file
**must** be updated in the same body of work — not deferred, not left as a
follow-up. The update must record:

1. **The choice** — what was adopted, in concrete terms (package name,
   Postgres extension, table/column, service).
2. **Alternatives considered**, if any were seriously weighed, and why they
   were not chosen.
3. **Rationale** — why this choice, specifically, for this problem.
4. **Shift triggers** — the conditions under which this decision should be
   revisited (a scale threshold, a hosting change, a requirement this design
   does not cover).

A decision undocumented at the moment it is made tends to never get
documented at all, and this file's entire value is in being current.

### Rule 2 — Discovery and clarifying questions before code, on multi-part or architectural work

Before writing any code or modifying a database schema for a task that is
**multi-part, broad in scope, or architectural** in nature, all necessary
clarifying questions must be asked first, and implementation may only begin
after explicit answers are received. This does not apply to a small, clearly
scoped fix (a single bug, a copy change, a one-file edit) — it applies when a
request could reasonably be implemented multiple different, materially
different ways, or touches how the system is shaped rather than what one
screen or one function does.
