#!/usr/bin/env bash
# =============================================================================
# L2 RLS & trigger suite runner.
# =============================================================================
# Provisions a throwaway PostgreSQL cluster, applies the Supabase stubs +
# supabase/schema.sql + supabase/seed-demo.sql, then runs
# supabase/tests/rls.spec.sql under genuine row-level security.
#
# A scratch cluster (rather than the live project) is deliberate: the suite
# mutates volume status, memberships, rosters and results, and asserts on
# exact seeded fixtures. It must never touch a real database, and it must be
# reproducible from nothing on any machine with Postgres client tools.
#
# Run: npm run test:rls
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${RLS_TEST_PORT:-5599}"
# Unix sockets are capped near 100 chars, so keep the socket dir short.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ssc-rls.XXXXXX")"
PGDIR="$WORKDIR/pgdata"
LOG="$WORKDIR/postgres.log"

cleanup() {
  if [ -d "$PGDIR" ]; then
    pg_ctl -D "$PGDIR" -o "-p $PORT -k $WORKDIR" stop -m immediate >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

for bin in initdb pg_ctl psql; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "✗ '$bin' not found on PATH."
    echo "  The RLS suite needs PostgreSQL client tools (e.g. brew install postgresql@14)."
    exit 1
  fi
done

echo "Provisioning scratch PostgreSQL (port $PORT)…"
initdb -D "$PGDIR" -U postgres -A trust >"$WORKDIR/initdb.log" 2>&1
pg_ctl -D "$PGDIR" -o "-p $PORT -k $WORKDIR" -l "$LOG" start >/dev/null

# pg_ctl returns before the socket is always accepting connections.
for _ in $(seq 1 30); do
  psql -h "$WORKDIR" -p "$PORT" -U postgres -c 'select 1' >/dev/null 2>&1 && break
  sleep 0.5
done

PSQL="psql -h $WORKDIR -p $PORT -U postgres -v ON_ERROR_STOP=1 --quiet"

echo "Applying Supabase stubs…"
$PSQL -f "$ROOT/supabase/tests/00-supabase-stubs.sql" >"$WORKDIR/stubs.log" 2>&1

echo "Applying schema.sql…"
$PSQL -f "$ROOT/supabase/schema.sql" >"$WORKDIR/schema.log" 2>&1

echo "Applying seed-demo.sql…"
$PSQL -f "$ROOT/supabase/seed-demo.sql" >"$WORKDIR/seed.log" 2>&1

# Mirrors Supabase's grants: PostgREST reaches tables as anon/authenticated,
# so RLS is the only thing standing between a request and the data.
$PSQL -c "grant usage on schema public to anon, authenticated;
          grant select, insert, update, delete on all tables in schema public to anon, authenticated;
          grant usage, select on all sequences in schema public to anon, authenticated;" >/dev/null

echo "Running rls.spec.sql…"
echo ""
# ON_ERROR_STOP=1 is what makes the suite's closing RAISE produce a non-zero
# exit code. With it set to 0, psql prints the failure and still exits 0 — the
# runner would report success over a failing suite.
set +e
psql -h "$WORKDIR" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls.spec.sql"
STATUS=$?
set -e

echo ""
if [ $STATUS -eq 0 ]; then
  echo "✓ RLS suite passed"
else
  echo "✗ RLS suite failed (see FAIL rows above)"
fi
exit $STATUS
