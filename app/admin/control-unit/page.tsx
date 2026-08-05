"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkeletonStat } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { LANES_PER_HEAT } from "@/lib/seeding";
import { firstError } from "@/lib/fetch-policy";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DEFAULT_SESSION_WINDOWS,
  SESSION_NUMBERS,
  computeScheduleCapacity,
  eventLimitExceedsSchedule,
  fetchMeetSettingsForEditing,
  fetchSessionSchedules,
  formatDurationSeconds,
  requiredSwims,
  saveMeetSettings,
  saveSessionSchedule,
  type MeetSettings,
  type SessionNumber,
  type SessionSchedule,
} from "@/lib/meet-settings";
import { fetchActiveVolume } from "@/lib/volumes";
import type { MeetVolumeRow } from "@/lib/supabase/types";

/**
 * The Admin Control Unit — every dial that decides what a meet costs, how big
 * it can be, and how long it takes to run.
 *
 * Three tabs, one per session, because every dial here is per session:
 * public.meet_settings is keyed (meet_volume_id, session_number).
 *
 * SCOPES, and why they are split across two tables:
 *   * public.meet_settings — pricing, capacity, heat turnaround, event limit.
 *     The admin's dials.
 *   * public.sessions      — start and end time. It already owned them, and a
 *     second writable copy would be two sources of truth for one fact. A
 *     meet-wide turnaround would make the heat arithmetic wrong somewhere.
 *
 * The readouts recompute as the admin types, from the same pure functions the
 * unit tests exercise (lib/meet-settings.ts) — the number shown and the
 * number tested are the same code, not two copies of a formula.
 */

/** Shown beside the readouts so an admin can see where a number came from. */
const FORMULAS = [
  `Session length = end time − start time`,
  `Max heats per session = ⌊session length ÷ heat turnaround⌋`,
  `Max swims per session = max heats × ${LANES_PER_HEAT} lanes`,
  `Event limit ceiling = ⌊total swims across all sessions ÷ athlete capacity⌋`,
];

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  suffix,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max?: number;
  suffix?: string;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          className="min-h-[48px]"
          value={String(value)}
          onChange={(e) => {
            const next = Number(e.target.value);
            // An empty box parses as 0; clamping to `min` here keeps the live
            // readouts arithmetic-safe while the admin retypes a figure.
            onChange(Number.isFinite(next) ? Math.max(min, next) : min);
          }}
        />
        {suffix && <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Readout({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-2xl border-2 border-black bg-card p-3 shadow-brutal-sm sm:p-4">
      <p className="truncate text-[11px] font-bold tracking-wide uppercase text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-telemetry text-2xl leading-none font-extrabold sm:text-3xl">{value}</p>
      {sub && <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function AdminControlUnitPage() {
  const toast = useToast();
  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [settings, setSettings] = useState<MeetSettings[]>([]);
  const [sessions, setSessions] = useState<SessionSchedule[]>([]);
  const [tab, setTab] = useState<SessionNumber>(1);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setDataError(null);
    const vol = await fetchActiveVolume();
    setVolume(vol.data);
    if (!vol.data) {
      setDataError(vol.error ?? "No meet volume to configure yet.");
      setLoading(false);
      return;
    }
    const [settingsResult, sessionsResult] = await Promise.all([
      // ...ForEditing so all three tabs always have a row to bind to. A
      // session that has never been configured opens on the documented
      // defaults rather than an empty form; saving it INSERTs.
      fetchMeetSettingsForEditing(vol.data.id),
      fetchSessionSchedules(vol.data.id),
    ]);
    setSettings(settingsResult.data);
    setSessions(sessionsResult.data);
    setDataError(firstError(vol, settingsResult, sessionsResult));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const capacity = useMemo(
    () => computeScheduleCapacity(sessions, settings),
    [sessions, settings],
  );

  /** The dials and the clock for the tab currently open. */
  const active = settings.find((s) => s.sessionNumber === tab) ?? null;
  const activeSession = sessions.find((s) => s.sessionNumber === tab) ?? null;
  const activeReadout = capacity.perSession.find((s) => s.sessionNumber === tab) ?? null;

  const overCommitted = active
    ? eventLimitExceedsSchedule(capacity, active.athleteCapacity, active.athleteEventLimit)
    : false;

  const patchSettings = (patch: Partial<MeetSettings>) =>
    setSettings((prev) => prev.map((s) => (s.sessionNumber === tab ? { ...s, ...patch } : s)));

  const patchSession = (id: string, patch: Partial<SessionSchedule>) =>
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const handleSave = async () => {
    if (settings.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Every session is saved, not just the open tab: an admin who edits all
      // three and taps Save once expects all three to persist.
      const results = await Promise.all([
        ...settings.map((s) => saveMeetSettings(s)),
        ...sessions.map((session) => saveSessionSchedule(session)),
      ]);
      const failed = results.find((r) => !r.success);
      if (failed) {
        const message = failed.error ?? "Failed to save the control unit.";
        setSaveError(message);
        toast.error("Nothing was saved", message);
        return;
      }
      toast.success("Control unit saved", "Pricing and session times are live immediately.");
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-screen">
      <AppHeader title="Control Unit" />
      <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-3 pb-24 sm:p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Control Unit</h1>
          <p className="text-sm text-muted-foreground">
            {volume?.name ?? "Meet"} — session times, capacity, heat turnaround and cash-on-deck
            pricing. Prices here are what every swimmer is quoted at registration.
          </p>
        </header>

        <DataErrorBanner error={dataError} subject="meet settings" onRetry={() => void load()} />
        {saveError && (
          <Alert variant="destructive">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        )}

        {loading ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonStat key={i} />
            ))}
          </div>
        ) : !active ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No settings for this volume, so there is nothing to edit and no price to quote.
              Nothing is assumed on your behalf — see the error above.
            </CardContent>
          </Card>
        ) : (
          <>
            <Tabs value={String(tab)} onValueChange={(v) => setTab(Number(v) as SessionNumber)}>
              <TabsList className="grid h-auto w-full grid-cols-3">
                {SESSION_NUMBERS.map((n) => (
                  <TabsTrigger key={n} value={String(n)} className="min-h-[48px]">
                    Session {n}
                    {n === 3 ? " — Skins" : ""}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <section aria-label="Derived capacity" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Readout
                label={`Session ${tab} heats`}
                value={String(activeReadout?.maxHeats ?? 0)}
                sub={`in ${formatDurationSeconds(activeReadout?.durationSeconds ?? null)}`}
              />
              <Readout
                label={`Session ${tab} capacity`}
                value={(activeReadout?.maxSwims ?? 0).toLocaleString()}
                sub={`swims at ${LANES_PER_HEAT} lanes per heat`}
              />
              <Readout
                label="Event limit ceiling"
                value={String(capacity.computedEventLimitCeiling)}
                sub={`whole meet: ${capacity.totalSwims.toLocaleString()} swims`}
              />
              <Readout
                label="Your chosen limit"
                value={String(active.athleteEventLimit)}
                sub={`needs ${requiredSwims(
                  active.athleteCapacity,
                  active.athleteEventLimit,
                ).toLocaleString()} swims`}
              />
            </section>

            {overCommitted && (
              // A warning, never a block. The user's decision: the Control
              // Unit works out what the schedule can physically absorb, and
              // the admin chooses the limit they want — an admin who knows
              // the field will not all enter the maximum is right, and a hard
              // clamp would just be wrong at them.
              <Alert>
                <AlertTriangle className="size-4" />
                <AlertDescription>
                  <strong>
                    {active.athleteEventLimit} events × {active.athleteCapacity} swimmers ={" "}
                    {requiredSwims(
                      active.athleteCapacity,
                      active.athleteEventLimit,
                    ).toLocaleString()}{" "}
                    swims
                  </strong>{" "}
                  but the schedule can run {capacity.totalSwims.toLocaleString()}. A full field at
                  this limit would overrun the meet — the ceiling the schedule supports is{" "}
                  {capacity.computedEventLimitCeiling}. Saved as-is if you want it: lengthen a
                  session, cut the heat turnaround, or lower the capacity to close the gap.
                </AlertDescription>
              </Alert>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {activeSession?.name ?? `Session ${tab}`} — schedule
                </CardTitle>
                <CardDescription>
                  {activeSession
                    ? "Start and end are stored on the session itself; turnaround is a Control Unit dial."
                    : `This volume has no session ${tab} yet, so there is no clock to edit. Defaults would be ${DEFAULT_SESSION_WINDOWS[tab].start}–${DEFAULT_SESSION_WINDOWS[tab].end}.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                {activeSession && (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor={`start-${activeSession.id}`}>Start time</Label>
                      <Input
                        id={`start-${activeSession.id}`}
                        type="time"
                        className="min-h-[48px]"
                        value={activeSession.startTime}
                        onChange={(e) =>
                          patchSession(activeSession.id, { startTime: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={`end-${activeSession.id}`}>End time</Label>
                      <Input
                        id={`end-${activeSession.id}`}
                        type="time"
                        className="min-h-[48px]"
                        value={activeSession.endTime}
                        onChange={(e) =>
                          patchSession(activeSession.id, { endTime: e.target.value })
                        }
                      />
                    </div>
                  </>
                )}
                <NumberField
                  id={`turnaround-${tab}`}
                  label="Heat turnaround"
                  hint="Wall-clock budget for one heat: the swim plus clearing the water."
                  value={active.heatTurnaroundSeconds}
                  min={1}
                  suffix="sec"
                  onChange={(heatTurnaroundSeconds) => patchSettings({ heatTurnaroundSeconds })}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Session {tab} — capacity &amp; pricing</CardTitle>
                <CardDescription>
                  Each session carries its own dials, so an evening Skins session need not be
                  priced or sized like a morning heats session. Cash on deck — no online payment.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <NumberField
                  id={`athlete-capacity-${tab}`}
                  label="Athlete capacity"
                  hint="How many swimmers this session can take. Derives the event-limit ceiling."
                  value={active.athleteCapacity}
                  min={1}
                  suffix="swimmers"
                  onChange={(athleteCapacity) => patchSettings({ athleteCapacity })}
                />
                <NumberField
                  id={`athlete-event-limit-${tab}`}
                  label="Athlete event limit"
                  hint={`Max individual races per swimmer. The schedule supports ${capacity.computedEventLimitCeiling}. A swimmer is held to the strictest limit across the three sessions.`}
                  value={active.athleteEventLimit}
                  min={1}
                  max={20}
                  suffix="events"
                  onChange={(athleteEventLimit) => patchSettings({ athleteEventLimit })}
                />
                <NumberField
                  id={`individual-price-${tab}`}
                  label="Individual event price"
                  hint="Charged per race entered in this session, shown at registration."
                  value={active.individualEventPriceEgp}
                  min={0}
                  suffix="EGP"
                  onChange={(individualEventPriceEgp) => patchSettings({ individualEventPriceEgp })}
                />
                <NumberField
                  id={`relay-price-${tab}`}
                  label="Relay price per swimmer"
                  hint="Per SWIMMER on a squad — a four-swimmer relay costs four of these."
                  value={active.relaySwimmerPriceEgp}
                  min={0}
                  suffix="EGP"
                  onChange={(relaySwimmerPriceEgp) => patchSettings({ relaySwimmerPriceEgp })}
                />
              </CardContent>
            </Card>

            <Card className="border-dashed">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">How the readouts are worked out</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 font-mono text-xs text-muted-foreground">
                  {FORMULAS.map((formula) => (
                    <li key={formula}>{formula}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  The ceiling assumes every swimmer enters the same number of races — the only
                  assumption available before entries exist, and the conservative one.
                </p>
              </CardContent>
            </Card>

            <Button
              type="button"
              className="min-h-[48px] w-full gap-2 text-base font-semibold"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save control unit
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
