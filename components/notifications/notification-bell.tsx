"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Bell, CheckCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCurrentUser } from "@/hooks/use-current-user";
import { createClient } from "@/lib/supabase/client";
import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  relativeTime,
  unreadCount,
  type AppNotification,
} from "@/lib/notifications";
import { cn } from "@/lib/utils";

/**
 * The header bell.
 *
 * In-app delivery is the primary channel, not a nicety layered over email:
 * with no verified sending domain yet, and with per-category email opt-outs,
 * this is the one place every notice is guaranteed to appear. A waitlist offer
 * with a 24-hour clock has to be visible here whatever happened to the email.
 *
 * Subscribed to postgres_changes so an offer that lands while the page is open
 * appears without a reload — the same mechanism the referee deck uses.
 */
export function NotificationBell({ className }: { className?: string }) {
  const { user } = useCurrentUser();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    try {
      const result = await fetchNotifications(user.id, 20);
      setItems(result.data);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`notifications-${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${user.id}`,
        },
        () => void load(),
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [user, load]);

  if (!user) return null;

  const unread = unreadCount(items);

  const openItem = async (item: AppNotification) => {
    setOpen(false);
    if (item.readAt === null) {
      // Optimistic: the row is marked read server-side too, but the badge
      // should drop the moment it is clicked rather than after a round trip.
      setItems((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)),
      );
      await markNotificationRead(item.id);
    }
  };

  const readAll = async () => {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    await markAllNotificationsRead(user.id);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            className={cn("relative h-10 min-h-[44px] w-11 touch-manipulation px-0", className)}
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          />
        }
      >
        <Bell className="size-5" />
        {unread > 0 && (
          <span
            data-testid="notification-unread-count"
            className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-destructive-foreground"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[22rem] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notifications</span>
          {unread > 0 && (
            <Button
              variant="ghost"
              className="h-8 gap-1.5 px-2 text-xs"
              onClick={() => void readAll()}
            >
              <CheckCheck className="size-3.5" />
              Mark all read
            </Button>
          )}
        </div>

        <div className="max-h-[24rem] overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="flex justify-center p-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Nothing yet. Join requests, payment updates and waitlist offers appear here.
            </p>
          ) : (
            <ul>
              {items.map((item) => {
                const body = (
                  <>
                    <div className="flex items-start gap-2">
                      {item.readAt === null && (
                        <span
                          aria-hidden
                          className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                        />
                      )}
                      <div className={cn("min-w-0 flex-1", item.readAt !== null && "pl-4")}>
                        <p className="text-sm font-medium leading-snug">{item.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">{item.body}</p>
                        <p className="mt-1 text-[11px] text-muted-foreground/70">
                          {relativeTime(item.createdAt)}
                        </p>
                      </div>
                    </div>
                  </>
                );

                return (
                  <li key={item.id} className="border-b last:border-b-0">
                    {item.linkUrl ? (
                      <Link
                        href={item.linkUrl}
                        className="block px-3 py-2.5 hover:bg-accent"
                        onClick={() => void openItem(item)}
                      >
                        {body}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="block w-full px-3 py-2.5 text-left hover:bg-accent"
                        onClick={() => void openItem(item)}
                      >
                        {body}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t p-2">
          <Button
            variant="ghost"
            className="h-9 w-full text-xs"
            nativeButton={false}
            render={<Link href="/settings/notifications" />}
            onClick={() => setOpen(false)}
          >
            Notification settings
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
