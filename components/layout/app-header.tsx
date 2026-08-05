"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Home, LayoutDashboard, LogIn, LogOut, Settings, User } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { ROLE_LABELS, useCurrentUser } from "@/hooks/use-current-user";
import { NotificationBell } from "@/components/notifications/notification-bell";
import type { UserRole } from "@/lib/supabase/types";

export interface AppHeaderProps {
  /** Page title shown centered in the bar. */
  title?: string;
  className?: string;
}

/** Only roles with a dedicated deck portal get a "Role Dashboard" link —
 * athletes/parents use /profile and the public pages instead. */
const ROLE_DASHBOARD_HREF: Partial<Record<UserRole, string>> = {
  admin: "/admin",
  referee: "/referee",
};

function initialsFor(fullName: string): string {
  return fullName
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Standardized sticky top navigation rendered on every page: a "← Back"
 * button (browser history), a "Home" button (always to "/"), the current
 * page title, and a User Profile Menu (name, active Role badge, Sign Out).
 * Guests can't actually reach any page this renders on except transiently —
 * middleware.ts redirects unauthenticated visitors to /login for every
 * route except /login and /register — but the "Sign in" fallback below
 * still covers that brief/edge-case window gracefully.
 */
export function AppHeader({ title, className }: AppHeaderProps) {
  const router = useRouter();
  const { user, loading } = useCurrentUser();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex min-h-[56px] items-center justify-between gap-2 border-b-2 border-black bg-background/80 px-2 py-2 backdrop-blur-md sm:px-6",
        className,
      )}
    >
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-10 min-h-[44px] min-w-[44px]"
          aria-label="Back"
          onClick={() => router.back()}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-10 min-h-[44px] min-w-[44px]"
          aria-label="Home"
          nativeButton={false}
          render={<Link href="/" />}
        >
          <Home className="size-5" />
        </Button>
      </div>

      {title && (
        <h1 className="min-w-0 flex-1 truncate text-center text-sm font-extrabold tracking-tight sm:text-base">
          {title}
        </h1>
      )}

      <div className="flex shrink-0 items-center gap-1">
        {/* Sits OUTSIDE the account menu on purpose: a waitlist offer with a
            24-hour clock should be one glance away, not two taps inside a
            dropdown someone opens once a week. */}
        {!loading && user && <NotificationBell />}
        {loading ? (
          <div className="size-9 animate-pulse rounded-full bg-muted" />
        ) : user ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-10 min-h-[44px] touch-manipulation gap-2 px-2"
                />
              }
            >
              <Avatar className="size-8">
                {user.profileImageUrl ? (
                  <AvatarImage src={user.profileImageUrl} alt={user.fullName} />
                ) : null}
                <AvatarFallback className="text-xs">{initialsFor(user.fullName)}</AvatarFallback>
              </Avatar>
              <span className="hidden max-w-[120px] truncate text-sm font-medium sm:inline">
                {user.fullName}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="truncate">{user.fullName}</DropdownMenuLabel>
                <div className="px-1.5 pb-1.5">
                  <Badge variant="secondary" className="text-xs">
                    {ROLE_LABELS[user.role]}
                  </Badge>
                </div>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="min-h-[40px]" render={<Link href="/profile" />}>
                <User className="size-4" />
                Profile
              </DropdownMenuItem>
              {ROLE_DASHBOARD_HREF[user.role] && (
                <DropdownMenuItem
                  className="min-h-[40px]"
                  render={<Link href={ROLE_DASHBOARD_HREF[user.role]!} />}
                >
                  <LayoutDashboard className="size-4" />
                  Role Dashboard
                </DropdownMenuItem>
              )}
              <DropdownMenuItem className="min-h-[40px]" render={<Link href="/settings" />}>
                <Settings className="size-4" />
                Account Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                className="min-h-[40px]"
                onClick={() => void handleSignOut()}
              >
                <LogOut className="size-4" />
                Sign Out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="min-h-[40px] shrink-0 gap-1.5"
            nativeButton={false}
            render={<Link href="/login" />}
          >
            <LogIn className="size-3.5" />
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
