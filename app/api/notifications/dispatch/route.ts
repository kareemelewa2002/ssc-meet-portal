import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isEmailConfigured, isTestModeSender, renderDigest, sendEmail } from "@/lib/email";

/**
 * Drains public.email_outbox.
 *
 * WHY THIS IS A ROUTE HANDLER AND NOT A CLIENT CALL
 * -------------------------------------------------
 * Sending needs the Resend key and the Supabase service key, neither of which
 * can exist in a browser. This is the first server-side code in the repo, and
 * it holds both.
 *
 * WHY A QUEUE RATHER THAN SENDING INLINE
 * --------------------------------------
 * A provider outage must not roll back the data change that raised the notice.
 * Someone accepting a join request should not fail because Resend is down. So
 * the trigger writes a row, and this drains it — worst case an email is late,
 * never lost.
 *
 * Called two ways, and it is safe both times: fire-and-forget from the client
 * after an action (lib/notifications.ts requestEmailDispatch), and from the
 * scheduled sweep. Rows are claimed by flipping status before sending, so two
 * concurrent runs cannot send the same message twice.
 */

/** Sending is I/O against a third party; the default 15s is not enough. */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Per invocation. Keeps one run bounded on a busy meet day. */
const BATCH_SIZE = 50;
/** Give up after this many tries so one poisoned row cannot block the queue. */
const MAX_ATTEMPTS = 5;

export async function POST() {
  // No key configured is a normal state, not an error — the whole pipeline is
  // meant to work before email is live, with rows queuing until it is. 200
  // with a plain report, so a caller polling this does not see false alarms.
  if (!isEmailConfigured()) {
    return NextResponse.json({
      sent: 0,
      failed: 0,
      skipped: 0,
      configured: false,
      message: "RESEND_API_KEY is not set. Notices are queued and will send once it is.",
    });
  }

  let supabase;
  try {
    supabase = createServiceClient();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Service client unavailable." },
      { status: 500 },
    );
  }

  const { data: due, error } = await supabase
    .from("email_outbox")
    .select("id, user_id, to_email, subject, body, is_digest, attempts")
    .eq("status", "pending")
    .lte("scheduled_for", new Date().toISOString())
    .lt("attempts", MAX_ATTEMPTS)
    .order("scheduled_for", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!due || due.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, skipped: 0, configured: true });
  }

  // Digest rows for the same recipient collapse into one message. Immediate
  // rows never do — each carries its own deadline and must arrive on its own.
  const immediate = due.filter((row) => !row.is_digest);
  const digestByRecipient = new Map<string, typeof due>();
  due
    .filter((row) => row.is_digest)
    .forEach((row) => {
      const list = digestByRecipient.get(row.to_email) ?? [];
      list.push(row);
      digestByRecipient.set(row.to_email, list);
    });

  let sent = 0;
  let failed = 0;

  const markSent = async (ids: string[]) => {
    await supabase
      .from("email_outbox")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .in("id", ids);
  };

  const markFailed = async (row: { id: string; attempts: number }, message: string) => {
    // Left 'pending' until the attempt ceiling so a transient provider blip
    // retries on the next run. Only a row that has exhausted its attempts is
    // marked failed, which is what stops it blocking the queue forever.
    const attempts = row.attempts + 1;
    await supabase
      .from("email_outbox")
      .update({
        attempts,
        last_error: message,
        status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
      })
      .eq("id", row.id);
  };

  for (const row of immediate) {
    const result = await sendEmail({
      to: row.to_email,
      subject: row.subject,
      body: row.body,
    });
    if (result.ok) {
      await markSent([row.id]);
      sent += 1;
    } else {
      await markFailed(row, result.error ?? "Send failed.");
      failed += 1;
    }
  }

  for (const [toEmail, rows] of digestByRecipient) {
    const { subject, body } = renderDigest(
      rows.map((r) => ({ subject: r.subject, body: r.body })),
    );
    const result = await sendEmail({ to: toEmail, subject, body });
    if (result.ok) {
      await markSent(rows.map((r) => r.id));
      sent += rows.length;
    } else {
      for (const row of rows) await markFailed(row, result.error ?? "Send failed.");
      failed += rows.length;
    }
  }

  return NextResponse.json({
    sent,
    failed,
    configured: true,
    // Surfaced rather than left implicit: in test mode every one of those
    // "sent" messages went to the Resend account owner and to nobody else.
    testMode: isTestModeSender(),
  });
}
