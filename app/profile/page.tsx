"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, Settings, ShieldCheck } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { SkeletonRow, SkeletonStat } from "@/components/ui/skeleton";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser, ROLE_LABELS } from "@/hooks/use-current-user";
import type { UserRole } from "@/lib/supabase/types";

const ROLE_DASHBOARD_HREF: Partial<Record<UserRole, string>> = {
  admin: "/admin",
  referee: "/referee",
  coach: "/coach",
};

/**
 * "Profile" in the AppHeader dropdown. Athletes have a full public profile
 * (bio, PB ledger, career results) already built at /athletes/[id] — this
 * page just resolves the signed-in athlete's own id and hands off there
 * rather than duplicating that view. Every other role has no separate
 * profile record beyond public.users, so they see a lightweight identity
 * card here instead.
 */
export default function ProfilePage() {
  const router = useRouter();
  const { user, loading } = useCurrentUser();
  const [resolvingAthlete, setResolvingAthlete] = useState(true);

  useEffect(() => {
    if (loading || !user) {
      setResolvingAthlete(false);
      return;
    }
    if (user.role !== "athlete") {
      setResolvingAthlete(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("athletes").select("id").eq("user_id", user.id).maybeSingle();
      if (cancelled) return;
      if (data?.id) {
        router.replace(`/athletes/${data.id}`);
        return;
      }
      setResolvingAthlete(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, user, router]);

  if (loading || resolvingAthlete) {
    return (
      <div className="min-h-screen">
        <AppHeader title="Profile" />
        <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-3 pb-24 sm:p-6">
          <div className="space-y-3"><SkeletonRow /><SkeletonStat /></div>
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen">
        <AppHeader title="Profile" />
        <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-3 pb-24 sm:p-6">
          <p className="text-sm text-muted-foreground">Sign in to view your profile.</p>
        </main>
      </div>
    );
  }

  const dashboardHref = ROLE_DASHBOARD_HREF[user.role];

  return (
    <div className="min-h-screen">
      <AppHeader title="Profile" />
      <main className="mx-auto flex w-full max-w-lg flex-col gap-4 p-3 pb-24 sm:p-6">
        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <Avatar className="size-16">
              {user.profileImageUrl ? <AvatarImage src={user.profileImageUrl} alt={user.fullName} /> : null}
              <AvatarFallback className="text-lg">{user.fullName.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <CardTitle className="truncate">{user.fullName}</CardTitle>
              <Badge variant="secondary" className="mt-1 gap-1">
                <ShieldCheck className="size-3.5" />
                {ROLE_LABELS[user.role]}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <Mail className="size-4" />
                {user.email}
              </span>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {dashboardHref && (
                <Button
                  variant="outline"
                  className="min-h-[48px] flex-1 gap-2"
                  nativeButton={false}
                  render={<Link href={dashboardHref} />}
                >
                  <ShieldCheck className="size-4" />
                  Role Dashboard
                </Button>
              )}
              <Button
                variant="outline"
                className="min-h-[48px] flex-1 gap-2"
                nativeButton={false}
                render={<Link href="/settings" />}
              >
                <Settings className="size-4" />
                Account Settings
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
