"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { AppHeader } from "@/components/layout/app-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkeletonStat } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { firstError } from "@/lib/fetch-policy";
import {
  DEFAULT_SESSION_WINDOWS,
  PRICING_TIERS,
  PRICING_TIER_LABELS,
  computeScheduleCapacity,
  eventLimitExceedsSchedule,
  fetchMeetSettingsForEditing,
  fetchScheduledEvents,
  fetchSessionSchedules,
  formatDurationSeconds,
  requiredSwims,
  saveEventSettings,
  saveMeetSettings,
  saveSessionSchedule,
  type MeetSettings,
  type PricingTier,
  type ScheduledEvent,
  type SessionSchedule,
} from "@/lib/meet-settings";
import {
  ADDITIONAL_RACE_ROW,
  PACKAGE_RACE_COUNTS,
  activeTier,
  fetchPricingMatrix,
  fetchTierWindows,
  formatEgp,
  savePricingMatrix,
  saveTierWindows,
  tierLabel,
  type PricingMatrixCell,
  type TierWindow,
} from "@/lib/pricing";
import { fetchActiveVolume } from "@/lib/volumes";
import type { MeetVolumeRow } from "@/lib/supabase/types";

/**
 * The Admin Control Unit — every dial that decides what a meet costs, how big
 * it can be, and how long it takes to run.
 *
 * SECTIONS, not session tabs. This page used to be three tabs, one per
 * session, because public.meet_settings was keyed by session. It is keyed by
 * VOLUME now: packages are counted across the whole meet, and turnaround and
 * surcharge became per-EVENT, so there was nothing left that varied by session
 * except the clock — which lives on public.sessions and gets one small row
 * each in the Schedule section.
 *
 * WHERE EACH DIAL LIVES, and why it is split:
 *   * public.meet_settings      — capacity, lanes, holds, waitlist windows,
 *                                 registration window, refunds, relay price.
 *   * public.pricing_packages   — the 4x3 matrix and the additional-race price.
 *   * public.pricing_tiers      — when each phase is in force.
 *   * public.sessions           — start and end time. Already owned them; a
 *                                 second writable copy would be two sources of
 *                                 truth for one fact.
 *   * public.events             — turnaround, surcharge and cap, PER RACE.
 *
 * The readouts recompute as the admin types, from the same pure functions the
 * unit tests exercise (lib/meet-settings.ts) — the number shown and the number
 * tested are the same code, not two copies of a formula.
 */

/** Shown beside the readouts so an admin can see where a number came from. */
const FORMULAS = [
  `Session length = end time − start time`,
  `Mean turnaround = average of the turnarounds of the races scheduled in that session`,
  `Max heats per session = ⌊session length ÷ mean turnaround⌋`,
  `Max swims per session = max heats × lane count`,
  `Event limit ceiling = ⌊total swims across all sessions ÷ athlete capacity⌋`,
  `Estimated run time = Σ (heats for a race × that race's own turnaround)`,
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function NumberField({
  id,
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-h-[48px]"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function ControlUnitPage() {
  const toast = useToast();

  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [settings, setSettings] = useState<MeetSettings | null>(null);
  const [sessions, setSessions] = useState<SessionSchedule[]>([]);
  const [events, setEvents] = useState<ScheduledEvent[]>([]);
  const [matrix, setMatrix] = useState<PricingMatrixCell[]>([]);
  const [tierWindows, setTierWindows] = useState<TierWindow[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const vol = await fetchActiveVolume();
      if (!vol.data) {
        setError(vol.error ?? "No active meet volume to configure.");
        return;
      }
      setVolume(vol.data);

      const [cfg, sch, evs, mx, tw] = await Promise.all([
        fetchMeetSettingsForEditing(vol.data.id),
        fetchSessionSchedules(vol.data.id),
        fetchScheduledEvents(vol.data.id),
        fetchPricingMatrix(vol.data.id),
        fetchTierWindows(vol.data.id),
      ]);

      setSettings(cfg.data);
      setEvents(evs.data);
      setMatrix(mx.data);
      setTierWindows(tw.data);
      setSessions(
        sch.data.length > 0
          ? sch.data
          : // No sessions yet: offer the default clock rather than three blank
            // rows an admin has to invent times for.
            ([1, 2, 3] as const).map((n) => ({
              id: "",
              sessionNumber: n,
              name: `Session ${n}`,
              startTime: DEFAULT_SESSION_WINDOWS[n].start,
              endTime: DEFAULT_SESSION_WINDOWS[n].end,
            })),
      );

      setError(firstError(cfg, sch, evs, mx, tw));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (changes: Partial<MeetSettings>) =>
    setSettings((prev) => (prev ? { ...prev, ...changes } : prev));

  const patchEvent = (id: string, changes: Partial<ScheduledEvent>) =>
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...changes } : e)));

  const patchMatrix = (raceCount: number, tier: PricingTier, priceEgp: number) =>
    setMatrix((prev) => {
      const existing = prev.find((c) => c.raceCount === raceCount && c.tier === tier);
      if (existing) {
        return prev.map((c) =>
          c.raceCount === raceCount && c.tier === tier ? { ...c, priceEgp } : c,
        );
      }
      return [...prev, { raceCount, tier, priceEgp }];
    });

  const patchTierWindow = (tier: PricingTier, changes: Partial<TierWindow>) =>
    setTierWindows((prev) =>
      prev.some((w) => w.tier === tier)
        ? prev.map((w) => (w.tier === tier ? { ...w, ...changes } : w))
        : [...prev, { tier, startsAt: "", endsAt: "", ...changes }],
    );

  const priceAt = (raceCount: number, tier: PricingTier) =>
    matrix.find((c) => c.raceCount === raceCount && c.tier === tier)?.priceEgp ?? 0;

  const capacity = useMemo(
    () => (settings ? computeScheduleCapacity(sessions, settings, events) : null),
    [sessions, settings, events],
  );

  const currentTier = useMemo(
    () => (settings ? activeTier(settings, tierWindows) : null),
    [settings, tierWindows],
  );

  const overCapacity =
    capacity && settings
      ? eventLimitExceedsSchedule(capacity, settings.athleteCapacity, settings.athleteEventLimit)
      : false;

  const handleSave = async () => {
    if (!settings || !volume) return;
    setSaving(true);
    setError(null);
    try {
      const results = await Promise.all([
        saveMeetSettings(settings),
        savePricingMatrix(volume.id, matrix),
        saveTierWindows(
          volume.id,
          tierWindows.filter((w) => w.startsAt && w.endsAt),
        ),
        ...sessions.filter((s) => s.id).map((s) => saveSessionSchedule(s)),
        ...events.map((e) => saveEventSettings(e)),
      ]);

      const failed = results.find((r) => !r.success);
      if (failed) throw new Error(failed.error ?? "Save failed.");

      toast.success("Control Unit saved", "Pricing, schedule and per-race settings are live.");
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Save failed.";
      setError(message);
      toast.error("Could not save", message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <>
        <AppHeader />
        <main className="mx-auto w-full max-w-5xl space-y-4 p-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonStat key={i} />
          ))}
        </main>
      </>
    );
  }

  if (!settings) {
    return (
      <>
        <AppHeader />
        <main className="mx-auto w-full max-w-5xl p-4">
          <DataErrorBanner
            error={error ?? "No meet settings to configure."}
            subject="the Control Unit"
            onRetry={() => void load()}
          />
        </main>
      </>
    );
  }

  const eventsBySession = sessions.map((session) => ({
    session,
    events: events.filter((e) => e.sessionId === session.id),
  }));

  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-5xl space-y-4 p-4 pb-24">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">Control Unit</h1>
            <p className="text-sm text-muted-foreground">
              {volume?.name ?? "Active meet"} — every configurable meet variable.
            </p>
          </div>
          {currentTier && (
            <Badge variant="outline" className="shrink-0">
              Selling at {tierLabel(currentTier)}
              {settings.pinnedPricingTier ? " (pinned)" : ""}
            </Badge>
          )}
        </div>

        {error && <DataErrorBanner error={error} subject="the Control Unit" onRetry={() => void load()} />}

        {/* ---------------------------------------------------------------- */}
        <Section
          title="Pricing matrix"
          description="What an athlete pays for entering N individual races, at each of the three tiers. Race count is taken across the whole meet — three races spread over two sessions is one three-race package."
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[10rem]">Package</TableHead>
                  {PRICING_TIERS.map((tier) => (
                    <TableHead key={tier} className="min-w-[8rem]">
                      {PRICING_TIER_LABELS[tier]}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {PACKAGE_RACE_COUNTS.map((count) => (
                  <TableRow key={count}>
                    <TableCell className="font-medium">
                      {count} {count === 1 ? "race" : "races"}
                    </TableCell>
                    {PRICING_TIERS.map((tier) => (
                      <TableCell key={tier}>
                        <Input
                          type="number"
                          min={0}
                          inputMode="numeric"
                          aria-label={`${count} race package, ${PRICING_TIER_LABELS[tier]}`}
                          value={priceAt(count, tier)}
                          onChange={(e) => patchMatrix(count, tier, Number(e.target.value))}
                          className="min-h-[44px]"
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {/* Not a package. This is the per-race price for a race added
                    after payment, and for every race past the fourth when the
                    event limit is raised above 4. */}
                <TableRow>
                  <TableCell className="font-medium">
                    Each additional race
                    <p className="text-xs font-normal text-muted-foreground">
                      Added after payment, or past the 4th race
                    </p>
                  </TableCell>
                  {PRICING_TIERS.map((tier) => (
                    <TableCell key={tier}>
                      <Input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        aria-label={`Each additional race, ${PRICING_TIER_LABELS[tier]}`}
                        value={priceAt(ADDITIONAL_RACE_ROW, tier)}
                        onChange={(e) =>
                          patchMatrix(ADDITIONAL_RACE_ROW, tier, Number(e.target.value))
                        }
                        className="min-h-[44px]"
                      />
                    </TableCell>
                  ))}
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <NumberField
            id="relay-price"
            label="Relay fee, per swimmer"
            hint="Charged on top of the package. A relay leg does not count toward the individual race count, and this fee is not tiered."
            value={settings.relaySwimmerPriceEgp}
            min={0}
            onChange={(n) => patch({ relaySwimmerPriceEgp: n })}
          />

          <Alert>
            <AlertDescription className="text-xs">
              A swimmer pays the tier in force <strong>when payment is collected</strong>, not
              when they registered. The registration form tells them so, and the desk quotes
              whatever is current at that moment.
            </AlertDescription>
          </Alert>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          title="Pricing tiers"
          description="When each phase applies. The active tier is decided by these dates unless you pin one."
        >
          {PRICING_TIERS.map((tier) => {
            const window = tierWindows.find((w) => w.tier === tier);
            return (
              <div key={tier} className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr] sm:items-end">
                <div className="text-sm font-medium">{PRICING_TIER_LABELS[tier]}</div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${tier}-start`}>Starts</Label>
                  <Input
                    id={`${tier}-start`}
                    type="datetime-local"
                    value={(window?.startsAt ?? "").slice(0, 16)}
                    onChange={(e) =>
                      patchTierWindow(tier, {
                        startsAt: e.target.value ? new Date(e.target.value).toISOString() : "",
                      })
                    }
                    className="min-h-[48px]"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${tier}-end`}>Ends</Label>
                  <Input
                    id={`${tier}-end`}
                    type="datetime-local"
                    value={(window?.endsAt ?? "").slice(0, 16)}
                    onChange={(e) =>
                      patchTierWindow(tier, {
                        endsAt: e.target.value ? new Date(e.target.value).toISOString() : "",
                      })
                    }
                    className="min-h-[48px]"
                  />
                </div>
              </div>
            );
          })}

          <div className="space-y-1.5">
            <Label htmlFor="pinned-tier">Override the calendar</Label>
            <select
              id="pinned-tier"
              className="min-h-[48px] w-full rounded-md border bg-background px-3 text-sm"
              value={settings.pinnedPricingTier ?? ""}
              onChange={(e) =>
                patch({
                  pinnedPricingTier: e.target.value ? (e.target.value as PricingTier) : null,
                })
              }
            >
              <option value="">Decide by date (normal)</option>
              {PRICING_TIERS.map((tier) => (
                <option key={tier} value={tier}>
                  Pin to {PRICING_TIER_LABELS[tier]}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              A pin outranks the dates entirely — use it to extend a deadline or cover an
              outage, and clear it afterwards.
            </p>
          </div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          title="Sessions"
          description="When each session runs. These times live on the session itself, and every capacity figure below is derived from them."
        >
          {sessions.map((session, index) => (
            <div key={session.sessionNumber} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr]">
              <div className="space-y-1.5">
                <Label>{session.name}</Label>
                <p className="text-xs text-muted-foreground">
                  {session.id ? "Scheduled" : "Not created yet — save to create"}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`start-${session.sessionNumber}`}>Start</Label>
                <Input
                  id={`start-${session.sessionNumber}`}
                  type="time"
                  value={session.startTime}
                  onChange={(e) =>
                    setSessions((prev) =>
                      prev.map((s, i) => (i === index ? { ...s, startTime: e.target.value } : s)),
                    )
                  }
                  className="min-h-[48px]"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`end-${session.sessionNumber}`}>End</Label>
                <Input
                  id={`end-${session.sessionNumber}`}
                  type="time"
                  value={session.endTime}
                  onChange={(e) =>
                    setSessions((prev) =>
                      prev.map((s, i) => (i === index ? { ...s, endTime: e.target.value } : s)),
                    )
                  }
                  className="min-h-[48px]"
                />
              </div>
            </div>
          ))}

          <div className="grid gap-4 sm:grid-cols-3">
            <NumberField
              id="athlete-capacity"
              label="Athletes per session"
              hint="Planning figure for the capacity maths, not a hard gate on registration."
              value={settings.athleteCapacity}
              min={1}
              onChange={(n) => patch({ athleteCapacity: n })}
            />
            <NumberField
              id="lane-count"
              label="Lanes"
              value={settings.laneCount}
              min={1}
              max={20}
              onChange={(n) => patch({ laneCount: n })}
            />
            <NumberField
              id="break-minutes"
              label="Break between sessions (min)"
              value={settings.interSessionBreakMinutes}
              min={0}
              onChange={(n) => patch({ interSessionBreakMinutes: n })}
            />
          </div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          title="Races"
          description="Turnaround, surcharge and capacity for every race, individually. New volumes start from the race-shape template; everything here can be changed."
        >
          {eventsBySession.map(({ session, events: sessionEvents }) => (
            <div key={session.sessionNumber} className="space-y-2">
              <h3 className="text-sm font-semibold">{session.name}</h3>
              {sessionEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No races scheduled yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[14rem]">Race</TableHead>
                        <TableHead className="min-w-[7rem]">Turnaround (s)</TableHead>
                        <TableHead className="min-w-[7rem]">Surcharge (EGP)</TableHead>
                        <TableHead className="min-w-[7rem]">Capacity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessionEvents.map((ev) => (
                        <TableRow key={ev.id}>
                          <TableCell className="font-medium">{ev.name}</TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={1}
                              aria-label={`${ev.name} turnaround seconds`}
                              value={ev.turnaroundSeconds}
                              onChange={(e) =>
                                patchEvent(ev.id, { turnaroundSeconds: Number(e.target.value) })
                              }
                              className="min-h-[44px]"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={0}
                              aria-label={`${ev.name} surcharge`}
                              value={ev.surchargeEgp}
                              onChange={(e) =>
                                patchEvent(ev.id, { surchargeEgp: Number(e.target.value) })
                              }
                              className="min-h-[44px]"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="number"
                              min={1}
                              aria-label={`${ev.name} capacity`}
                              value={ev.capacityCap}
                              onChange={(e) =>
                                patchEvent(ev.id, { capacityCap: Number(e.target.value) })
                              }
                              className="min-h-[44px]"
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ))}
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          title="Registration, holds and the waitlist"
          description="When entries are accepted, how long an unpaid entry keeps its place, and when a race starts warning that it is filling up."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="reg-opens">Registration opens</Label>
              <Input
                id="reg-opens"
                type="datetime-local"
                value={(settings.registrationOpensAt ?? "").slice(0, 16)}
                onChange={(e) =>
                  patch({
                    registrationOpensAt: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  })
                }
                className="min-h-[48px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="reg-closes">Registration closes</Label>
              <Input
                id="reg-closes"
                type="datetime-local"
                value={(settings.registrationClosesAt ?? "").slice(0, 16)}
                onChange={(e) =>
                  patch({
                    registrationClosesAt: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  })
                }
                className="min-h-[48px]"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.lateRegistrationEnabled}
              onChange={(e) => patch({ lateRegistrationEnabled: e.target.checked })}
              className="size-4"
            />
            Allow late registration after the close
          </label>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField
              id="hold-window"
              label="Unpaid hold (hours)"
              hint="How long an unpaid entry keeps its place before the slot is released."
              value={settings.holdWindowHours}
              min={1}
              max={720}
              onChange={(n) => patch({ holdWindowHours: n })}
            />
            <NumberField
              id="waitlist-claim"
              label="Waitlist claim (hours)"
              hint="How long the next swimmer has to take a freed place."
              value={settings.waitlistClaimHours}
              min={1}
              max={168}
              onChange={(n) => patch({ waitlistClaimHours: n })}
            />
            <NumberField
              id="selling-out"
              label="Selling out at (% left)"
              hint="At or below this share remaining, a race reads “selling out soon”."
              value={settings.sellingOutThresholdPercent}
              min={0}
              max={100}
              onChange={(n) => patch({ sellingOutThresholdPercent: n })}
            />
            <NumberField
              id="default-capacity"
              label="Default race capacity"
              hint="Used for a race that has not been given its own cap."
              value={settings.defaultEventCapacity}
              min={1}
              onChange={(n) => patch({ defaultEventCapacity: n })}
            />
          </div>

          <NumberField
            id="event-limit"
            label="Races one athlete may enter"
            hint={
              capacity
                ? `The schedule can absorb ${capacity.computedEventLimitCeiling} at ${settings.athleteCapacity} athletes per session. You choose the limit; this is not clamped.`
                : undefined
            }
            value={settings.athleteEventLimit}
            min={1}
            max={20}
            onChange={(n) => patch({ athleteEventLimit: n })}
          />

          {overCapacity && capacity && (
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertDescription>
                A full field entering {settings.athleteEventLimit} races each needs{" "}
                {requiredSwims(settings.athleteCapacity, settings.athleteEventLimit)} swims, but
                the schedule can run {capacity.totalSwims}. Allowed — the meet will need to
                overrun, add time, or fill below capacity.
              </AlertDescription>
            </Alert>
          )}
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          title="Refunds"
          description="What a withdrawing athlete gets back, and until when."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              id="refund-percent"
              label="Refund (%)"
              hint="0 with no deadline is “no refunds” — which is a policy, not the absence of one."
              value={settings.refundPercent}
              min={0}
              max={100}
              onChange={(n) => patch({ refundPercent: n })}
            />
            <NumberField
              id="refund-deadline"
              label="Up to (days before the meet)"
              value={settings.refundDeadlineDays ?? 0}
              min={0}
              onChange={(n) => patch({ refundDeadlineDays: n })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="refund-note">Policy note shown to athletes</Label>
            <Input
              id="refund-note"
              value={settings.refundPolicyNote ?? ""}
              onChange={(e) => patch({ refundPolicyNote: e.target.value || null })}
              className="min-h-[48px]"
            />
          </div>
        </Section>

        {/* ---------------------------------------------------------------- */}
        <Section
          title="Capacity readout"
          description="Derived as you type, from the races actually scheduled in each session."
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Length</TableHead>
                  <TableHead>Races</TableHead>
                  <TableHead>Turnaround</TableHead>
                  <TableHead>Max heats</TableHead>
                  <TableHead>Max swims</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {capacity?.perSession.map((row) => {
                  const session = sessions.find((s) => s.sessionNumber === row.sessionNumber);
                  return (
                    <TableRow key={row.sessionNumber}>
                      <TableCell>{session?.name ?? `Session ${row.sessionNumber}`}</TableCell>
                      <TableCell>{formatDurationSeconds(row.durationSeconds)}</TableCell>
                      <TableCell>{row.profile.eventCount}</TableCell>
                      <TableCell className="text-xs">
                        {row.profile.eventCount === 0 ? (
                          "—"
                        ) : (
                          <>
                            {row.profile.meanTurnaroundSeconds}s mean
                            {row.profile.minTurnaroundSeconds !==
                              row.profile.maxTurnaroundSeconds && (
                              <span className="text-muted-foreground">
                                {" "}
                                ({row.profile.minTurnaroundSeconds}–
                                {row.profile.maxTurnaroundSeconds}s)
                              </span>
                            )}
                          </>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{row.maxHeats}</TableCell>
                      <TableCell className="tabular-nums">{row.maxSwims}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium">How these are worked out</p>
            <ul className="space-y-0.5">
              {FORMULAS.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <p className="mt-2">
              The ceiling assumes every swimmer enters the same number of races — the only
              assumption available before entries exist, and the conservative one.
            </p>
          </div>

          {capacity && (
            <p className="text-sm">
              Total swim slots across the meet:{" "}
              <strong className="tabular-nums">{capacity.totalSwims}</strong>. Cheapest package
              on sale right now:{" "}
              <strong>{currentTier ? formatEgp(priceAt(1, currentTier)) : "—"}</strong> for one
              race.
            </p>
          )}
        </Section>

        <div className="sticky bottom-4 flex justify-end">
          <Button
            type="button"
            className="min-h-[48px] gap-2 shadow-lg"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save Control Unit
          </Button>
        </div>
      </main>
    </>
  );
}
