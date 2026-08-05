# Control Unit — architecture decisions

Answers given during the discovery round on 2026-08-06. This file is the record
of *what was decided and why*, so a later reader does not have to reconstruct it
from the schema.

Nothing here is implemented yet. Statements are in the present tense because
they describe the target design.

---

## 1. Pricing

### The total

```
total = package(race_count, tier)
      + Σ surcharge(race_shape) for each individual race
      + Σ relay_swimmer_price for each relay leg
```

- **Package** — a 4×3 matrix: packages for 1, 2, 3 and 4 individual races,
  each priced at Early Bird / Standard / Late.
- **Surcharge** — per race *shape* (distance + stroke + relay flag), not per
  event row. A 400 IM costs more than a 50 Free; the surcharge is what
  expresses that. Most shapes are +0.
- **Relay** — a per-swimmer fee charged on top. A relay leg does **not** count
  toward the package race count, and relay pricing is a single flat number, not
  tiered.

### Package count is per VOLUME, not per session

An athlete's races are counted across the whole meet. Three races spread over
Sessions 1 and 2 is one 3-race package, not two packages.

This retires per-session pricing, which was the previous design. Session-level
price differentiation is gone; if Skins needs to cost more, that is expressed as
a surcharge on the relay/skins race shapes, not as a session price.

### Every price must be explained

The registration screen shows a full line-item breakdown — which race costs
what, which package applied, and why the total is the total. A single number
with no derivation is not acceptable anywhere an athlete is asked to pay.

### Tier selection

Each tier carries a start and end date and the active tier is chosen by date.
An admin can **pin** a tier, overriding the dates (for extending a deadline, or
during an outage). Both the schedule and the pin live in the Control Unit.

### Price is settled at PAYMENT time, not registration time

There is no price snapshot on the entry. The amount owed is whatever the tier
active at the moment of payment produces.

This is a deliberate choice with a consequence: an athlete who registers during
Early Bird and pays after the Standard boundary pays Standard. **The
registration screen must say so explicitly** — an athlete must never discover
this at the desk.

### Adding a race after payment

Charged at the **1-race package price** at today's tier, plus that race's own
surcharge. The original package is not recomputed.

The same number prices any race beyond the 4th, for meets where the admin has
raised the athlete event cap above 4 (the cap is admin-chosen from what the
schedule can physically absorb, so it can exceed the four packages).

---

## 2. Race capacity, holds and the waitlist

### Per-race cap

Every race carries a capacity cap, configured in the Control Unit. During
registration each race displays its own state:

| State            | Meaning                                    |
| ---------------- | ------------------------------------------ |
| Available        | comfortable headroom                       |
| Selling out soon | at or below the warning threshold          |
| Full             | no free slots                              |

The warning threshold is a Control Unit dial (default: 20% of cap remaining).

### Unpaid entries hold a slot, but the hold expires

Registering reserves a slot immediately. If payment has not been collected
within the hold window — a Control Unit dial, default 48 hours — the slot is
released.

This is the compromise between two failure modes: counting only paid entries
means an athlete can register and later be told the race is full, while holding
unpaid slots forever lets a reserve-and-never-pay pattern lock out a race.

The hold window is editable in the Control Unit.

### Expiry is swept on a schedule AND evaluated at read time

A scheduled sweep flips lapsed holds to an expired state, releases their
capacity, notifies the athlete, and offers the freed slot to the waitlist. A
discrete moment is needed for those side effects — there is no "the email got
sent" without one.

The scheduler is **`pg_cron` inside Postgres**, every 15 minutes. This works on
any Supabase plan and does not depend on where the frontend is hosted. A route
handler at `/api/cron/process-expired-holds`, secured by `CRON_SECRET`, calls the
same sweep function, so a Vercel Cron can drive it instead if the app later lands
on a plan that offers one.

**Capacity is also computed at read time**, treating any hold past
`hold_expires_at` as released whether or not the sweep has run yet. The sweep
owns the side effects; read-time evaluation owns correctness. Between two sweeps
the displayed numbers are still right, and a missed or failed sweep can never
show a race as full when it is not.

### What an expired hold does NOT do

It does not delete the entry. The entry survives in an expired state, visible to
both the athlete and the admin, and stops counting against the cap. Nothing an
athlete created disappears without a person deciding.

### Reclaiming an expired hold

`[Pay now]` on an expired hold:

1. Re-checks live capacity for that race.
2. **If a slot is free** — acquires a fresh hold and takes the athlete to
   payment.
3. **If the race is full** — shows an inline error offering the waitlist or a
   different event.

### Waitlist

A real queue, per race. When a slot frees — a hold expires, an entry is
withdrawn, or the admin raises the cap — the athlete at the head of the queue is
offered the slot and has 24 hours to claim it before the offer passes on.

**Delivery is in-app only.** There is no email provider and no notifications
table in this codebase, so the offer is surfaced when the athlete next loads the
site. The offer and its 24-hour expiry are stored and enforced regardless, so an
email channel can be added later without reworking the queue.

---

## 3. Heat turnaround

Turnaround is **per race shape**, not a flat per-session number. A 50m sprint
clears the pool far faster than a 400 IM or a relay, and session duration math
that averages them is wrong in both directions.

The previous per-session `heat_turnaround_seconds` is retired.

### Storage: a template that seeds defaults, and every event editable

Turnaround and surcharge live together in one template keyed by
(distance, stroke, relay flag). The template is not a constraint — it supplies
the **starting value** when a volume's events are created, and after that
**every single event carries its own turnaround and surcharge and every one of
them is editable**. Nothing is limited to a handful of race shapes.

The template exists because `events` rows are recreated for every volume. With no
template an admin retypes ~40 pairs of numbers per volume with nothing to catch a
missed one; with it, a new volume starts sensible and the admin changes only what
differs.

```
RACE SHAPE   TURNAROUND  SURCHARGE
50m  any         45s          +0
100m any         60s          +0
200m any         90s         +50
400m any        150s        +150
100m IM          60s         +25
relay           120s          --
```

### Session capacity math

Estimated session duration aggregates the turnaround of the *specific events
scheduled in that session*, rather than multiplying a heat count by one global
number.

---

## 4. What the Control Unit owns

**In:**

- Pricing matrix (4 packages × 3 tiers), the additional-race price, relay
  per-swimmer price
- Tier date boundaries and the manual pin
- Session windows (start/end, date) and athlete capacity per session
- Race-shape template: turnaround + surcharge, and per-event overrides
- Per-race capacity caps and the "selling out soon" threshold
- Unpaid hold window; waitlist offer window
- Athlete event cap
- Registration open/close datetime, and a late-registration toggle
- Pool lane count, and the break buffer between sessions (both feed capacity
  math — leaving them out would leave those numbers hardcoded)
- Refund / withdrawal rule

**Out, deliberately:**

- **Results display toggles.** World Aquatics points stay always-on, and DQ/NS
  stay hardcoded to the bottom of standings. These are correctness, not
  preference — an admin should not be able to configure results into being
  misleading.
- **Volume status, meet date, active volume.** These already live on
  `meet_volumes` and belong to the meet record, not to its configuration.

---

## 5. Payment

Payment remains **cash, collected at the desk**, with an admin marking it
collected. There is no payment provider integrated and none is being added here.

`[Pay now]` re-acquires the hold and presents the amount owed with desk
instructions.

The payment record is nonetheless structured so a real gateway can be introduced
later without reworking entries, holds or the waitlist.

### Who paid how much is recorded

Price is *determined* at payment time and never snapshotted at registration —
but the moment an admin marks cash collected, the amount, the tier in force, the
line-item breakdown as settled, the collecting admin and the timestamp are all
written to `entry_payments`.

Without this the meet would end with no financial record of what anyone paid,
because nothing else in the system stores a price.

---

## 6. Notifications

Every notification is written to an in-app `notifications` table and shown in a
header bell with unread state. Email is a second channel layered on top, never
the only one.

### What raises one

| Category            | Events                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| Team                | join request received (captain), request accepted/rejected (requester), member left |
| Entry & payment     | hold expiring soon, hold expired and slot released, payment recorded with amount, entry confirmed |
| Waitlist            | slot offered with the 24h deadline, offer expired and passed on, joined at position N |
| Results & schedule  | heat card published, results live for an event you swam, session times changed, heat/lane posted |

### Preferences

Critical categories — **entry & payment, and waitlist** — are mandatory and
cannot be muted. A missed hold-expiry or a missed 24-hour claim window costs the
athlete their slot, so opting out is a trap rather than a preference.

**Results & schedule** and **team** notices can be muted individually. In-app
notifications always arrive regardless; preferences govern email only.

### Delivery

- **Immediate**: waitlist offers, hold expiry, payment. These carry clocks.
- **Daily digest**: results and schedule, collected into one email.

Provider is **Resend**. Until a domain is verified it runs in test mode from
`onboarding@resend.dev`, which delivers only to the Resend account owner — the
whole pipeline is exercisable, but real athletes receive nothing until DNS is
set up. The from-address is env-driven so verifying a domain is a config change,
not a code change.

Sending needs a secret key, so it cannot happen in the browser. This introduces
the first server-side code in the repo: a route handler under `app/api/` holding
the Resend key and the Supabase service key, draining `email_outbox`.

---

## 7. Operating it

### Environment

See `.env.local.example`. The three that are new:

| Variable | Effect if unset |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Both route handlers return 500. Nothing else breaks. |
| `RESEND_API_KEY` | Notices queue in `email_outbox` and never send. The dispatcher reports this as a normal state, not an error. |
| `RESEND_FROM_EMAIL` | Sends from `onboarding@resend.dev`, which reaches only the Resend account owner. |
| `CRON_SECRET` | `/api/cron/process-expired-holds` refuses every request. `pg_cron` is unaffected. |

`lib/supabase/service.ts` imports `server-only`, so a client component that
reaches for the service key fails the build rather than shipping it to a
browser. That import is the safety mechanism — do not remove it.

### Two schedulers, one function

`pg_cron` runs `public.sweep_expired_holds()` every 15 minutes from inside
Postgres. `/api/cron/process-expired-holds` calls the same function for a
host-level scheduler. Running both is harmless: the sweep only acts on rows
whose deadline has actually passed.

### Going live with email

1. Add a domain in Resend and publish its SPF/DKIM records.
2. Set `RESEND_FROM_EMAIL` to an address on that domain.
3. Queued rows drain on the next dispatch. Nothing accumulated in the meantime
   is lost.

Until step 2, `POST /api/notifications/dispatch` returns `testMode: true` — the
messages it reports as sent went to the account owner and to nobody else.
