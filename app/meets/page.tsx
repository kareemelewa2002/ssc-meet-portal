"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, ListChecks, Radio, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SkeletonStat } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AppHeader } from "@/components/layout/app-header";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { describeError, failure, ok, type FetchResult } from "@/lib/fetch-policy";
import { formatMeetDate } from "@/lib/volumes";
import type { MeetVolumeRow } from "@/lib/supabase/types";

/**
 * Meets index — the live meet plus every past meet.
 *
 * Volumes with status 'planned' are deliberately NOT listed: the old
 * "Coming Soon" cards advertised meets that had no date, no schedule and no
 * entries, so they were pure noise on a page whose whole job is "what can I
 * look at right now".
 */
async function fetchMeets(): Promise<FetchResult<MeetVolumeRow[]>> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("meet_volumes")
      .select("*")
      .neq("status", "planned")
      .order("volume_number", { ascending: false });
    if (error) return failure(describeError("Loading meets", error), []);
    return ok(data ?? []);
  } catch (err) {
    return failure(describeError("Loading meets", err), []);
  }
}

function MeetCard({ volume, live }: { volume: MeetVolumeRow; live: boolean }) {
  const base = `/events/${volume.volume_number}`;
  const links = [
    { href: `${base}/heats`, label: "Heat Sheet", icon: ListChecks },
    { href: `${base}/results`, label: "Results", icon: Radio },
    { href: `${base}/leaderboard`, label: "Leaderboard", icon: Trophy },
  ];

  return (
    <Card className={cn(live && "shadow-[var(--shadow-brutal-cyan)]")}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-lg">{volume.name}</CardTitle>
          {live ? (
            <Badge className="gap-1.5 border-black bg-neon-cyan font-telemetry tracking-widest text-black uppercase">
              <span className="animate-pulse-ring inline-flex size-2 rounded-full bg-black" />
              Live
            </Badge>
          ) : (
            <Badge variant="secondary">Completed</Badge>
          )}
        </div>
        <CardDescription className="flex items-center gap-1.5">
          <CalendarDays className="size-3.5" />
          {formatMeetDate(volume.meet_date)}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-2">
        {links.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-xl border-2 border-black bg-background px-2 py-2 text-center text-[11px] font-bold shadow-brutal-sm transition-all hover:-translate-y-0.5 hover:bg-muted hover:shadow-brutal active:translate-y-[2px] active:shadow-none sm:text-xs"
          >
            <Icon className="size-4" />
            {label}
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

export default function MeetsPage() {
  const [meets, setMeets] = useState<MeetVolumeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchMeets();
      if (cancelled) return;
      setMeets(res.data);
      setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // "Live" is the most recent meet that hasn't been marked completed.
  const liveId = useMemo(
    () => meets?.find((m) => m.status === "scheduled")?.id ?? null,
    [meets],
  );
  const past = useMemo(() => meets?.filter((m) => m.id !== liveId) ?? [], [meets, liveId]);
  const live = useMemo(() => meets?.find((m) => m.id === liveId) ?? null, [meets, liveId]);

  return (
    <div className="min-h-screen">
      <AppHeader title="Meets" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Meets</h1>
          <p className="text-sm text-muted-foreground">
            Heat sheets, results, and standings for the live meet and every past volume.
          </p>
        </header>

        <DataErrorBanner error={error} subject="meets" />

        {!meets ? (
          <div className="space-y-3">
            <SkeletonStat />
            <SkeletonStat />
          </div>
        ) : meets.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {error ? "Meets unavailable." : "No meets have been scheduled yet."}
            </CardContent>
          </Card>
        ) : (
          <>
            {live && (
              <section aria-label="Live meet" className="space-y-2">
                <h2 className="text-xs font-bold tracking-wide uppercase text-muted-foreground">
                  Live now
                </h2>
                <MeetCard volume={live} live />
              </section>
            )}

            {past.length > 0 && (
              <section aria-label="Past meets" className="space-y-2">
                <h2 className="text-xs font-bold tracking-wide uppercase text-muted-foreground">
                  Past meets
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {past.map((m) => (
                    <MeetCard key={m.id} volume={m} live={false} />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
