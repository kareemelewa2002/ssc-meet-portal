# Platform Audit, Gap Analysis & Role-Based Dashboard Specification

Every claim in this report was checked against the running codebase — file
paths are cited throughout so each claim is falsifiable, not asserted. Where
a requested feature does not exist, that is stated plainly rather than
described as if it were partially there.

**Scope note, stated up front because it shapes several answers below:** this
codebase is a **meet/competition management platform** — entries, heats,
results, scoring, standings, payment — not a training-log or team-management
platform. Everything under "Workouts & Training" in the request is genuinely
absent, not because it was overlooked, but because nothing in the schema,
routes, or components addresses daily practice at all. That is the single
largest gap this audit finds, and it is called out once here rather than
repeated at every mention below.

---

## 1. Codebase Audit Summary

**Stack:** Next.js 15 App Router, TypeScript, Supabase (Postgres + Auth + RLS
+ `pg_cron`), Resend, Playwright + Vitest, deployed on Vercel. Full rationale
in `TECH_STACK_DECISIONS.md`.

**Routes** (`app/*/page.tsx`, 23 pages): auth (`/login`, `/register`),
athlete-facing (`/dashboard`, `/dashboard/teams`, `/profile`, `/athletes`,
`/athletes/[id]`, `/teams`, `/settings`, `/settings/notifications`),
meet-scoped (`/events/[volId]/{register,schedule,heats,live,results,leaderboard}`),
standings (`/meets`, `/leaderboards`, `/leaderboards/all-time`), role-specific
(`/captain`, `/referee`, `/admin`, `/admin/control-unit`, `/admin/seeding`).

**Server-side code** is minimal by design: two route handlers
(`/api/notifications/dispatch`, `/api/cron/process-expired-holds`) — see
`TECH_STACK_DECISIONS.md` §5. Everything else talks to Supabase directly from
the client, with Row Level Security as the actual enforcement boundary (same
document, §1).

**Data model** (`supabase/schema.sql`, 29 tables): meet structure
(`meet_volumes`, `sessions`, `events`), entries and results (`entries`,
`heats`, `heat_lanes`, `results`, `leaderboards`, `awards`), teams
(`teams`, `team_memberships`, `volume_team_affiliations`), relays
(`relay_squads`, `relay_legs`), Skins knockout
(`skins_qualifications`), pricing (`pricing_tiers`, `pricing_packages`,
`race_shape_templates`), capacity (`event_waitlist`), payment
(`entry_payments`, `entry_payment_items`), notifications
(`notifications`, `notification_preferences`, `email_outbox`), and identity
(`users`, `athletes`, `app_settings`). There is no table for a workout, a
practice session, an attendance record, or a biometric reading — none of
those concepts exist in the schema at all.

**Roles** (`public.user_role` enum, `supabase/schema.sql:24-29`): exactly
four — `admin`, `referee`, `athlete`, `parent`. **There is no `coach` role in
the current schema and no `captain` role either** — `coach` was retired
before this audit (its removal predates this session), and `captain` was
never a role in the RBAC sense. Team captaincy is a *relationship*:
`teams.captain_id` pointing at a user, gated by `public.can_captain_team()`
(admin, or an `athletes` row with `age_group = 'Open'`). This distinction
matters directly for §3 below — you cannot gate a dashboard on
`role === 'captain'` anywhere in this codebase, because that value can never
exist.

**Testing:** 183 RLS assertions (`supabase/tests/rls.spec.sql`, run under
genuine Postgres RLS on a scratch cluster), 55 schema-drift checks
(`scripts/verify-db.ts`), 292 Vitest unit tests, 73 Playwright E2E specs
across 11 files. This is a genuinely well-tested codebase for what it
covers — the gap is breadth of feature, not depth of testing on what exists.

---

## 2. Feature Status Matrix

Legend: ✅ Implemented · 🟡 Partial · ❌ Missing/Recommended

### Performance & Race Analytics

| Capability | Status | Evidence |
| --- | --- | --- |
| Personal bests (PBs) | ✅ | `PersonalBestView`, `lib/athletes.ts:52` — computed from results, shown on `/athletes/[id]` |
| Historical results / career ledger | ✅ | `CareerResultView`, `lib/athletes.ts:65`; rendered with `data-testid="career-ledger"` on the athlete profile |
| Time drop (seed → official) | ✅ | `timeDropSeconds()`, `lib/format.ts:165` |
| World Aquatics points, cross-event ranking | ✅ | `wa_points` on `event_results`, `lib/wa-points.ts`; the points leaderboard has no event filter by design — see `components/leaderboards/points-board.tsx` |
| All-time records / best performers | ✅ | `app/leaderboards/all-time/page.tsx`, `lib/all-time-rankings.ts` |
| Series (multi-volume) standings | ✅ | `SeriesStandingView`, `lib/athletes.ts:86` |
| **Split-time analysis** | 🟡 | `splitTimeMs` exists as a field on the result-shaping type (`lib/athletes.ts:74`) but is **hard-coded `null` everywhere it's constructed** — the schema has no lap-split table at all. The data model has a stub; nothing populates or displays it. |
| **Target time vs. actual gap tracker** | ❌ | No concept of a "target time" anywhere in schema, `lib/`, or UI. Only actual-vs-seed (time drop) exists. |
| Interactive progression charts | ❌ | No charting library is a dependency; results are rendered as tables/ledgers, not plotted over time. `lib/volumes.ts:227` explicitly notes progression is meaningless before a second volume exists — the concept is anticipated but not built. |

### Meet & Event Operations

| Capability | Status | Evidence |
| --- | --- | --- |
| Event entries, registration flow | ✅ | `app/events/[volId]/register/page.tsx`, `lib/event-registration.ts` |
| Heat/lane generation | ✅ | `lib/seeding.ts`, triggered on payment confirmation (`generate_heats_on_confirm`, `schema.sql`) |
| Live meet state / live results | ✅ | `app/events/[volId]/live/page.tsx` |
| Scoring engine | ✅ | `event_results` view with `is_ranked`, `wa_points`, DQ/NS handling; standard competition ranking (`lib/ranking.ts`) |
| Skins knockout format | ✅ | Full subsystem: `skins_qualifications`, `lib/skins-rounds.ts`, `lib/skins-lanes.ts`, `components/skins/*` |
| Relay squads | ✅ | `relay_squads`/`relay_legs`, `lib/relays.ts`, `components/captain/relay-builder.tsx` |
| Referee scoring deck | ✅ | `app/referee/page.tsx`, `components/referee/*`, mm:ss.cc input masking |
| Automated Playwright scoring suites | ✅ | `e2e/05-referee.spec.ts`, `e2e/10-skins-knockout.spec.ts` |
| Capacity / waitlist per race | ✅ | `event_waitlist`, `public.event_capacity()`, `public.offer_waitlist_slots()` — see `TECH_STACK_DECISIONS.md` §4 |
| Tiered/package pricing | ✅ | `pricing_tiers`, `pricing_packages` — see `TECH_STACK_DECISIONS.md` §3 |
| Meet publication control | ✅ | `is_public` / `status` — see `TECH_STACK_DECISIONS.md` §1 |
| **Heat sheet export (PDF/print)** | ❌ | No export/print/PDF generation anywhere in the codebase. Heat sheets are a live web table only. |
| **Automated scoring-rule configuration UI** | 🟡 | Scoring itself (ranking, DQ/NS handling, WA points) is implemented but not admin-configurable — it's fixed logic in SQL, not a settings surface. |

### Team & Roster Operations

| Capability | Status | Evidence |
| --- | --- | --- |
| Roster management | ✅ | `components/dashboard/team-roster.tsx`, join-request workflow (`team_memberships`) |
| Team creation, captain assignment | ✅ | `can_captain_team()`, `/teams` |
| Historical team affiliation (per volume) | ✅ | `volume_team_affiliations` — a swimmer's team-at-the-time survives a later transfer |
| Transfer lock during an active meet | ✅ | `enforce_team_membership_request_rules()` trigger |
| Captain dashboard | 🟡 | `app/captain/page.tsx` exists — roster view, relay builder — but has none of the roster-*health*, attendance, or broadcast features specified in §3 below |
| **Squad/sub-group organization** (training groups within a team) | ❌ | No concept below "team" — no lanes, squads, or training groups |
| **Attendance tracking** | ❌ | **Explicitly removed once already.** A meet-day "call-room" check-in existed and was deliberately torn out (`schema.sql:1900-1914`, `stamp_attendance_marked_trigger` dropped) because it duplicated a fact results already recorded — a swimmer who doesn't swim is marked NS, so a second attendance record was two sources of truth for one fact. **This is a direct design precedent for any new attendance feature** (see §4). |
| **Team announcements / communication hub** | ❌ | Notifications system (`notifications`, `email_outbox`) exists but is entirely *transactional* (payment, waitlist, join requests) — there is no captain-authored, team-wide broadcast message anywhere. |

### Workouts & Training

| Capability | Status | Evidence |
| --- | --- | --- |
| Workout builders / set structures | ❌ | No table, route, or component references a workout or a training set anywhere in the repository. |
| Interval timers | ❌ | Not present. |
| Practice attendance logging | ❌ | Not present (distinct from the removed meet-day attendance above — this would be a new concept). |
| Biometric / wellness tracking | ❌ | Not present. No health-data table of any kind exists. |

### Security & Multi-Tenancy

| Capability | Status | Evidence |
| --- | --- | --- |
| RLS on every table | ✅ | All 29 tables have RLS enabled; `TECH_STACK_DECISIONS.md` §1 |
| RLS proven, not just declared | ✅ | 183 assertions with negative controls, `npm run test:rls` |
| Role-based permissions | ✅ | `is_admin()`, `is_admin_or_referee()`, `can_captain_team()` — SQL functions, not app-level checks |
| Fine-grained content visibility (publish gate) | ✅ | `is_public`/`status` cascade, `TECH_STACK_DECISIONS.md` §1 |
| **Multi-tenancy** (multiple independent clubs/orgs on one instance) | ❌ | This is a **single-organization** platform. There is no `organization`/`club` table and no tenant column on anything — every table is scoped to one SSC installation. "Multi-tenant isolation" as a distinct concern does not apply because there is only ever one tenant. |
| **Audit logs** (who changed what, when) | ❌ | `updated_at` columns exist widely, but there is no append-only log of admin actions (role changes, payment overrides, price edits). `entry_payments.collected_by` is the closest thing — a single foreign key recording who took a payment, not a general audit trail. |

---

## 3. Architectural Separation Strategy: Team Captain Transition

### What already happened, and what has not

The premise in the brief — "the Coach role has been completely removed and
replaced by Team Captain" — is **half true against the current schema**:
`coach` is gone (confirmed: it is not in the `user_role` enum,
`schema.sql:24-29`), but **`captain` was never added as a role**, and should
not be. `/captain`, the relay builder, and the roster view all already gate
on the relationship (`teams.captain_id = auth.uid()`), not on a role value —
`app/captain/page.tsx`'s own header comment states this explicitly: *"Captaincy
is a RELATIONSHIP (`teams.captain_id`), not a role — the 'coach' role was
retired precisely because a role said someone could captain in the abstract
while the team pointer said who actually did."*

This is the correct model and should not be undone. A role-based
`captain` value would reintroduce the exact bug the `coach` retirement fixed:
someone could hold "captain" as an abstract permission while no team actually
pointed at them, or vice versa — two sources of truth for one fact. **Do not
add `'captain'` to `user_role`.**

### What genuinely needs building

The gap is not in the permission model — it's that the **captain dashboard's
feature surface stops at roster + relays**, well short of what's specified in
§B below. Concretely:

1. **No dedicated route structure is missing.** `/captain` already exists
   and is already gated correctly. New captain-only features are new
   *sections on that page* (or new sub-routes under it, e.g.
   `/captain/attendance`), not a new top-level dashboard split.
2. **RLS additions needed per new feature**, each following the existing
   pattern exactly:
   - Any new `team_announcements` table: `select using (true)` (a team's
     announcements are visible to its own members — filtered by
     `team_memberships`, not public), `insert/update/delete using (is_admin()
     or exists (select 1 from teams t where t.id = team_id and t.captain_id =
     auth.uid()))`.
   - Any new `attendance_records` table (practice, not meet-day): same
     captain-or-admin write pattern, keyed to a team and a date, with
     `is_admin() or exists (... t.captain_id = auth.uid())` on write and
     team-membership-scoped read (a swimmer sees their own record; a captain
     sees their team's).
3. **UI components that must be captain-only vs. athlete-visible:**

   | Component | Athlete sees | Captain sees |
   | --- | --- | --- |
   | Own PBs, results, entries | ✅ full | ✅ full (identical — a captain is an athlete first) |
   | Team roster | Read-only list | Read-only list **+ manage join requests, remove members** |
   | Relay builder | ❌ hidden | ✅ full |
   | Attendance (new) | Own attendance history only | Team-wide log, entry/edit controls |
   | Announcements (new) | Read-only feed | Read-only feed **+ compose/pin/delete** |
   | Roster health flags (new) | ❌ hidden | ✅ (e.g. "3 swimmers unpaid", "2 pending join requests") |

   The gating principle throughout: **every captain-only control checks
   `teams.captain_id = auth.uid()` (or `can_captain_team()` for the
   admin-equivalent case), never a role.** This is already how
   `relay-builder.tsx` and the roster modal work — new features should copy
   that exact pattern, not invent a new one.

---

## 4. Complete Dashboard Blueprints

### A. Athlete Dashboard

**Already built** (`/dashboard`, `/athletes/[id]`, `/profile`): PB showcase,
career ledger, WA points, series standing, Skins qualification widget
(`components/dashboard/skins-qualification-modal.tsx`), entry
sign-up/registration status.

**To build**, in priority order:
1. **Upcoming race schedule widget** on `/dashboard` itself — today an
   athlete's own entries are visible via the registration flow and the heat
   sheet, but there's no single "your races this meet, in order" card.
2. **Target-time gap tracker** — requires a new `target_time_ms` concept
   (simplest: a nullable column on `entries`, settable by the athlete or a
   future coach-equivalent role at registration time; the gap is then just
   `official_time_ms - target_time_ms`, computed the same way `timeDropSeconds()`
   already computes seed-vs-actual).
3. **Progression chart** — a real time-series visualization needs a charting
   library (none is currently a dependency; Recharts or a lightweight
   custom-SVG approach both fit the existing Tailwind-first, no-heavy-deps
   style of this codebase) plotting `official_time_ms` per event across
   volumes, using the same `CareerResultView` data already fetched.
4. **Wellness/biometric inputs** — out of scope until a training-log data
   model exists at all (see §1 scope note); do not bolt this onto `athletes`
   as loose columns.

### B. Team Captain Dashboard

**Already built:** roster view, join-request approve/reject, relay squad
builder — all correctly gated on `teams.captain_id`.

**Missing, mapped to the brief's exact widget list:**

| Requested widget | Build on top of |
| --- | --- |
| Personal Stats View | Nothing new — a captain is an athlete; embed the existing `/athletes/[id]` view or link to it |
| Roster & Attendance Management | Roster exists. Attendance needs a **new** table — design it as *practice* attendance, explicitly distinct from the meet-day check-in that was already tried and removed for being a duplicate record (§2). Do not let it duplicate `entries`/`results` either. |
| Workout & Training Hub | Needs the training data model this platform does not have at all (§1). This is the single largest build in the whole request — treat it as its own project, not a Control-Unit-sized feature. |
| Relay & Event Optimizer | Relay builder exists (`relay-builder.tsx`). "Team event readiness" review (e.g. "which relays are short a swimmer") is a new read-only summary over existing `relay_squads`/`relay_legs` data — small addition. |
| Team Motivation & Spirit Hub | Needs the new `team_announcements` table from §3, plus a "highlight" query over existing results (e.g. "biggest time drop this week" — computable today from `timeDropSeconds()` with no new schema). |
| Captain Action Center | "Flag roster concerns" and "broadcast alerts" both route through the *existing* notification system (`raise_notification()`, category `'team'`) — this is largely UI wiring an admin-equivalent write path for captains into a system that already exists, not new infrastructure. |

### C. Admin / Meet Director Dashboard

**Already built** (`/admin`, `/admin/control-unit`, `/admin/seeding`):
user role management (`components/admin/user-role-management.tsx`), pending
team approvals, cash payment confirmation, referee heat-card review/publish,
full Control Unit (pricing, capacity, holds, waitlist, refunds, per-event
turnaround, publish/unpublish — `TECH_STACK_DECISIONS.md` §2), heat scheduler
(`/admin/seeding`).

**Missing:**
- **RLS policy verification UI.** Today RLS correctness is verified by
  running `npm run test:rls` from a terminal — there is no in-app screen
  showing policy status. Low priority: this is a CI/developer concern, not
  something an operating admin needs mid-meet.
- **System health / test-execution dashboard.** No in-app view of Playwright
  or RLS suite results — these run in CI/local only. Buildable (a route
  reading the latest CI run's JSON artifact), but genuinely optional; most
  meet-management platforms don't surface CI status to operators, and doing
  so risks conflating "is the software healthy" with "is the meet healthy,"
  which are different audiences.
- **Heat sheet export.** Confirmed missing in §2 — the highest-value item in
  this list, since a printed/PDF heat sheet is table-stakes for a real meet
  (poolside wifi is not guaranteed).
- **Audit log.** Confirmed missing in §2.

---

## 5. Recommended Next-Gen Features & Additions

Prioritized by (impact to a real meet-day operator) ÷ (build cost against
what already exists) — the cheap, high-leverage items first.

### Immediate (small addition, real gap)

1. **Heat sheet PDF/print export.** The single highest-value missing feature
   for actual meet operation — officials and coaches need a printable sheet
   when poolside connectivity is unreliable. `@react-pdf/renderer` or a
   print-stylesheet approach both fit; no schema change needed, this is pure
   presentation over data that already exists.
2. **Team announcements table + captain compose UI.** Small, self-contained,
   reuses the entire existing notification pipeline (`raise_notification()`,
   the bell, email digest) — the infrastructure this needs already exists for
   a different purpose and mostly needs a new source table and a compose form.
3. **Progression chart on the athlete profile.** All the data
   (`CareerResultView`) is already fetched; this is a rendering addition, not
   a data-model one.
4. **Relay readiness summary for captains.** A read-only query over
   `relay_squads`/`relay_legs` ("2 of 4 legs filled") — no new tables.

### Medium (new schema, contained scope)

5. **Target time on entry**, feeding the gap tracker in §4A. One nullable
   column, one derived function mirroring `timeDropSeconds()`.
6. **Audit log table** (`admin_actions`: actor, action, target table/row,
   before/after, timestamp) with a trigger-based writer on the handful of
   admin-only tables that matter most (`pricing_packages`,
   `meet_settings`, `users.role`). Valuable for accountability once real
   money (`entry_payments`) and real access decisions (`users.role`) are
   flowing through the system, which they already are.
7. **Interactive split-time comparator.** Requires first deciding whether
   this platform ever captures lap splits at all (currently: no — see §2).
   If splits become a real requirement, this needs a `result_splits` table
   (`result_id`, `split_number`, `distance_m`, `split_time_ms`) before any UI
   is worth building — populate the stub `splitTimeMs` field properly rather
   than leaving it a permanent `null`.

### Larger (genuinely new subsystem)

8. **Training/workout data model.** This is the one item in the whole
   request that is not a gap in an existing area but a wholly new product
   surface — a workout builder, set structures, and practice attendance all
   depend on it. Recommend scoping this as its own spec-and-build cycle
   (mirroring how the Control Unit was built this session) rather than
   folding it into "captain dashboard improvements" — it's large enough to
   deserve its own schema design and its own RLS test coverage.
9. **Real public/spectator view.** Currently **every route requires
   authentication** except `/login` and `/register`
   (`middleware.ts:8`) — there is no way for an unauthenticated visitor
   (a parent without an account, a spectator at the venue) to see live
   results or a heat sheet at all. The RLS/`is_public` work already makes the
   *data* layer ready for public reads of an announced meet's schedule and
   results; the blocker is purely `middleware.ts`'s `PUBLIC_PATHS` list. This
   is a small, high-leverage unlock: add `/meets`, `/leaderboards`,
   `/events/[volId]/{schedule,results,live,leaderboard}` to the public path
   list, and the RLS `is_public` cascade already correctly restricts what an
   unauthenticated visitor can see to announced meets only. **Deliberately
   not recommending this as a new "role"** — it needs no role at all, since
   RLS's `using (true)` / `volume_is_public()` policies already work for a
   caller with no session.
10. **Timing Official / hardware integration role.** Distinct from
    `referee` (which already exists and does manual time entry) — a genuine
    timing-system integration (touchpads, an automatic timing console feed)
    would be a new ingestion path into `results`, not a new role, since the
    existing `referee` role's write permissions on `results` already cover
    it. Only worth pursuing if the meets outgrow manual watch/referee timing.

### Explicitly not recommended

- **A `parent` "future role"** — already exists (`user_role` includes
  `parent`; `components/parent/safety-acceptances.tsx` is a real, working
  parent-only surface for accepting safety waivers on a minor's behalf). No
  work needed here beyond what §4A/§4B already cover for a parent viewing
  their linked athlete's data.
- **Multi-tenancy.** Given the schema, RLS design, and every product decision
  in this codebase assumes one organization, retrofitting real multi-tenancy
  (a `club_id` on every table, re-deriving every RLS policy) would be a
  larger, riskier project than anything else in this report, and nothing in
  the current request suggests SSC needs to run other organizations' meets on
  this same instance. Flagged as a real future trigger (see below), not a
  near-term recommendation.

---

## Shift Triggers

Conditions under which a recommendation above should be revisited, per the
standing rule in `TECH_STACK_DECISIONS.md`:

- **Split times** — build the `result_splits` table the moment any meet
  actually wants to record and show them; the stub field already exists to
  make this a same-day addition once decided.
- **Multi-tenancy** — only if SSC plans to operate this platform for a
  second, independent organization. Until then, single-tenant is
  correct and simpler.
- **Training/workout subsystem** — worth building the moment captains are
  actually asked to plan practices through this platform rather than
  elsewhere; until then it is speculative scope.
- **Public spectator view** — worth the (small) middleware change the moment
  there is a real audience for it (a venue kiosk, a parent without an
  account) — the data layer is already ready.
