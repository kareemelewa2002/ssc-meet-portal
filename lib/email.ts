import "server-only";

import { Resend } from "resend";

// ---------------------------------------------------------------------------
// Outbound email.
//
// Resend, with the from-address driven by env so verifying a domain later is a
// config change rather than a code change.
//
// UNTIL A DOMAIN IS VERIFIED this runs on onboarding@resend.dev, which Resend
// only delivers to the account owner's own address. The whole pipeline is
// exercisable in that state — rows queue, send, and get marked sent — but real
// athletes receive nothing. That is a deliberate, temporary configuration and
// isEmailConfigured() below is what the dispatcher checks before claiming to
// have delivered anything.
// ---------------------------------------------------------------------------

/** Resend's shared testing sender. Delivers ONLY to the account owner. */
export const RESEND_TEST_FROM = "onboarding@resend.dev";

export function emailFromAddress(): string {
  return process.env.RESEND_FROM_EMAIL || RESEND_TEST_FROM;
}

/**
 * True when a provider key exists.
 *
 * The dispatcher distinguishes "no key configured" from "the send failed".
 * Both leave the row unsent, but only the second is an error worth retrying —
 * marking unconfigured rows as failed would burn their attempt counter for a
 * reason that has nothing to do with them.
 */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/** True while sending from Resend's shared domain, which reaches nobody else. */
export function isTestModeSender(): boolean {
  return emailFromAddress() === RESEND_TEST_FROM;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

export async function sendEmail(input: {
  to: string;
  subject: string;
  body: string;
}): Promise<SendResult> {
  if (!isEmailConfigured()) {
    return { ok: false, error: "RESEND_API_KEY is not set." };
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: emailFromAddress(),
      to: input.to,
      subject: input.subject,
      text: input.body,
      html: renderEmailHtml(input.subject, input.body),
    });

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Unknown send failure." };
  }
}

/**
 * Both a text and an HTML part are sent. Text-only mail is treated as more
 * suspicious by spam filters, and HTML-only is unreadable in clients that
 * refuse to render it — for mail carrying a claim deadline, neither risk is
 * worth taking.
 *
 * Deliberately plain markup with inline styles: email clients strip <style>
 * blocks and support almost no modern CSS.
 */
function renderEmailHtml(subject: string, body: string): string {
  const escape = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
    <h1 style="margin:0 0 12px;font-size:18px;line-height:1.4">${escape(subject)}</h1>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#333;white-space:pre-wrap">${escape(body)}</p>
    <hr style="border:none;border-top:1px solid #eee;margin:24px 0 12px">
    <p style="margin:0;font-size:12px;color:#888">
      Sent by the SSC meet portal. You can change which emails you receive in your
      notification settings — payment and waitlist notices carry deadlines and
      are always sent.
    </p>
  </div>
</body></html>`;
}

/**
 * Collapses several queued notices into one digest message.
 *
 * Only results and schedule notices ever reach here; anything with a clock on
 * it sends immediately, because a digest that arrives after a claim window
 * closed is worse than no email.
 */
export function renderDigest(
  items: { subject: string; body: string }[],
): { subject: string; body: string } {
  const subject =
    items.length === 1
      ? items[0].subject
      : `${items.length} updates from the SSC meet portal`;

  const body = items.map((i) => `• ${i.subject}\n  ${i.body}`).join("\n\n");

  return { subject, body };
}
