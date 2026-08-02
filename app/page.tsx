"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Building2, Calendar, Lock, Radio, Trophy, Users, Waves } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";
import { OutdoorModeToggle } from "@/components/layout/outdoor-mode-toggle";
import { MeetSummaryStats } from "@/components/home/meet-summary-stats";
import { AppHeader } from "@/components/layout/app-header";
import { DEMO_VOLUMES, formatMeetDate } from "@/lib/volumes";
import type { MeetVolumeRow } from "@/lib/supabase/types";

function statusBadge(volume: MeetVolumeRow) {
  if (volume.status === "planned") return { label: "Coming Soon", variant: "outline" as const };
  if (volume.status === "completed") return { label: "Completed", variant: "secondary" as const };
  return { label: "Live Volume", variant: "default" as const };
}

export default function HomePage() {
  const { outdoorMode } = useOutdoorMode();
  const [volumes, setVolumes] = useState<MeetVolumeRow[]>(DEMO_VOLUMES);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("meet_volumes")
          .select("*")
          .order("volume_number", { ascending: true });
        if (!cancelled && !error && data && data.length > 0) {
          setVolumes(data);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The current volume nav links (Live / Leaderboard / Schedule) point to the
  // most recent non-"planned" volume — the one spectators actually care about.
  const currentVolume = useMemo(
    () => [...volumes].reverse().find((v) => v.status !== "planned") ?? null,
    [volumes],
  );

  const navLinks = [
    {
      href: currentVolume ? `/events/${currentVolume.volume_number}/live` : null,
      label: "Live Heat Sheets & Results",
      description: "Heat sheets, lane assignments, and results as they publish.",
      icon: Radio,
    },
    {
      href: currentVolume ? `/events/${currentVolume.volume_number}/leaderboard` : null,
      label: "Series Leaderboards",
      description: "Champions (placement points) and Progress (time drops).",
      icon: Trophy,
    },
    {
      href: currentVolume ? `/events/${currentVolume.volume_number}/schedule` : null,
      label: "Schedule / Info",
      description: "Session times and meet-day details.",
      icon: Calendar,
    },
    {
      href: "/athletes",
      label: "Athlete Directory",
      description: "Search every SSC swimmer and open public profiles.",
      icon: Users,
    },
    {
      href: "/leaderboards/all-time",
      label: "All-Time Records",
      description: "Best performers and fastest race times in SSC history.",
      icon: Trophy,
    },
    {
      href: "/teams",
      label: "Team Directory",
      description: "Approved teams, captains, and rosters.",
      icon: Building2,
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
            "flex items-start justify-between gap-3 rounded-3xl border-2 border-black p-4 shadow-[6px_6px_0px_#000] sm:p-6",
            outdoorMode ? "bg-black" : "bg-primary/5 backdrop-blur-md",
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "flex size-12 shrink-0 items-center justify-center rounded-2xl border-2 border-black shadow-[3px_3px_0px_#000] sm:size-14",
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
                  !disabled && "hover:-translate-y-1 hover:shadow-[6px_6px_0px_#000] active:translate-y-0 active:shadow-[4px_4px_0px_#000]",
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

        <section aria-label="Events and meet series" className="space-y-3">
          <div>
            <h2 className={cn("text-lg font-bold", outdoorMode && "text-yellow-300")}>
              Events & Meet Series
            </h2>
            <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
              Pick a volume to view its heat sheets, results, and leaderboards.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {volumes.map((volume) => {
              const badge = statusBadge(volume);
              const isComingSoon = volume.status === "planned";

              const card = (
                <Card
                  className={cn(
                    "h-full transition-colors",
                    isComingSoon && "opacity-50 grayscale",
                    !isComingSoon && "hover:border-primary/50",
                    outdoorMode && "border-yellow-300/40 bg-black",
                  )}
                >
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
                        {volume.name}
                      </CardTitle>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
                      {formatMeetDate(volume.meet_date)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <p
                      className={cn(
                        "text-sm",
                        outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
                      )}
                    >
                      {isComingSoon
                        ? "Details will be announced soon."
                        : "Tap to view heat sheets, live results, and leaderboards."}
                    </p>
                  </CardContent>
                </Card>
              );

              return isComingSoon ? (
                <div key={volume.id} aria-disabled="true">
                  {card}
                </div>
              ) : (
                <Link
                  key={volume.id}
                  href={`/events/${volume.volume_number}/live`}
                  className="block min-h-[48px]"
                >
                  {card}
                </Link>
              );
            })}
          </div>

          {loading && (
            <p className={cn("text-xs", outdoorMode ? "text-yellow-100/60" : "text-muted-foreground")}>
              Loading latest volumes…
            </p>
          )}
        </section>
      </main>
    </div>
  );
}
