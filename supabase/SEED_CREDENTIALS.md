# SSC Seeded Test Credentials

> **Demo credentials only.** Every account below is created by
> `supabase/seed-demo.sql` on a disposable demo/QA database, and every one of
> them shares a single password that is committed in this repository. Never
> apply this seed to, and never use these credentials on, a real deployment.
> Demo accounts (except the admin) live on `@ssc-demo.test`, an RFC 2606
> reserved domain that can never receive real mail.

**Password for every seeded account:** `Password123!`

An on-screen version of this list (with one-tap autofill) is also available on
the `/login` page under "Seeded test credentials" — see
`components/login/seed-credentials-helper.tsx`, which mirrors this file.

If every demo login fails with a generic sign-in error, the project was likely
seeded before `auth.identities` rows were created. Run
`supabase/fix-demo-auth-identities.sql` in the Supabase SQL Editor, then retry.

## Quick logins — password `password123`

One account per role and age group, offered as one-tap buttons on `/login`.
The multi-child parent is linked to a swimmer in **all three** bands, because
the under-15 gates (parent linkage, parent-accepted safety acknowledgement)
only exist for U14 — a multi-child parent without one cannot exercise the
case their dashboard is really for.

Every demo athlete has a safety acknowledgement on file. `canSubmitEntries()`
blocks entry on a null `safety_accepted_at` for *every* age group, not just
under-15s, so without it these accounts could sign in and then be refused at
registration. Added **alongside** the `@ssc-demo.test` roster below, not in place
of it: `e2e/helpers.ts` pins those emails and several specs assert on their
exact names and counts, so replacing them would have rewritten thirteen spec
files for a convenience change.

| Role | Email | Notes |
| --- | --- | --- |
| Admin | `admin@ssc.com` | Cash desk, seeding, approvals. |
| Referee | `referee@ssc.com` | Heat cards and time entry. |
| Team captain | `captain@ssc.com` | Open age; captains a team. |
| Athlete — U14 | `athlete-u14@ssc.com` | Parent-linked, safety accepted. |
| Athlete — U14 (2nd) | `athlete-u14b@ssc.com` | The multi-child parent's U14. |
| Athlete — U17 | `athlete-u17@ssc.com` | |
| Athlete — Open | `athlete-open@ssc.com` | 18+, may found a team. |
| Parent (1 child) | `parent@ssc.com` | Linked to the U14 swimmer. |
| Parent (3 children) | `parent-multi@ssc.com` | Linked to the second U14, the U17 and the Open swimmer — one in every band. |

Birthdays are computed as an offset from the current year, not hardcoded —
age groups follow the birth-year rule, so a fixed date would drift out of its
band as years pass.

**Where each one comes from**

| Database | Script |
| --- | --- |
| Local / test | `supabase/seed-demo.sql` §5b, applied by `npm run db:reset:test` (which also prints this table). |
| Live / production | `supabase/seed-production-demo-auth.sql` — accounts only. It creates no teams, entries or heats, and never runs `seed-demo.sql`, which deletes and rebuilds meet data. |

Both create the **same set of emails**, so the `/login` panel is correct on
either.

`app_settings.superadmin_email` is deliberately **not** repointed at
`admin@ssc.com`. It names a real address, it self-bootstraps the first admin
on a fresh database, and on production it is the account that would lose admin
if it moved. The production script guarantees that account is an admin without
touching its password or any of its auth records.

## Roles and captaincy

`public.user_role` is locked to exactly **four** roles: **Admin, Referee,
Athlete, Parent**. The Referee role is fully consolidated — the same account
handles call-room attendance check-in and heat time entry (there is no separate
Usher, Entry Desk Helper, or Chief Referee).

There is no captain role, and there will not be one. **A captain is an athlete
who created the team and is 18 or over.** All three conditions live in the
database: `public.can_captain_team()` requires an `athletes` row with
`age_group = 'Open'`, and the `teams` RLS policies (`eligible_user_create_team`,
`captain_update_own_team`) both check `captain_id = auth.uid()`, so the creator
is the captain and cannot hand captaincy to anyone else. Captaincy is therefore
the relationship `teams.captain_id`, never a role — which is why the three
captain accounts below are ordinary Open-age athletes.

The `coach.<team>@ssc-demo.test` addresses these accounts used to carry are
retired along with the role. The seed renames them in place (keeping the same
user id) the first time it runs against an older database, and deletes the
leftover row if a re-run already created the new address — so no ghost logins
survive.

## Teams

| Team | Abbrev. | Approved | Captain |
|---|---|---|---|
| Riptide Swim Club | RIPT | yes | `captain.riptide@ssc-demo.test` |
| Blue Marlins | BLUM | yes | `captain.marlins@ssc-demo.test` |
| Tidal Wave | TIDE | yes | `captain.tidalwave@ssc-demo.test` |
| Sunburst Aquatics | SUNB | **no** | — (fixture for the Admin "Pending Team Approvals" queue) |

## Accounts

Every password is `Password123!`. "Entries" means entries in SSC Vol. 1, which
the seed leaves in `pending_payment` — nothing is confirmed, no heats exist, no
results are published. That is deliberate: the demo starts *before* the meet so
the approve → heats → score → publish workflow can be walked end to end.

### Staff

| Email | Password | Role | Linked athletes / captained team | Initial state |
|---|---|---|---|---|
| `elewakareem2002@gmail.com` | *(your own, if the account already existed)* | admin | — | Superadmin / Meet Director (Kareem Elewa). Looked up first by the seed and **never** overwritten — if you already have a real account at this address, sign in with your own password, not the shared one. |
| `referee1@ssc-demo.test` | `Password123!` | referee | — | Marcus Lee. The single consolidated Referee: call-room check-in *and* heat time entry for whichever heat they open. |

### Team captains — Open-age athletes who captain a team

| Email | Password | Role | Linked athletes / captained team | Initial state |
|---|---|---|---|---|
| `captain.riptide@ssc-demo.test` | `Password123!` | athlete | captains **Riptide Swim Club** | Riley Adams, 30, Open, on Riptide's roster. Safety acknowledgement accepted, no Vol. 1 entries. `can_captain_team()` is true. |
| `captain.marlins@ssc-demo.test` | `Password123!` | athlete | captains **Blue Marlins** | Jordan Kim, 32, Open, on Blue Marlins' roster. Same state as above. |
| `captain.tidalwave@ssc-demo.test` | `Password123!` | athlete | captains **Tidal Wave** | Alicia Moreno, 35, Open, on Tidal Wave's roster. Same state as above. |

### Parents

| Email | Password | Role | Linked athletes / captained team | Initial state |
|---|---|---|---|---|
| `parent1@ssc-demo.test` | `Password123!` | parent | athlete01, athlete04, athlete07, athlete10 (all U14, verified) | Dana Whitfield. The **multi-child** dashboard case. All four still need their safety acknowledgement accepted from this account. |
| `parent2@ssc-demo.test` | `Password123!` | parent | athlete02, athlete05, athlete08, athlete11 (all U14, verified) | Marcus Webb Sr. Multi-child. |
| `parent3@ssc-demo.test` | `Password123!` | parent | athlete03, athlete06, athlete09, athlete12 (all U14, verified) | Sophia Ahmed. Multi-child. |
| `parent4@ssc-demo.test` | `Password123!` | parent | athlete40 only (U14, verified) | Helena Duarte. The **single-child** case — the one-child dashboard renders differently from the four-child one and had no fixture before. |
| *(no account)* | — | — | athlete38 | `unclaimed.parent@ssc-demo.test` is athlete38's pending guardian address. It is deliberately **not** a real account, so the parent-linkage gate stays unresolved. |

### Swimmers — regular cohorts

Grouped by cohort; individually named accounts that tests or demos actually
sign in as are listed separately below. All are on a team, approved, and hold
2–4 `pending_payment` entries.

| Email range | Password | Role | Linked athletes / captained team | Initial state |
|---|---|---|---|---|
| `athlete01@ssc-demo.test` … `athlete12@ssc-demo.test` | `Password123!` | athlete | each linked to parent1/2/3 (verified), round-robin across the three teams | **U14**, ages 13–14. Safety acknowledgement deliberately **outstanding** — a U14 cannot accept for themselves; their guardian must, which is the flow worth demonstrating. |
| `athlete13@ssc-demo.test` … `athlete24@ssc-demo.test` | `Password123!` | athlete | no parent link required | **U17**, ages 15–17, round-robin across the three teams. Safety accepted at signup. athlete19 (Isabella Cruz) is additionally recorded as having swum Vol. 1 *unattached*, proving historical team display is independent of current team. |
| `athlete25@ssc-demo.test` … `athlete36@ssc-demo.test` | `Password123!` | athlete | no parent link required | **Open**, 18+, round-robin across the three teams. Safety accepted at signup. Eligible to found a team (`can_captain_team()` is true). |

### Swimmers — named fixtures

| Email | Password | Role | Linked athletes / captained team | Initial state |
|---|---|---|---|---|
| `athlete01@ssc-demo.test` | `Password123!` | athlete | child of parent1 | Ethan Ng, 14, U14, Riptide. The canonical **approved U14**: verified parent link, on a team, entered in the meet, safety acknowledgement still owed by parent1. |
| `athlete02@ssc-demo.test` | `Password123!` | athlete | child of parent2 | Marcus Webb, 14, U14, Blue Marlins. Used as the cash-payment fixture for the Admin cash-verification flow (all seeded entries start `pending_payment`). |
| `athlete13@ssc-demo.test` | `Password123!` | athlete | — | Tyler Brooks, 16, U17, Riptide. The canonical **approved U17**. |
| `athlete25@ssc-demo.test` | `Password123!` | athlete | — | Liam O'Connor, 21, Open, Riptide, 3 entries. The canonical **approved Open athlete**: registered on a team and entered in the meet. Captains nothing, so it is also the fixture for the "/captain shows the no-team gate" case. |
| `athlete37@ssc-demo.test` | `Password123!` | athlete | — | Nathan Price, 20, Open, Riptide. Historically the "unapproved swimmer" fixture. Account approval was **removed** from the platform (`athletes.approved_by_admin` is vestigial and gates nothing), so this account is not actually blocked by anything — the real pending state is its `pending_payment` entries, which an admin confirms. |
| `athlete38@ssc-demo.test` | `Password123!` | athlete | guardian **pending** (`unclaimed.parent@ssc-demo.test`) | Zoe Whitfield, 14, U14, Blue Marlins. The genuine **pending** fixture: `parent_link_status = 'pending'`, so the seed gives her no entries and no volume affiliation until a guardian claims the link. |
| `athlete39@ssc-demo.test` | `Password123!` | athlete | — | Selim Fahmy, 22, Open, **no team**. The only unattached swimmer, and therefore the only account that can exercise the join-request happy path — everyone else is blocked by the mid-meet transfer lock. |
| `athlete40@ssc-demo.test` | `Password123!` | athlete | child of parent4 (verified) | Beatriz Duarte, 13, U14, Riptide. parent4's only child — the single-child parent fixture. Safety acknowledgement outstanding, like the rest of the U14 cohort. |

## Notes

- Re-running `supabase/seed-demo.sql` is safe: every write is an idempotent
  upsert or a narrowly scoped delete-and-rebuild of demo-only rows. Vol. 1
  entries/heats/results are rebuilt on every run; real data for other volumes is
  never touched.
- `npm run db:reset:test` applies `schema.sql` and then this seed against
  `SUPABASE_DB_URL`, and refuses any URL that does not look like a local/test
  target.
