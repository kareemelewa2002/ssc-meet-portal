"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Loader2, Printer, Send, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SkinsQualifiers } from "@/components/admin/skins-qualifiers";
import { AppHeader } from "@/components/layout/app-header";
import { formatTimeMs, heatTitle } from "@/lib/format";
import { fetchActiveVolume, fetchSessionsForVolume } from "@/lib/volumes";
import {
  fetchHeatPreview,
  fetchSessionSeedingOverview,
  publishEventHeats,
  seedEntireSession,
  seedEventAndWrite,
  swapHeatLanes,
  type PreviewHeat,
  type SeedingStatus,
  type SessionEventSeedingInfo,
} from "@/lib/admin-seeding";
import type { MeetVolumeRow, SessionRow } from "@/lib/supabase/types";

const STATUS_LABEL: Record<SeedingStatus, string> = {
  unseeded: "Unseeded",
  draft_heats: "Draft Heats",
  published: "Published",
};

function statusBadgeVariant(status: SeedingStatus): "outline" | "secondary" | "default" {
  if (status === "published") return "default";
  if (status === "draft_heats") return "secondary";
  return "outline";
}

export default function AdminSeedingPage() {
  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionNumber, setSessionNumber] = useState<1 | 2 | 3>(1);
  const [overview, setOverview] = useState<SessionEventSeedingInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [busySession, setBusySession] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewEventId, setPreviewEventId] = useState<string | null>(null);
  const [previewHeats, setPreviewHeats] = useState<PreviewHeat[]>([]);
  const [selectedLane, setSelectedLane] = useState<{ heatId: string; laneId: string; entryId: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const volResult = await fetchActiveVolume();
      if (cancelled) return;
      setVolume(volResult.data);
      if (volResult.data) {
        const sess = await fetchSessionsForVolume(volResult.data);
        if (!cancelled) setSessions(sess.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const currentSession = useMemo(
    () => sessions.find((s) => s.session_number === sessionNumber) ?? null,
    [sessions, sessionNumber],
  );

  const loadOverview = useCallback(async () => {
    if (!currentSession) return;
    setLoading(true);
    setOverview(await fetchSessionSeedingOverview(currentSession.id));
    setLoading(false);
  }, [currentSession]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadPreview = useCallback(async (eventId: string) => {
    setPreviewHeats(await fetchHeatPreview(eventId));
  }, []);

  const handleSeedEvent = async (eventId: string) => {
    setError(null);
    setBusyEventId(eventId);
    try {
      const res = await seedEventAndWrite(eventId);
      if (!res.success) {
        setError(res.error ?? "Failed to seed event.");
        return;
      }
      await loadOverview();
      setPreviewEventId(eventId);
      await loadPreview(eventId);
    } finally {
      setBusyEventId(null);
    }
  };

  const handleSeedSession = async () => {
    if (!currentSession) return;
    setError(null);
    setBusySession(true);
    try {
      const results = await seedEntireSession(currentSession.id);
      const failed = results.find((r) => !r.result.success);
      if (failed) setError(failed.result.error ?? "Some events failed to seed.");
      await loadOverview();
    } finally {
      setBusySession(false);
    }
  };

  const handlePublish = async (eventId: string) => {
    setError(null);
    setBusyEventId(eventId);
    try {
      const res = await publishEventHeats(eventId);
      if (!res.success) {
        setError(res.error ?? "Failed to publish heat sheet.");
        return;
      }
      await loadOverview();
      await loadPreview(eventId);
    } finally {
      setBusyEventId(null);
    }
  };

  const handleLaneClick = async (heatId: string, laneId: string, entryId: string | null) => {
    if (!selectedLane) {
      setSelectedLane({ heatId, laneId, entryId });
      return;
    }
    if (selectedLane.laneId === laneId) {
      setSelectedLane(null);
      return;
    }
    const a = selectedLane;
    setSelectedLane(null);
    const res = await swapHeatLanes(a.laneId, laneId, a.entryId, entryId);
    if (!res.success) {
      setError(res.error ?? "Failed to swap lanes.");
      return;
    }
    if (previewEventId) await loadPreview(previewEventId);
  };

  return (
    <div className="min-h-screen">
      <AppHeader title="Seeding Dashboard" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Seeding Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {volume?.name ?? "Meet"} — seed entries into 6-lane heats and publish when ready.
        </p>
      </header>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs value={String(sessionNumber)} onValueChange={(v) => setSessionNumber(Number(v) as 1 | 2 | 3)}>
        <TabsList className="grid h-auto w-full grid-cols-3">
          {[1, 2, 3].map((n) => (
            <TabsTrigger key={n} value={String(n)} className="min-h-[48px]">
              Session {n}
              {n === 3 ? " — Skins" : ""}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex justify-end">
        <Button
          type="button"
          className="min-h-[48px] gap-2"
          disabled={
            busySession ||
            overview.filter((e) => !e.isSkins && !e.isRelay).every((e) => e.status !== "unseeded")
          }
          onClick={() => void handleSeedSession()}
        >
          {busySession ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
          Seed Entire Session
        </Button>
      </div>

      {/* Session 3 is the Skins session — its slots are ranked, not seeded
          from entries, so the withdraw/reinstate control belongs with it. */}
      {sessionNumber === 3 && <SkinsQualifiers />}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading events…</p>
      ) : overview.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No events in this session yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {overview.map((ev) => (
            <Card key={ev.eventId}>
              <CardHeader className="flex-row items-center justify-between space-y-0 gap-2">
                <div>
                  <CardTitle className="text-base">
                    {ev.distanceM}m {ev.stroke}
                  </CardTitle>
                  <CardDescription>
                    {ev.entryCount} {ev.entryCount === 1 ? "entry" : "entries"}
                    {ev.isSkins && " · Skins (auto-assigned)"}
                    {ev.isRelay && " · Relay (no individual entries)"}
                  </CardDescription>
                </div>
                <Badge variant={statusBadgeVariant(ev.status)}>{STATUS_LABEL[ev.status]}</Badge>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {!ev.isSkins && !ev.isRelay && ev.status === "unseeded" && (
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-[48px] gap-2"
                    disabled={busyEventId === ev.eventId}
                    onClick={() => void handleSeedEvent(ev.eventId)}
                  >
                    {busyEventId === ev.eventId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Wand2 className="size-4" />
                    )}
                    Seed Single Event
                  </Button>
                )}
                {ev.status !== "unseeded" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-[48px]"
                    onClick={() => {
                      const next = previewEventId === ev.eventId ? null : ev.eventId;
                      setPreviewEventId(next);
                      if (next) void loadPreview(next);
                    }}
                  >
                    {previewEventId === ev.eventId ? "Hide Preview" : "Preview Heat Sheet"}
                  </Button>
                )}
                {ev.status === "draft_heats" && (
                  <Button
                    type="button"
                    size="sm"
                    className="min-h-[48px] gap-2"
                    disabled={busyEventId === ev.eventId}
                    onClick={() => void handlePublish(ev.eventId)}
                  >
                    {busyEventId === ev.eventId ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    Publish Heat Sheet
                  </Button>
                )}
              </CardContent>

              {previewEventId === ev.eventId && (
                <CardContent className="space-y-3 border-t pt-3">
                  <div className="flex items-center justify-between gap-2" data-print-hide>
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ArrowLeftRight className="size-3.5" />
                      Tap two lanes to swap their swimmers.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-[40px] gap-1.5"
                      onClick={() => window.print()}
                    >
                      <Printer className="size-3.5" />
                      Print Heat Sheet
                    </Button>
                  </div>
                  {previewHeats.map((heat) => (
                    <div key={heat.heatId} className="space-y-2 rounded-lg border p-3" data-print-card>
                      <div className="flex items-center gap-2">
                        <Badge className="h-7 px-2.5">{heatTitle(heat)}</Badge>
                      </div>
                      {heat.lanes.map((lane) => (
                        <button
                          key={lane.heatLaneId}
                          type="button"
                          onClick={() =>
                            void handleLaneClick(heat.heatId, lane.heatLaneId, lane.entryId)
                          }
                          className={`flex min-h-[48px] w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors ${
                            selectedLane?.laneId === lane.heatLaneId
                              ? "border-primary bg-primary/10"
                              : "border-border"
                          }`}
                        >
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-sm font-bold">
                            L{lane.laneNumber}
                          </span>
                          <span className="min-w-0 flex-1 truncate font-medium">{lane.athleteName}</span>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {lane.isNt ? "NT" : formatTimeMs(lane.seedTimeMs)}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}
      </main>
    </div>
  );
}
