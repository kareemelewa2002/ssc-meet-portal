#!/usr/bin/env node
/**
 * Schema drift guard — asserts the LIVE Supabase database matches what
 * supabase/schema.sql declares.
 *
 * WHY THIS EXISTS
 * ---------------
 * A stale RLS policy referencing a retired `user_role` enum label ('usher')
 * survived on the live database long after the label was removed from
 * schema.sql. Every read of public.heats / public.heat_lanes returned
 * HTTP 400 (22P02 invalid input value for enum user_role), which the app's
 * silent demo fallbacks converted into plausible-but-fake content — three
 * sessions all rendering the same two events. Nothing failed loudly, so the
 * outage looked like a data-modelling bug and survived a fully green test
 * run. This script makes that class of drift impossible to ship past.
 *
 * DESIGN NOTE — why no pg_catalog introspection
 * ---------------------------------------------
 * PostgREST exposes no direct pg_enum/pg_policies access, and requiring a
 * service-role key would make this unrunnable in CI and on Vercel. Every
 * check below is therefore expressed through the ordinary public REST
 * surface, which turns out to detect the exact failure mode we care about:
 *
 *   - Filtering `users?role=eq.<label>` casts the literal to user_role, so a
 *     retired label returns 22P02 and an active one returns 200. That is a
 *     precise enum-membership probe.
 *   - A stale policy referencing a non-existent label fails at plan time, so
 *     ANY read of the protected table returns 22P02. The table smoke-read is
 *     therefore also the stale-policy detector — it is literally how the
 *     original outage was found.
 *
 * Run: npm run db:verify        Escape hatch: SKIP_DB_VERIFY=1
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Contract — must stay in sync with supabase/schema.sql section 1 (ENUM TYPES)
// ---------------------------------------------------------------------------

/** SCOPE LOCK: exactly these 4 roles exist. */
const APPROVED_ROLES = ["admin", "referee", "athlete", "parent"] as const;

/** Folded into the 5 above by schema.sql's migration block. Postgres enums
 * can never shrink, so these must be absent from a correctly-migrated type. */
const RETIRED_ROLES = ["usher", "entry_helper", "team_captain", "coach"] as const;

interface RpcCheck {
  name: string;
  body: Record<string, unknown>;
  /** Optional semantic assertion on the returned value. */
  expect?: { value: unknown; because: string };
}

/** SECURITY DEFINER helpers every RLS policy and trigger depends on. A
 * missing one means policies silently evaluate against nothing. */
const REQUIRED_RPCS: RpcCheck[] = [
  { name: "is_admin", body: {} },
  { name: "is_referee", body: {} },
  { name: "is_admin_or_referee", body: {} },
  { name: "can_captain_team", body: {} },
  { name: "meet_in_progress", body: {} },
  { name: "is_team_captain_of", body: { p_team_id: "00000000-0000-4000-8000-000000000000" } },
  { name: "owns_athlete", body: { p_athlete_id: "00000000-0000-4000-8000-000000000000" } },
  // Age-group semantics are business rules, not just presence checks —
  // assert the actual 2026 bucketing contract (U14 13-14 / U17 15-17 / Open 18+).
  { name: "age_group_for_age", body: { p_age: 13 }, expect: { value: "U14", because: "age 13 -> U14" } },
  { name: "age_group_for_age", body: { p_age: 14 }, expect: { value: "U14", because: "age 14 -> U14" } },
  { name: "age_group_for_age", body: { p_age: 15 }, expect: { value: "U17", because: "age 15 -> U17" } },
  { name: "age_group_for_age", body: { p_age: 17 }, expect: { value: "U17", because: "age 17 -> U17" } },
  { name: "age_group_for_age", body: { p_age: 18 }, expect: { value: "Open", because: "age 18 -> Open" } },
  // Birth-year convention: a swimmer born 2013-12-25 "turns 13" for the whole
  // 2026 season even before their birthday (exact calendar age would be 12).
  {
    name: "age_turning_this_year",
    body: { p_dob: "2013-12-25", p_on_date: "2026-08-02" },
    expect: { value: 13, because: "born 2013 -> turns 13 in 2026, pre-birthday" },
  },
];

/** Every table the public/spectator surface reads. A 400 here is the stale
 * policy signature. */
const SMOKE_TABLES = [
  "users",
  "athletes",
  "teams",
  "team_memberships",
  "meet_volumes",
  // Public read: the registration form quotes the individual race price from
  // here, so a 400 on this table takes registration down with it.
  "meet_settings",
  "sessions",
  "events",
  "entries",
  "heats",
  "heat_lanes",
  "results",
  "leaderboards",
  "relay_squads",
  "relay_legs",
] as const;

// ---------------------------------------------------------------------------
// Trigger inventory — must stay in sync with every `create trigger` in
// supabase/schema.sql.
//
// WHY: column drift and policy drift were already covered; trigger drift was
// the blind spot. A retired trigger left behind on the live database is not
// inert — enforce_athlete_approval_change_trigger silently rewrote every new
// signup back to approved_by_admin = false and made schema.sql un-rerunnable,
// while all 33 checks here passed. An unexpected trigger is therefore treated
// as a failure, not a curiosity.
// ---------------------------------------------------------------------------

interface TriggerSpec {
  schema: "public" | "auth";
  table: string;
  trigger: string;
}

/** Exactly the triggers supabase/schema.sql creates. */
const APPROVED_TRIGGERS: TriggerSpec[] = [
  { schema: "auth", table: "users", trigger: "on_auth_user_created" },
  { schema: "public", table: "athletes", trigger: "athletes_set_updated_at" },
  { schema: "public", table: "entries", trigger: "apply_historical_seed_time_trigger" },
  { schema: "public", table: "relay_legs", trigger: "validate_relay_squad_trigger" },
  { schema: "public", table: "relay_squads", trigger: "enforce_relay_status_change_trigger" },
  { schema: "public", table: "entries", trigger: "enforce_entry_status_change_trigger" },
  { schema: "public", table: "entries", trigger: "force_nt_for_switch_events_trigger" },
  { schema: "public", table: "entries", trigger: "enforce_no_direct_skins_entry_trigger" },
  { schema: "public", table: "entries", trigger: "generate_heats_on_confirm_insert" },
  { schema: "public", table: "entries", trigger: "generate_heats_on_confirm_update" },
  { schema: "public", table: "entries", trigger: "set_entry_age_group_trigger" },
  { schema: "public", table: "heats", trigger: "heats_set_updated_at" },
  { schema: "public", table: "meet_settings", trigger: "meet_settings_set_updated_at" },
  { schema: "public", table: "meet_volumes", trigger: "meet_volumes_set_updated_at" },
  { schema: "public", table: "results", trigger: "enforce_result_publish_trigger" },
  { schema: "public", table: "results", trigger: "enforce_result_scoring_trigger" },
  { schema: "public", table: "results", trigger: "recompute_heat_finish_places_trigger" },
  { schema: "public", table: "results", trigger: "results_apply_points" },
  { schema: "public", table: "results", trigger: "results_set_updated_at" },
  { schema: "public", table: "skins_qualifications", trigger: "enforce_skins_qualification_columns_trigger" },
  { schema: "public", table: "skins_qualifications", trigger: "skins_qualifications_set_updated_at" },
  { schema: "public", table: "team_memberships", trigger: "enforce_team_membership_request_rules_trigger" },
  { schema: "public", table: "team_memberships", trigger: "sync_athlete_team_on_membership_accept_trigger" },
  { schema: "public", table: "teams", trigger: "enforce_team_approval_change_trigger" },
  { schema: "public", table: "teams", trigger: "teams_set_updated_at" },
  { schema: "public", table: "users", trigger: "enforce_role_change_trigger" },
  { schema: "public", table: "users", trigger: "users_set_updated_at" },
];

/** Retired triggers, with what each one actually breaks if it survives. Any
 * unexpected trigger fails the run; these get a specific diagnosis instead of
 * the generic one. Names include the variants that appeared in cleanup
 * scripts but never actually existed, so a partial manual cleanup that
 * dropped the wrong name still gets caught. */
const LEGACY_TRIGGERS: Record<string, string> = {
  stamp_attendance_marked_trigger:
    "Call-room attendance was removed — a swimmer who does not swim is published NS on the " +
    "result, which is the single authoritative record. This trigger stamped columns that no " +
    "longer exist and would now fail every heat_lanes update.",
  enforce_athlete_approval_change_trigger:
    "Silently rewrites every self-service signup back to approved_by_admin = false " +
    "(SECURITY DEFINER does not change auth.uid(), so handle_new_auth_user is not exempt), " +
    "and raises 'Only an admin may approve or reject a swimmer registration.' when schema.sql " +
    "re-runs. Account approval no longer exists.",
  tr_enforce_athlete_approval: "Retired account-approval guard — account approval no longer exists.",
  enforce_athlete_approval_trigger: "Retired account-approval guard — account approval no longer exists.",
  enforce_athlete_approved_for_entry_trigger:
    "Blocked unapproved swimmers from INSERTing entries, so they could never reach the payment " +
    "desk that was supposed to approve them. Retired with account approval.",
};

// ---------------------------------------------------------------------------
// Env + HTTP plumbing (dependency-free: no dotenv, no supabase-js)
// ---------------------------------------------------------------------------

function loadEnvLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      out[key] = value;
    }
  } catch {
    // No .env.local (CI / Vercel) — process.env is the source of truth there.
  }
  return out;
}

interface RestResult {
  status: number;
  body: string;
  json: unknown;
}

async function rest(url: string, init: RequestInit, key: string): Promise<RestResult> {
  const res = await fetch(url, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* non-JSON body is fine — status + text is enough */
  }
  return { status: res.status, body, json };
}

function pgCode(json: unknown): string | null {
  if (json && typeof json === "object" && "code" in json) {
    return String((json as { code: unknown }).code);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

interface Failure {
  check: string;
  detail: string;
}

const LEGACY_TRIGGERS_COUNT = Object.keys(LEGACY_TRIGGERS).length;

const failures: Failure[] = [];
let passed = 0;

function pass(label: string, note = "") {
  passed += 1;
  console.log(`  [32m✓[0m ${label}${note ? `  [2m${note}[0m` : ""}`);
}

function fail(check: string, detail: string) {
  failures.push({ check, detail });
  console.log(`  [31m✗[0m ${check}\n      [31m${detail}[0m`);
}

interface LiveTrigger {
  schema_name: string;
  table_name: string;
  trigger_name: string;
}

/**
 * Compares the live trigger set against APPROVED_TRIGGERS in both directions:
 * a missing trigger means schema.sql was never fully applied, an extra one
 * means something retired survived. Both are drift.
 *
 * auth.users is asymmetric on purpose — Supabase manages its own triggers
 * there (confirmation, identity linking), so an unrecognized auth trigger is
 * not ours to flag. Only the public schema gets the unexpected-trigger sweep.
 */
async function verifyTriggers(url: string, key: string) {
  const r = await rest(`${url}/rest/v1/rpc/trigger_inventory`, { method: "POST", body: "{}" }, key);

  if (r.status === 404 || pgCode(r.json) === "PGRST202") {
    fail(
      "missing function public.trigger_inventory()",
      "the trigger inventory cannot be read, so trigger drift is UNVERIFIED — re-apply " +
        "supabase/schema.sql. This is the check that would have caught " +
        "enforce_athlete_approval_change_trigger.",
    );
    return;
  }
  if (r.status !== 200 || !Array.isArray(r.json)) {
    fail("public.trigger_inventory() errored", `HTTP ${r.status}: ${r.body.slice(0, 160)}`);
    return;
  }

  const live = r.json as LiveTrigger[];
  const liveKeys = new Set(live.map((t) => `${t.schema_name}.${t.table_name}.${t.trigger_name}`));

  // 4a. Every approved trigger is present, grouped by table so the output
  //     stays readable while a failure still names the exact trigger.
  const byTable = new Map<string, TriggerSpec[]>();
  for (const spec of APPROVED_TRIGGERS) {
    const k = `${spec.schema}.${spec.table}`;
    byTable.set(k, [...(byTable.get(k) ?? []), spec]);
  }
  for (const [table, specs] of byTable) {
    const missing = specs.filter((s) => !liveKeys.has(`${s.schema}.${s.table}.${s.trigger}`));
    if (missing.length === 0) {
      pass(`${table}`, `${specs.length} expected trigger${specs.length === 1 ? "" : "s"} present`);
    } else {
      fail(
        `${table} is missing ${missing.length} of ${specs.length} expected triggers`,
        `absent: ${missing.map((m) => m.trigger).join(", ")}\n` +
          "      re-apply supabase/schema.sql — the rule this trigger enforces is currently NOT enforced.",
      );
    }
  }

  // 4b. Nothing unapproved survives on a public table.
  const approvedPublic = new Set(
    APPROVED_TRIGGERS.filter((t) => t.schema === "public").map((t) => `${t.table}.${t.trigger}`),
  );
  const unexpected = live.filter(
    (t) => t.schema_name === "public" && !approvedPublic.has(`${t.table_name}.${t.trigger_name}`),
  );

  const legacy = unexpected.filter((t) => t.trigger_name in LEGACY_TRIGGERS);
  const unknown = unexpected.filter((t) => !(t.trigger_name in LEGACY_TRIGGERS));

  if (legacy.length === 0) {
    pass("no retired triggers survive", `${LEGACY_TRIGGERS_COUNT} known-legacy names checked`);
  } else {
    for (const t of legacy) {
      fail(
        `LEGACY TRIGGER STILL ACTIVE: ${t.table_name}.${t.trigger_name}`,
        `${LEGACY_TRIGGERS[t.trigger_name]}\n` +
          `      Drop it:  drop trigger if exists ${t.trigger_name} on public.${t.table_name};\n` +
          "      Then re-apply supabase/schema.sql, which drops the backing function too.",
      );
    }
  }

  if (unknown.length === 0) {
    pass("no unrecognized triggers on public tables", `${live.length} live triggers inspected`);
  } else {
    for (const t of unknown) {
      fail(
        `unrecognized trigger: ${t.table_name}.${t.trigger_name}`,
        "not created by supabase/schema.sql. Either it is a leftover from a hand-run migration " +
          "(drop it), or schema.sql gained a trigger without APPROVED_TRIGGERS in this file being " +
          "updated to match (add it).",
      );
    }
  }
}

async function main() {
  if (process.env.SKIP_DB_VERIFY === "1") {
    console.log("[33m⏭  SKIP_DB_VERIFY=1 — schema drift guard bypassed.[0m");
    process.exit(0);
  }

  const fileEnv = loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fileEnv.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? fileEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    // A fresh clone with no credentials cannot verify anything. That is not
    // drift, so it must not read as a drift failure — but it must be loud.
    console.log(
      "[33m⏭  NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY not set — cannot verify the live database.[0m",
    );
    console.log("[33m   Set them in .env.local (or the CI environment) to enable the drift guard.[0m");
    process.exit(0);
  }

  console.log(`\n[1mSSC schema drift guard[0m  →  ${url}\n`);

  // -- 1. user_role enum membership -----------------------------------------
  console.log("[1m1. user_role enum (scope lock: exactly 4 roles)[0m");
  for (const role of APPROVED_ROLES) {
    const r = await rest(`${url}/rest/v1/users?select=id&role=eq.${role}&limit=1`, { method: "GET" }, key);
    if (r.status === 200) {
      pass(`'${role}' is an active enum label`);
    } else {
      fail(
        `approved role '${role}' missing from user_role`,
        `expected HTTP 200, got ${r.status}: ${r.body.slice(0, 160)}`,
      );
    }
  }
  for (const role of RETIRED_ROLES) {
    const r = await rest(`${url}/rest/v1/users?select=id&role=eq.${role}&limit=1`, { method: "GET" }, key);
    if (r.status === 200) {
      fail(
        `retired role '${role}' still present in user_role`,
        "schema.sql's migration block (section 1) has not been applied to this database — " +
          "re-run supabase/schema.sql. Any RLS policy still referencing it will 400 every read of its table.",
      );
    } else if (pgCode(r.json) === "22P02") {
      pass(`'${role}' correctly retired`, "22P02 as expected");
    } else {
      fail(`inconclusive probe for retired role '${role}'`, `HTTP ${r.status}: ${r.body.slice(0, 160)}`);
    }
  }

  // -- 2. Required SECURITY DEFINER helpers ---------------------------------
  console.log("\n[1m2. Required RPC helpers (RLS + trigger dependencies)[0m");
  for (const rpc of REQUIRED_RPCS) {
    const label = rpc.expect ? `${rpc.name}(${JSON.stringify(rpc.body)})` : `${rpc.name}()`;
    const r = await rest(`${url}/rest/v1/rpc/${rpc.name}`, { method: "POST", body: JSON.stringify(rpc.body) }, key);

    if (r.status === 404 || pgCode(r.json) === "PGRST202") {
      fail(`missing function public.${rpc.name}`, `re-apply supabase/schema.sql — HTTP ${r.status}`);
      continue;
    }
    if (r.status !== 200) {
      fail(`public.${rpc.name} errored`, `HTTP ${r.status}: ${r.body.slice(0, 160)}`);
      continue;
    }
    if (rpc.expect) {
      if (r.json === rpc.expect.value) {
        pass(label, rpc.expect.because);
      } else {
        fail(
          `public.${rpc.name} returned the wrong value`,
          `${rpc.expect.because}: expected ${JSON.stringify(rpc.expect.value)}, got ${JSON.stringify(r.json)}`,
        );
      }
    } else {
      pass(label);
    }
  }

  // -- 3. Table smoke-reads (doubles as the stale-policy detector) ----------
  console.log("\n[1m3. Table smoke-reads (stale-policy detector)[0m");
  for (const table of SMOKE_TABLES) {
    const r = await rest(`${url}/rest/v1/${table}?select=id&limit=1`, { method: "GET" }, key);
    if (r.status === 200) {
      pass(`${table} readable`);
    } else if (pgCode(r.json) === "22P02") {
      fail(
        `${table} is guarded by a policy referencing a non-existent enum label`,
        `22P02 — this is the exact signature of the 'usher' outage. Inspect with:\n` +
          `        select policyname, cmd, qual from pg_policies where schemaname='public' and tablename='${table}';\n` +
          `      then re-apply supabase/schema.sql. Body: ${r.body.slice(0, 160)}`,
      );
    } else {
      fail(`${table} unreadable`, `HTTP ${r.status}: ${r.body.slice(0, 160)}`);
    }
  }

  // -- 4. Trigger inventory -------------------------------------------------
  console.log("\n[1m4. Trigger inventory (legacy/orphaned trigger detector)[0m");
  await verifyTriggers(url, key);

  // -- Summary --------------------------------------------------------------
  console.log("");
  if (failures.length === 0) {
    console.log(`[32m[1m✓ schema drift guard passed[0m  (${passed} checks)\n`);
    process.exit(0);
  }
  console.log(
    `[31m[1m✗ schema drift guard FAILED[0m  ` +
      `(${failures.length} failed, ${passed} passed)\n`,
  );
  console.log("The live database does not match supabase/schema.sql.");
  console.log("Re-apply supabase/schema.sql via the Supabase SQL editor, then re-run.\n");
  process.exit(1);
}

main().catch((err) => {
  // Network/DNS failure is NOT proof of a healthy database, so it must not
  // pass silently — that is precisely the failure mode this guard exists to
  // eliminate. Use SKIP_DB_VERIFY=1 to bypass deliberately.
  console.error(`\n[31m✗ schema drift guard could not run[0m\n  ${String(err)}\n`);
  console.error("  If the database is intentionally unreachable, re-run with SKIP_DB_VERIFY=1.\n");
  process.exit(1);
});
