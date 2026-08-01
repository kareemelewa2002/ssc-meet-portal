# SSC Seeded Test Credentials

All accounts below are created by `supabase/seed-demo.sql` and share one password.
An on-screen version of this list (with one-tap autofill) is also available on
the `/login` page under "Seeded test credentials".

**Password for every seeded account:** `Password123!`

| Role | Email |
|---|---|
| Superadmin / Meet Director | `elewakareem2002@gmail.com` |
| Chief Referee | `chief.referee@ssc-demo.test` |
| Lane Referees (1–8) | `referee1@ssc-demo.test` … `referee8@ssc-demo.test` |
| Ushers / Call Room (1–3) | `usher1@ssc-demo.test` … `usher3@ssc-demo.test` |
| Entry Desk Helpers (1–4) | `entryhelper1@ssc-demo.test` … `entryhelper4@ssc-demo.test` |
| Coaches / Captains | `coach.riptide@ssc-demo.test`, `coach.marlins@ssc-demo.test`, `coach.tidalwave@ssc-demo.test` |
| Parents (1–3) | `parent1@ssc-demo.test` … `parent3@ssc-demo.test` |
| U14 swimmers, ages 13–14 (1–12) | `athlete01@ssc-demo.test` … `athlete12@ssc-demo.test` |
| U17 swimmers, ages 15–17 (13–24) | `athlete13@ssc-demo.test` … `athlete24@ssc-demo.test` |
| Open swimmers, 18+ (25–36) | `athlete25@ssc-demo.test` … `athlete36@ssc-demo.test` |
| Unapproved swimmer (approval-gate test) | `athlete37@ssc-demo.test` |
| Pending parent-linkage swimmer (parent-gate test) | `athlete38@ssc-demo.test` |

The real admin email (`elewakareem2002@gmail.com`) is looked up first by the seed
script and never overwritten if it already exists — if you already have a real
account under that address, sign in with your own password, not the one above.
