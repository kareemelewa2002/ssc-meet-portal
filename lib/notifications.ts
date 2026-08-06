import { createClient } from "@/lib/supabase/client";
import { runQuery, type FetchResult } from "@/lib/fetch-policy";
import type { NotificationCategoryValue, NotificationRow } from "@/lib/supabase/types";

// ---------------------------------------------------------------------------
// Notifications.
//
// Every notice is written to public.notifications and shown in the header
// bell. Email is a SECOND channel layered on top — public.raise_notification()
// queues it into public.email_outbox, and /api/notifications/dispatch sends it.
//
// The in-app record is never suppressed, whatever the user's preferences say.
// That is what makes "I was never told" answerable: the row exists either way,
// and preferences only govern whether an email also went out.
// ---------------------------------------------------------------------------

export type NotificationCategory = NotificationCategoryValue;

export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  "team",
  "entry_payment",
  "waitlist",
  "results_schedule",
  "announcement",
];

/**
 * Categories whose email cannot be switched off.
 *
 * These carry clocks. A missed hold expiry or a missed 24-hour claim window
 * costs the athlete their slot, so an opt-out is a trap dressed as a
 * preference. public.notification_preferences has a CHECK constraint that
 * refuses to store them as off — this constant is the UI's copy of that rule,
 * not the enforcement.
 */
export const MANDATORY_EMAIL_CATEGORIES: readonly NotificationCategory[] = [
  "entry_payment",
  "waitlist",
];

export function isMandatoryCategory(category: NotificationCategory): boolean {
  return MANDATORY_EMAIL_CATEGORIES.includes(category);
}

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  team: "Team requests",
  entry_payment: "Payments & entries",
  waitlist: "Waitlist offers",
  results_schedule: "Results & schedule",
  announcement: "Team announcements",
};

export const NOTIFICATION_CATEGORY_DESCRIPTIONS: Record<NotificationCategory, string> = {
  team: "Join requests for a team you captain, and the outcome of your own requests.",
  entry_payment:
    "Payment recorded, entries confirmed, and warnings before a place is released.",
  waitlist: "A place opening up for you, and the deadline to claim it.",
  results_schedule: "Published results, heat and lane assignments, session time changes.",
  announcement: "Messages your team captain posts for the whole squad.",
};

export interface AppNotification {
  id: string;
  category: NotificationCategory;
  title: string;
  body: string;
  linkUrl: string | null;
  metadata: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

export type NotificationPreferences = Record<NotificationCategory, boolean>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  team: true,
  entry_payment: true,
  waitlist: true,
  results_schedule: true,
  announcement: true,
};

function toNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    category: row.category,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url,
    metadata: row.metadata ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function unreadCount(notifications: AppNotification[]): number {
  return notifications.filter((n) => n.readAt === null).length;
}

/** "3 minutes ago" / "2 days ago" for the feed. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Data access.
// ---------------------------------------------------------------------------

export async function fetchNotifications(
  userId: string,
  limit = 50,
): Promise<FetchResult<AppNotification[]>> {
  const result = await runQuery<NotificationRow[]>(
    "Loading notifications",
    async () => {
      const supabase = createClient();
      return supabase
        .from("notifications")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
    },
    { empty: [] },
  );

  return { ...result, data: result.data.map(toNotification) };
}

export async function markNotificationRead(
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .is("read_at", null);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function markAllNotificationsRead(
  userId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function fetchNotificationPreferences(
  userId: string,
): Promise<FetchResult<NotificationPreferences>> {
  const result = await runQuery<{ category: NotificationCategory; email_enabled: boolean }[]>(
    "Loading notification preferences",
    async () => {
      const supabase = createClient();
      return supabase
        .from("notification_preferences")
        .select("category, email_enabled")
        .eq("user_id", userId);
    },
    { empty: [] },
  );

  // An absent row means opted IN. Defaulting to off would silence a user who
  // has simply never visited the settings page.
  const prefs = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  result.data.forEach((row) => {
    prefs[row.category] = row.email_enabled;
  });
  // Mandatory categories always read as on, whatever is stored.
  MANDATORY_EMAIL_CATEGORIES.forEach((c) => {
    prefs[c] = true;
  });

  return { ...result, data: prefs };
}

export async function saveNotificationPreference(
  userId: string,
  category: NotificationCategory,
  emailEnabled: boolean,
): Promise<{ success: boolean; error?: string }> {
  if (isMandatoryCategory(category) && !emailEnabled) {
    // Refused here as well as by the CHECK constraint, so the UI gets a
    // sentence instead of a Postgres error string.
    return {
      success: false,
      error: `${NOTIFICATION_CATEGORY_LABELS[category]} emails carry deadlines and cannot be turned off.`,
    };
  }

  const supabase = createClient();
  const { error } = await supabase
    .from("notification_preferences")
    .upsert(
      { user_id: userId, category, email_enabled: emailEnabled },
      { onConflict: "user_id,category" },
    );
  if (error) return { success: false, error: error.message };
  return { success: true };
}

/**
 * Nudges the dispatcher to drain the outbox.
 *
 * Fire-and-forget on purpose: a failed send must never break the page action
 * that caused the notice. Anything left pending is picked up by the next
 * scheduled run, so the worst case is a delayed email, not a lost one.
 */
export function requestEmailDispatch(): void {
  void fetch("/api/notifications/dispatch", { method: "POST" }).catch(() => {
    /* queued rows survive; the scheduled run will send them */
  });
}
