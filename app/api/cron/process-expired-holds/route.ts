import { NextResponse, type NextRequest } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Runs the hold sweep: expires lapsed holds, lapses unclaimed waitlist offers,
 * and hands freed places to the queue — with the notification each implies.
 *
 * THIS IS A SECOND DOOR, NOT THE ONLY ONE. pg_cron already calls
 * public.sweep_expired_holds() every 15 minutes from inside Postgres, which
 * works on any Supabase plan and does not care where the frontend is deployed.
 * This handler exists so a host-level scheduler (Vercel Cron, GitHub Actions,
 * an external pinger) can drive the same function where one is available.
 *
 * Running both is harmless: the sweep only acts on rows whose deadline has
 * genuinely passed, so a second run minutes later finds nothing to do.
 *
 * Capacity does NOT depend on this. public.event_capacity() compares
 * hold_expires_at against now() directly, so a sweep that never runs delays
 * notifications and never makes a race read as full when it is not.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Rejects anything without the shared secret.
 *
 * The endpoint mutates entries and sends email, so leaving it open would let
 * anyone on the internet drive both. When CRON_SECRET is unset the route
 * refuses everything rather than defaulting to open — an unauthenticated
 * mutation endpoint that appears to work is worse than one that plainly does
 * not.
 */
function isAuthorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}

async function runSweep() {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("sweep_expired_holds");
  if (error) throw new Error(error.message);

  const result = Array.isArray(data) ? data[0] : null;
  return {
    holdsExpired: result?.holds_expired ?? 0,
    offersMade: result?.offers_made ?? 0,
    offersLapsed: result?.offers_lapsed ?? 0,
  };
}

export async function POST(request: NextRequest) {
  if (!isAuthorised(request)) {
    return NextResponse.json(
      {
        error: process.env.CRON_SECRET
          ? "Unauthorised."
          : "CRON_SECRET is not set, so this endpoint is disabled.",
      },
      { status: 401 },
    );
  }

  try {
    const summary = await runSweep();

    // Drain whatever the sweep just queued, rather than waiting for the next
    // dispatch run. A hold-expiry notice is time-sensitive by definition —
    // the swimmer needs to know now if they want to reclaim the place.
    const dispatchUrl = new URL("/api/notifications/dispatch", request.nextUrl.origin);
    const dispatched = await fetch(dispatchUrl, { method: "POST" })
      .then((r) => r.json())
      .catch(() => null);

    return NextResponse.json({ ...summary, dispatched });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Sweep failed." },
      { status: 500 },
    );
  }
}

/** Vercel Cron issues GET. Same secret, same work. */
export async function GET(request: NextRequest) {
  return POST(request);
}
