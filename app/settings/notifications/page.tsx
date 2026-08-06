"use client";

import { useCallback, useEffect, useState } from "react";
import { Lock, Loader2 } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkeletonStat } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_DESCRIPTIONS,
  NOTIFICATION_CATEGORY_LABELS,
  fetchNotificationPreferences,
  isMandatoryCategory,
  saveNotificationPreference,
  type NotificationCategory,
  type NotificationPreferences,
} from "@/lib/notifications";

/**
 * Which emails a user receives.
 *
 * IN-APP NOTIFICATIONS ARE NOT CONFIGURABLE and the page says so. They are the
 * record that a swimmer was told something; letting them be switched off would
 * make "I was never notified" unanswerable.
 *
 * Payment and waitlist emails cannot be switched off either. Those carry
 * deadlines — a missed hold expiry or a missed 24-hour claim window costs the
 * athlete their place — so an opt-out would be a trap dressed as a preference.
 * The real enforcement is a CHECK constraint on
 * public.notification_preferences; this page renders the same rule rather than
 * being the only thing holding it.
 */
export default function NotificationSettingsPage() {
  const toast = useToast();
  const { user, loading: userLoading } = useCurrentUser();

  const [prefs, setPrefs] = useState<NotificationPreferences>(
    DEFAULT_NOTIFICATION_PREFERENCES,
  );
  const [loading, setLoading] = useState(true);
  const [savingCategory, setSavingCategory] = useState<NotificationCategory | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const result = await fetchNotificationPreferences(user.id);
      setPrefs(result.data);
      setError(result.error);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (!userLoading) void load();
  }, [load, userLoading]);

  const toggle = async (category: NotificationCategory, enabled: boolean) => {
    if (!user || isMandatoryCategory(category)) return;

    const previous = prefs[category];
    setPrefs((p) => ({ ...p, [category]: enabled }));
    setSavingCategory(category);
    try {
      const result = await saveNotificationPreference(user.id, category, enabled);
      if (!result.success) {
        // Put it back. A toggle that stays flipped after a failed save tells
        // the user their preference is stored when it is not.
        setPrefs((p) => ({ ...p, [category]: previous }));
        throw new Error(result.error ?? "Could not save.");
      }
      toast.success(
        "Saved",
        `${NOTIFICATION_CATEGORY_LABELS[category]} emails are ${enabled ? "on" : "off"}.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save.";
      setError(message);
      toast.error("Could not save", message);
    } finally {
      setSavingCategory(null);
    }
  };

  if (userLoading || loading) {
    return (
      <>
        <AppHeader />
        <main className="mx-auto w-full max-w-2xl space-y-4 p-4">
          <SkeletonStat />
          <SkeletonStat />
        </main>
      </>
    );
  }

  if (!user) {
    return (
      <>
        <AppHeader />
        <main className="mx-auto w-full max-w-2xl p-4">
          <DataErrorBanner
            error="Sign in to manage your notifications."
            subject="notification settings"
          />
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-2xl space-y-4 p-4">
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            Choose which emails you receive. Everything still appears in the bell whatever
            you set here.
          </p>
        </div>

        {error && (
          <DataErrorBanner
            error={error}
            subject="notification settings"
            onRetry={() => void load()}
          />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Email me about</CardTitle>
            <CardDescription>
              In-app notifications are always on — this only governs email.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1">
            {NOTIFICATION_CATEGORIES.map((category) => {
              const mandatory = isMandatoryCategory(category);
              return (
                <label
                  key={category}
                  className={`flex items-start gap-3 rounded-md p-3 ${
                    mandatory ? "bg-muted/40" : "hover:bg-accent/50"
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1 size-4"
                    checked={prefs[category]}
                    disabled={mandatory || savingCategory === category}
                    onChange={(e) => void toggle(category, e.target.checked)}
                    aria-label={NOTIFICATION_CATEGORY_LABELS[category]}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">
                        {NOTIFICATION_CATEGORY_LABELS[category]}
                      </span>
                      {mandatory && (
                        <Badge variant="secondary" className="gap-1 text-[10px]">
                          <Lock className="size-3" />
                          Always on
                        </Badge>
                      )}
                      {savingCategory === category && (
                        <Loader2 className="size-3 animate-spin text-muted-foreground" />
                      )}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {NOTIFICATION_CATEGORY_DESCRIPTIONS[category]}
                    </span>
                  </span>
                </label>
              );
            })}
          </CardContent>
        </Card>

        <Alert>
          <AlertDescription className="text-xs">
            Payment and waitlist emails cannot be switched off. They carry deadlines — a
            released place or an unclaimed waitlist offer costs you your spot — so turning
            them off would only mean finding out too late.
          </AlertDescription>
        </Alert>

        <p className="text-xs text-muted-foreground">
          Results and schedule notices are batched into one daily email. Anything with a
          deadline is sent straight away.
        </p>
      </main>
    </>
  );
}
