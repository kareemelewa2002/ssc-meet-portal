"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Clock, Info, MapPin } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";
import { OutdoorModeToggle } from "@/components/layout/outdoor-mode-toggle";
import {
  fetchSessionsForVolume,
  fetchVolumeByNumber,
  formatMeetDate,
  formatSessionTime,
} from "@/lib/volumes";
import type { MeetVolumeRow, SessionRow } from "@/lib/supabase/types";

export function ScheduleClient({ volId }: { volId: string }) {
  const { outdoorMode } = useOutdoorMode();
  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const vol = await fetchVolumeByNumber(Number(volId));
      if (cancelled) return;
      setVolume(vol);
      if (vol) {
        const sess = await fetchSessionsForVolume(vol);
        if (!cancelled) setSessions(sess);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [volId]);

  return (
    <div className={cn("min-h-screen", outdoorMode ? "bg-black text-yellow-300" : "bg-background")}>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/"
            className={cn(
              "flex min-h-[48px] items-center gap-2 text-sm font-medium",
              outdoorMode ? "text-yellow-300" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <ArrowLeft className="size-4" />
            All Events
          </Link>
          <OutdoorModeToggle />
        </div>

        {loading ? (
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
            Loading schedule…
          </p>
        ) : !volume ? (
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
            Volume not found.
          </p>
        ) : (
          <>
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className={cn("text-xl font-bold sm:text-2xl", outdoorMode && "text-yellow-300")}>
                  {volume.name} — Schedule
                </h1>
                <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
                  {formatMeetDate(volume.meet_date)}
                </p>
              </div>
              <Button
                variant={outdoorMode ? "secondary" : "default"}
                className="min-h-[48px]"
                nativeButton={false}
                render={<Link href={`/events/${volId}/register`} />}
              >
                Register for this Volume
              </Button>
            </header>

            <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
              <CardHeader className="flex-row items-center gap-2 space-y-0">
                <Info className={cn("size-5", outdoorMode ? "text-yellow-300" : "text-muted-foreground")} />
                <CardTitle className={cn("text-base", outdoorMode && "text-yellow-300")}>
                  Meet Info
                </CardTitle>
              </CardHeader>
              <CardContent
                className={cn(
                  "flex items-start gap-2 text-sm",
                  outdoorMode ? "text-yellow-100/80" : "text-muted-foreground",
                )}
              >
                <MapPin className="mt-0.5 size-4 shrink-0" />
                <p>Venue details and check-in times will be announced closer to the meet date.</p>
              </CardContent>
            </Card>

            <div className="space-y-3">
              {sessions.map((session) => (
                <Card key={session.id} className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
                  <CardHeader className="flex-row items-center justify-between space-y-0 gap-2">
                    <div>
                      <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>
                        {session.name}
                      </CardTitle>
                      <CardDescription
                        className={cn(
                          "mt-1 flex items-center gap-1.5",
                          outdoorMode && "text-yellow-100/70",
                        )}
                      >
                        <Clock className="size-3.5" />
                        {formatSessionTime(session.start_time)} – {formatSessionTime(session.end_time)}
                      </CardDescription>
                    </div>
                    <Badge variant="outline">Session {session.session_number}</Badge>
                  </CardHeader>
                  <CardContent>
                    <Button
                      variant="outline"
                      nativeButton={false}
                      className="min-h-[48px] w-full sm:w-auto"
                      render={<Link href={`/events/${volId}/live?session=${session.session_number}`} />}
                    >
                      View heat sheets
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
