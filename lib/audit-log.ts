import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import type { AdminActionRow } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// Admin audit log — read-only from the application's point of view. Every row
// here is written by a database trigger (see log_admin_action() in
// schema.sql), never by this file; there is no create/update/delete function
// below because none exists on the server either — the RLS policy on
// admin_actions has no UPDATE or DELETE grant at all, for anyone.
// ---------------------------------------------------------------------------

export interface AdminAction {
  id: string;
  createdAt: string;
  actorId: string;
  actorName: string;
  actorEmail: string;
  action: string;
  targetTable: string;
  targetId: string | null;
  details: Record<string, unknown>;
}

export interface AdminActionFilters {
  /** Exact match on the action label, e.g. "ROLE_CHANGE". Omit for all. */
  action?: string;
  actorId?: string;
  /** Inclusive lower bound, ISO timestamp. */
  createdFrom?: string;
  /** Inclusive upper bound, ISO timestamp. */
  createdTo?: string;
  limit?: number;
}

const DEFAULT_LIMIT = 200;

function toAdminAction(row: AdminActionRow, actorNames: Map<string, { name: string; email: string }>): AdminAction {
  const actor = actorNames.get(row.actor_id);
  return {
    id: row.id,
    createdAt: row.created_at,
    actorId: row.actor_id,
    actorName: actor?.name ?? "Unknown admin",
    actorEmail: actor?.email ?? "",
    action: row.action,
    targetTable: row.target_table,
    targetId: row.target_id,
    details: row.details ?? {},
  };
}

/** The audit log table, filtered and paginated for the admin UI. Newest
 * first — an audit trail is read backwards, from "what just happened". */
export async function fetchAdminActions(
  filters: AdminActionFilters = {},
): Promise<FetchResult<AdminAction[]>> {
  const result = await runQuery<AdminActionRow[]>(
    "Loading the admin audit log",
    async () => {
      const supabase = createClient();
      let query = supabase
        .from("admin_actions")
        .select("id, created_at, actor_id, action, target_table, target_id, details")
        .order("created_at", { ascending: false })
        .limit(filters.limit ?? DEFAULT_LIMIT);

      if (filters.action) query = query.eq("action", filters.action);
      if (filters.actorId) query = query.eq("actor_id", filters.actorId);
      if (filters.createdFrom) query = query.gte("created_at", filters.createdFrom);
      if (filters.createdTo) query = query.lte("created_at", filters.createdTo);

      const { data, error } = await query;
      return { data, error };
    },
    { empty: [] },
  );

  if (result.error) return { ...result, data: [] };

  // Batched, not embedded: admin_actions -> users has no declared FK
  // relationship in the hand-maintained Database type, so a PostgREST embed
  // would fail type inference the same way relay_squads' embeds do (see
  // lib/relay-payments.ts) — and here it would ALSO need to survive an actor
  // who no longer exists, so a plain lookup map is the simpler fix either way.
  const actorIds = [...new Set(result.data.map((r) => r.actor_id))];
  const actorNames = new Map<string, { name: string; email: string }>();
  if (actorIds.length > 0) {
    const supabase = createClient();
    const { data } = await supabase.from("users").select("id, full_name, email").in("id", actorIds);
    (data ?? []).forEach((u) => actorNames.set(u.id, { name: u.full_name, email: u.email }));
  }

  return { ...result, data: result.data.map((row) => toAdminAction(row, actorNames)) };
}

/** Distinct action labels actually present in the log, for the filter
 * dropdown — not a hardcoded list, since new categories get added over time
 * (see TECH_STACK_DECISIONS.md) and a stale hardcoded list would silently
 * exclude a real one from the filter. */
export async function fetchAdminActionTypes(): Promise<string[]> {
  const supabase = createClient();
  const { data } = await supabase.from("admin_actions").select("action").order("action");
  return [...new Set((data ?? []).map((r) => r.action as string))];
}

/** Admins who have at least one row in the log, for the actor filter. Not
 * "every admin" — an admin who has never taken a logged action would be a
 * dead filter option that always returns zero rows. */
export async function fetchAdminActionActors(): Promise<{ id: string; name: string }[]> {
  const supabase = createClient();
  const { data } = await supabase.from("admin_actions").select("actor_id");
  const ids = [...new Set((data ?? []).map((r) => r.actor_id as string))];
  if (ids.length === 0) return [];
  const { data: users } = await supabase.from("users").select("id, full_name").in("id", ids);
  return (users ?? []).map((u) => ({ id: u.id, name: u.full_name }));
}
