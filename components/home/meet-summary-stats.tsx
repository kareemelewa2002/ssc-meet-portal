"use client";

import { useEffect, useState } from "react";
import { Building2, ListChecks, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchMeetSummaryStats, type MeetSummaryStats } from "@/lib/meet-stats";

const STATS = [
  { key: "athleteCount" as const, label: "Athletes Registered", icon: Users },
  { key: "teamCount" as const, label: "Teams Participating", icon: Building2 },
  { key: "eventCount" as const, label: "Events Scheduled", icon: ListChecks },
];

export function MeetSummaryStats({ outdoorMode = false }: { outdoorMode?: boolean }) {
  const [stats, setStats] = useState<MeetSummaryStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await fetchMeetSummaryStats();
      if (!cancelled) setStats(s);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section aria-label="Meet summary" className="grid grid-cols-3 gap-2 sm:gap-3">
      {STATS.map(({ key, label, icon: Icon }) => (
        <div
          key={key}
          className={cn(
            "flex flex-col items-center gap-1 rounded-xl border p-3 text-center sm:flex-row sm:justify-center sm:gap-2.5",
            outdoorMode ? "border-yellow-300/40 bg-black" : "bg-card",
          )}
        >
          <Icon className={cn("size-5 shrink-0", outdoorMode ? "text-yellow-300" : "text-primary")} />
          <div>
            <p
              className={cn(
                "font-mono text-xl font-bold tabular-nums leading-none",
                outdoorMode && "text-yellow-300",
              )}
            >
              {stats ? stats[key] : "—"}
            </p>
            <p className={cn("text-[11px]", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
              {label}
            </p>
          </div>
        </div>
      ))}
    </section>
  );
}
