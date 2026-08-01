"use client";

import Link from "next/link";
import { ArrowLeft, LogIn } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, useCurrentUser } from "@/hooks/use-current-user";

export interface AppHeaderProps {
  /** Page title shown next to the return-home control. */
  title?: string;
  /** Hide the role badge (e.g. on fully public pages with no relevant role). */
  showRoleBadge?: boolean;
  className?: string;
}

/**
 * Sticky top navigation used on every sub-page: a "← Return to Home" link
 * back to "/", the page title, and the signed-in user's active Role badge
 * (or a Sign in prompt when unauthenticated). Deck portals (/usher,
 * /referee, /admin) rely on this for the "Role: X" requirement; middleware
 * already redirects unauthenticated visitors away from those specific
 * routes, but the badge/sign-in prompt here covers public pages too.
 */
export function AppHeader({ title, showRoleBadge = true, className }: AppHeaderProps) {
  const { user, loading } = useCurrentUser();

  return (
    <header
      className={cn(
        "sticky top-0 z-30 flex min-h-[56px] items-center justify-between gap-3 border-b bg-background/95 px-3 py-2 backdrop-blur-sm sm:px-6",
        className,
      )}
    >
      <Link
        href="/"
        className="flex min-h-[48px] items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4 shrink-0" />
        <span className="hidden sm:inline">Return to Home</span>
        <span className="sm:hidden">Home</span>
      </Link>

      {title && (
        <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold sm:text-base">
          {title}
        </h1>
      )}

      {showRoleBadge &&
        (loading ? (
          <div className="h-6 w-16 shrink-0" />
        ) : user ? (
          <Badge variant="secondary" className="shrink-0 gap-1 text-xs" title={user.fullName}>
            Role: {ROLE_LABELS[user.role]}
          </Badge>
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
        ))}
    </header>
  );
}
