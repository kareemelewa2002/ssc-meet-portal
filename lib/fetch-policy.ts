/**
 * Fail-loud data policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every fetcher in this app used to end in `catch { return DEMO_* }`. That
 * turned a hard backend outage into plausible-looking content: when a stale
 * RLS policy made every heats/heat_lanes read return HTTP 400, the live page
 * silently served DEMO_LIVE_EVENTS instead — so all three sessions rendered
 * the same two events, and it looked like a data-modelling bug rather than
 * an outage. Nothing logged, nothing surfaced, and a full green test run
 * still passed.
 *
 * The rule now:
 *   - success        -> data, error: null
 *   - genuinely empty-> data: [], error: null   (render an honest empty state)
 *   - failure        -> error set, ALWAYS. Demo data is only ever substituted
 *                       when NEXT_PUBLIC_ALLOW_DEMO_FALLBACK === "true", and
 *                       even then `usedFallback` marks it so the UI can say so.
 *
 * A failure must never be indistinguishable from a success.
 */

/** Opt-in only. Unset/absent in production => real failures surface as failures. */
export const DEMO_FALLBACK_ENABLED = process.env.NEXT_PUBLIC_ALLOW_DEMO_FALLBACK === "true";

export interface FetchResult<T> {
  data: T;
  /** Human-readable failure reason. `null` means the query genuinely succeeded. */
  error: string | null;
  /** True only when placeholder/demo data was substituted for real data. */
  usedFallback: boolean;
}

/** Shape of the `{ data, error }` pair every supabase-js query resolves to. */
export interface QueryLike<T> {
  data: T | null;
  error: { message: string } | null;
}

export function describeError(context: string, err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return `${context}: ${String((err as { message: unknown }).message)}`;
  }
  if (err instanceof Error) return `${context}: ${err.message}`;
  if (typeof err === "string") return `${context}: ${err}`;
  return `${context}: unknown error`;
}

export function ok<T>(data: T): FetchResult<T> {
  return { data, error: null, usedFallback: false };
}

/**
 * Records a failure. Logs unconditionally (this is the signal that was
 * missing during the outage), then returns either the demo payload — only
 * when explicitly enabled — or the caller's empty value.
 */
export function failure<T>(message: string, empty: T, demo?: T): FetchResult<T> {
  console.error(`[ssc:data] ${message}`);
  if (DEMO_FALLBACK_ENABLED && demo !== undefined) {
    console.warn("[ssc:data] serving demo fallback (NEXT_PUBLIC_ALLOW_DEMO_FALLBACK=true)");
    return { data: demo, error: message, usedFallback: true };
  }
  return { data: empty, error: message, usedFallback: false };
}

/**
 * Runs a single supabase query under the policy above. Catches both the
 * `{ error }` result shape and thrown exceptions (network/DNS), so neither
 * can slip through as a silent success.
 */
export async function runQuery<T>(
  context: string,
  run: () => Promise<QueryLike<T>>,
  opts: { empty: T; demo?: T },
): Promise<FetchResult<T>> {
  try {
    const { data, error } = await run();
    if (error) return failure(describeError(context, error), opts.empty, opts.demo);
    if (data == null) return ok(opts.empty);
    return ok(data);
  } catch (err) {
    return failure(describeError(context, err), opts.empty, opts.demo);
  }
}

/** Collapses several results into one banner message (first failure wins). */
export function firstError(...results: { error: string | null }[]): string | null {
  return results.find((r) => r.error !== null)?.error ?? null;
}
