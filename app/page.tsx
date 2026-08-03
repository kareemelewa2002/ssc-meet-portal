"use client";

import Link from "next/link";
import { LayoutDashboard, Lock, Radio, Trophy, Users, Waves } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";
import { OutdoorModeToggle } from "@/components/layout/outdoor-mode-toggle";
import { MeetSummaryStats } from "@/components/home/meet-summary-stats";
import { AppHeader } from "@/components/layout/app-header";
import { ROLE_LABELS, useCurrentUser } from "@/hooks/use-current-user";
import type { UserRole } from "@/lib/supabase/types";

/** Only roles with a dedicated deck portal get the Dashboard button. */
const ROLE_DASHBOARD_HREF: Partial<Record<UserRole, string>> = {
  admin: "/admin",
  referee: "/referee",
};

export default function HomePage() {
  const { outdoorMode } = useOutdoorMode();
  const { user } = useCurrentUser();
  // The volumes fetch that used to live here existed only to build the
  // Leaderboards href. /leaderboards now resolves the right volume on the
  // server, so the home page no longer needs to know about meets at all.

  const dashboardHref = ROLE_DASHBOARD_HREF[user?.role ?? "athlete"] ?? null;

  const navLinks = [
    {
      href: "/meets",
      label: "Meets",
      description: "The live meet, plus every past volume's heats and results.",
      icon: Radio,
    },
    {
      // /leaderboards resolves the right volume server-side, so this link
      // is stable regardless of meet state.
      href: "/leaderboards",
      label: "Leaderboards",
      description: "Meet standings for athletes and teams, plus all-time records.",
      icon: Trophy,
    },
    {
      href: "/teams",
      label: "Teams & Athletes",
      description: "Team rosters, captains, and every SSC swimmer's profile.",
      icon: Users,
    },
  ];

  return (
    <div
      className={cn(
        "min-h-screen",
        outdoorMode ? "bg-black text-yellow-300" : "bg-background text-foreground",
      )}
    >
      <AppHeader title="Sprint Swimming Challenge" />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 pb-16 sm:p-8">
        <header
          className={cn(
            "flex items-start justify-between gap-3 rounded-3xl border-2 border-black p-4 shadow-brutal-lg sm:p-6",
            outdoorMode ? "bg-black" : "bg-primary/5 backdrop-blur-md",
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-12 shrink-0 items-center justify-center rounded-2xl border-2 border-black shadow-brutal-sm sm:size-14",
                outdoorMode ? "bg-yellow-300 text-black" : "bg-primary text-primary-foreground",
              )}
            >
              <Waves className="size-6 sm:size-7" />
            </div>
            <div>
              <h1
                className={cn(
                  "text-2xl leading-none font-extrabold tracking-tight sm:text-4xl",
                  outdoorMode && "text-yellow-300",
                )}
              >
                Sprint Swimming Challenge
              </h1>
              <p className={cn("mt-1.5 text-sm font-medium", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
                Live heats, results & series standings — every splash, tracked.
              </p>
            </div>
          </div>
          <OutdoorModeToggle />
        </header>

        <MeetSummaryStats outdoorMode={outdoorMode} />

        <section aria-label="Quick navigation" className="grid gap-3 sm:grid-cols-3">
          {navLinks.map((link, i) => {
            const Icon = link.icon;
            const disabled = !link.href;
            const isHero = i === 0;
            const content = (
              <Card
                className={cn(
                  "h-full transition-all",
                  disabled && "opacity-50 shadow-none",
                  !disabled && "hover:-translate-y-1 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal",
                  outdoorMode && "border-yellow-300/60 bg-black shadow-[4px_4px_0px_#facc15]",
                )}
              >
                <CardContent
                  className={cn(
                    "flex min-h-[48px] items-center gap-3",
                    isHero ? "py-6 sm:flex-col sm:items-start sm:gap-4 sm:py-8" : "py-4",
                  )}
                >
                  <div
                    className={cn(
                      "flex shrink-0 items-center justify-center rounded-xl border-2 border-black",
                      isHero ? "size-12" : "size-10",
                      outdoorMode ? "bg-yellow-300 text-black" : "bg-muted text-foreground",
                    )}
                  >
                    {disabled ? <Lock className="size-5" /> : <Icon className={isHero ? "size-6" : "size-5"} />}
                  </div>
                  <div className="min-w-0">
                    <p
                      className={cn(
                        "font-bold tracking-tight",
                        isHero && "text-lg",
                        outdoorMode && "text-yellow-300",
                      )}
                    >
                      {link.label}
                    </p>
                    <p
                      className={cn(
                        "text-xs",
                        outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
                      )}
                    >
                      {link.description}
                    </p>
                  </div>
                </CardContent>
              </Card>
            );
            return disabled ? (
              <div key={link.label} className={isHero ? "sm:col-span-2 sm:row-span-2" : undefined}>
                {content}
              </div>
            ) : (
              <Link
                key={link.label}
                href={link.href!}
                className={cn("block min-h-[48px]", isHero && "sm:col-span-2 sm:row-span-2")}
              >
                {content}
              </Link>
            );
          })}
        </section>

        {dashboardHref && (
          <section aria-label="Role dashboard">
            <Link href={dashboardHref} className="block min-h-[48px]">
              <Card
                className={cn(
                  "transition-all hover:-translate-y-1 hover:shadow-brutal-lg",
                  outdoorMode && "border-yellow-300/60 bg-black",
                )}
              >
                <CardContent className="flex items-center gap-3 py-4">
                  <div
                    className={cn(
                      "flex size-11 shrink-0 items-center justify-center rounded-xl border-2 border-black",
                      outdoorMode ? "bg-yellow-300 text-black" : "bg-primary text-primary-foreground",
                    )}
                  >
                    <LayoutDashboard className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <p className={cn("font-bold tracking-tight", outdoorMode && "text-yellow-300")}>
                      {ROLE_LABELS[user!.role]} Dashboard
                    </p>
                    <p
                      className={cn(
                        "text-xs",
                        outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
                      )}
                    >
                      Your deck tools and management queues.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          </section>
        )}

      </main>
    </div>
  );
}
