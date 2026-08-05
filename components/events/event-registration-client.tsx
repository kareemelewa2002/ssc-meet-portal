"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Banknote, CheckCircle2, ListChecks, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createClient } from "@/lib/supabase/client";
import { fetchVolumeByNumber } from "@/lib/volumes";
import { fetchTeams } from "@/lib/teams";
import { canSubmitEntries } from "@/lib/register";
import { acceptSafetyAcknowledgement } from "@/lib/safety";
import {
  maxEventsMessage,
  validateEventCount,
  fetchAthleteEnteredEventIds,
  fetchPreviousBestTimes,
  fetchRegisterableEvents,
  resolveSeedSource,
  submitEventRegistration,
  type EventSelection,
  type RegisterableEvent,
} from "@/lib/event-registration";
import { fetchMeetSettings, type MeetSettings } from "@/lib/meet-settings";
import {
  AVAILABILITY_LABELS,
  availabilityVariant,
  describeAvailability,
  fetchEventCapacities,
  joinWaitlist,
  leaveWaitlist,
  fetchAthleteWaitlist,
  type EventCapacity,
  type WaitlistEntry,
} from "@/lib/capacity";
import {
  fetchPricingMatrix,
  fetchTierWindows,
  activeTier,
  tierEndsAt,
  tierLabel,
  quoteSelection,
  formatEgp,
  priceLineKindLabel,
  type PricingMatrixCell,
  type TierWindow,
} from "@/lib/pricing";
import { CLOCK_TIME_ERROR, formatTimeMs, parseTimeToMs } from "@/lib/format";
import { ClockTimeInput } from "@/components/ui/clock-time-input";
import type { AgeGroup, MeetVolumeRow, ParentLinkStatus, TeamRow } from "@/lib/supabase/types";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { getErrorMessage } from "@/lib/utils";

interface EventDraft {
  selected: boolean;
  isNt: boolean;
  timeInput: string;
}

interface CurrentAthlete {
  id: string;
  parentLinkStatus: ParentLinkStatus;
  ageGroup: AgeGroup | null;
  safetyAcceptedAt: string | null | undefined;
}

export function EventRegistrationClient({ volId }: { volId: string }) {
  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  // Price and event cap both come from the Control Unit. Null means they
  // could not be read, and the form refuses to quote a price rather than
  // showing a plausible one — see lib/fetch-policy.ts.
  const [settings, setSettings] = useState<MeetSettings | null>(null);
  const [matrix, setMatrix] = useState<PricingMatrixCell[]>([]);
  const [tierWindows, setTierWindows] = useState<TierWindow[]>([]);
  const [capacities, setCapacities] = useState<Map<string, EventCapacity>>(new Map());
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [waitlistBusy, setWaitlistBusy] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [events, setEvents] = useState<RegisterableEvent[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [athlete, setAthlete] = useState<CurrentAthlete | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [acceptingSafety, setAcceptingSafety] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [enteredEventIds, setEnteredEventIds] = useState<Set<string>>(new Set());

  const [drafts, setDrafts] = useState<Record<string, EventDraft>>({});
  const [teamId, setTeamId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [previousBest, setPreviousBest] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const volResult = await fetchVolumeByNumber(volId);
      if (cancelled) return;
      setVolume(volResult.data);
      if (volResult.error) setDataError(volResult.error);

      let loadedEvents: RegisterableEvent[] = [];
      if (volResult.data) {
        const [ev, tm, cfg, mx, tw] = await Promise.all([
          fetchRegisterableEvents(volResult.data.id),
          fetchTeams(),
          fetchMeetSettings(volResult.data.id),
          fetchPricingMatrix(volResult.data.id),
          fetchTierWindows(volResult.data.id),
        ]);
        loadedEvents = ev;
        // Capacity for every listed race in ONE round trip. Per-race calls
        // would be one request per row on a twenty-race form.
        const caps = await fetchEventCapacities(ev.map((e) => e.id));
        if (!cancelled) {
          setEvents(ev);
          setCapacities(caps.data);
          setTeams(tm.data.filter((t) => t.approved_by_admin));
          setSettings(cfg.data);
          setMatrix(mx.data);
          setTierWindows(tw.data);
          // A missing matrix is as disqualifying as a missing settings row:
          // without prices there is nothing honest to quote, and showing a
          // total assembled from zeros would read as a free meet.
          if (cfg.error || mx.error || tw.error || !cfg.data || mx.data.length === 0) {
            setSettingsError(
              cfg.error ??
                mx.error ??
                tw.error ??
                `${volResult.data.name} has no entry pricing configured yet, so races can't be priced. An admin sets this in the Control Unit.`,
            );
          }
          if (tm.error) setDataError(tm.error);
        }
      }

      try {
        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) setAuthError("Sign in to register for a meet volume.");
          return;
        }
        const { data: athleteRow } = await supabase
          .from("athletes")
          .select("id, parent_link_status, age_group")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!athleteRow) {
          if (!cancelled) setAuthError("Only athlete accounts can register for meet events.");
          return;
        }

        // Queried separately, and tolerant of the column being absent: a
        // database that has not yet had the latest schema.sql applied would
        // otherwise 400 this whole query and lock every athlete out of
        // registration. `undefined` means "unknown", which does not gate —
        // only a known-NULL (column present, nothing accepted) does.
        let safetyAcceptedAt: string | null | undefined;
        const { data: safetyRow } = await supabase
          .from("athletes")
          .select("safety_accepted_at")
          .eq("id", athleteRow.id)
          .maybeSingle();
        if (safetyRow) safetyAcceptedAt = safetyRow.safety_accepted_at;
        if (!cancelled) {
          setAthlete({
            id: athleteRow.id,
            parentLinkStatus: athleteRow.parent_link_status,
            ageGroup: athleteRow.age_group,
            safetyAcceptedAt: safetyAcceptedAt,
          });
        }
        // Lock out events already entered — otherwise re-selecting one and
        // submitting hits entries' unique(event_id, athlete_id) constraint
        // as a raw, unfriendly 409.
        const entered = await fetchAthleteEnteredEventIds(
          athleteRow.id,
          loadedEvents.map((e) => e.id),
        );
        if (!cancelled) setEnteredEventIds(entered);

        // Queue standing, so a race this swimmer is already waiting on reads
        // "Waiting — #3" rather than offering to join a second time.
        const queued = await fetchAthleteWaitlist(athleteRow.id);
        if (!cancelled) setWaitlist(queued.data);

        // From volume 2 the seed time comes from the swimmer's own history,
        // so the form shows what will be used instead of asking for it.
        if ((volResult.data?.volume_number ?? 1) > 1) {
          const previous = await fetchPreviousBestTimes(
            athleteRow.id,
            loadedEvents.filter((e) => !e.seedsAsNt).map((e) => e.id),
          );
          if (!cancelled) setPreviousBest(previous);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [volId]);

  // Admin approval deliberately does NOT gate registration any more: an
  // athlete signs up, picks their races, and the admin then approves the
  // swimmer and confirms the cash payment together in one action. Parent
  // authorization for U14s is a separate, legal gate and still applies.
  const entryGate = useMemo(
    () =>
      athlete
        ? canSubmitEntries({
            parentLinkStatus: athlete.parentLinkStatus,
            safetyAcceptedAt: athlete.safetyAcceptedAt,
          })
        : { ok: true as const },
    [athlete],
  );

  // U14s are routed to their parent; everyone else can self-accept here.
  const needsParentAcceptance = athlete?.ageGroup === "U14";

  const handleAcceptSafety = async () => {
    if (!athlete) return;
    setAcceptingSafety(true);
    try {
      const res = await acceptSafetyAcknowledgement(athlete.id);
      if (!res.success) {
        setError(res.error ?? "Couldn't record the acknowledgement.");
        return;
      }
      setAthlete((prev) => (prev ? { ...prev, safetyAcceptedAt: new Date().toISOString() } : prev));
      setError(null);
    } finally {
      setAcceptingSafety(false);
    }
  };

  const enteredCount = enteredEventIds.size;

  /** What this event's seed time will be, and why — mirrors the database. */
  const seedFor = (ev: RegisterableEvent) =>
    resolveSeedSource(ev, volume?.volume_number ?? 1, previousBest.get(ev.id));
  // One cap for the whole meet — the admin's chosen limit, from the Control
  // Unit. It may exceed four, which is why the pricing matrix carries an
  // each-additional-race row.
  const eventLimit = settings?.athleteEventLimit ?? null;
  const remainingSlots = eventLimit == null ? 0 : Math.max(0, eventLimit - enteredCount);

  /** The tier in force right now, and when it stops applying. */
  const currentTier = useMemo(
    () => (settings ? activeTier(settings, tierWindows) : null),
    [settings, tierWindows],
  );
  const currentTierEndsAt = useMemo(
    () => (currentTier ? tierEndsAt(currentTier, tierWindows) : null),
    [currentTier, tierWindows],
  );

  /**
   * What the selected races cost, as LINE ITEMS.
   *
   * Not a bare total: the package covers the first four races as one figure,
   * and each race can carry its own surcharge, so a single number tells the
   * swimmer nothing about why it is that number. Every line is rendered.
   *
   * quoteSelection() mirrors public.quote_athlete_entries() — the selection is
   * not saved yet, so there are no entry rows to quote from, and round-tripping
   * on every checkbox would price races the swimmer has not committed to.
   */
  const priced = useMemo(() => {
    if (!settings || !currentTier || matrix.length === 0) return null;
    const selectedEvents = events.filter((ev) => drafts[ev.id]?.selected);
    if (selectedEvents.length === 0) return null;
    return quoteSelection({
      events: selectedEvents.map((ev) => ({
        id: ev.id,
        name: ev.name,
        surchargeEgp: ev.surchargeEgp ?? 0,
        isRelay: false,
      })),
      matrix,
      tier: currentTier,
      relaySwimmerPriceEgp: settings.relaySwimmerPriceEgp,
    });
  }, [events, drafts, settings, matrix, currentTier]);

  const eventsBySession = useMemo(() => {
    const groups = new Map<number, RegisterableEvent[]>();
    for (const ev of events) {
      const list = groups.get(ev.sessionNumber) ?? [];
      list.push(ev);
      groups.set(ev.sessionNumber, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b);
  }, [events]);

  const toggleEvent = (eventId: string) => {
    setDrafts((prev) => {
      const current = prev[eventId];
      const turningOn = !current?.selected;
      if (turningOn) {
        if (eventLimit == null) {
          setError(settingsError);
          return prev;
        }
        const selectedNow = Object.values(prev).filter((d) => d.selected).length;
        // Cap is per MEET, so events already entered in an earlier session
        // count against it too.
        if (!validateEventCount(selectedNow + 1, enteredCount, eventLimit).ok) {
          setError(maxEventsMessage(eventLimit));
          return prev;
        }
      }
      setError(null);
      return {
        ...prev,
        [eventId]: {
          ...(current ?? { timeInput: "", isNt: false, selected: false }),
          selected: turningOn,
        },
      };
    });
  };

  const toggleNt = (eventId: string) => {
    setDrafts((prev) => ({
      ...prev,
      [eventId]: { ...prev[eventId], selected: true, isNt: !prev[eventId]?.isNt },
    }));
  };

  const setTimeInput = (eventId: string, value: string) => {
    setDrafts((prev) => ({
      ...prev,
      [eventId]: { ...prev[eventId], selected: true, isNt: false, timeInput: value },
    }));
  };

  const selectedCount = Object.values(drafts).filter((d) => d.selected).length;

  /**
   * Join or leave a full race's queue.
   *
   * Position comes back from the database rather than being counted here: the
   * queue moves while the page is open, and a number computed client-side goes
   * stale the moment someone ahead withdraws.
   */
  const toggleWaitlist = async (eventId: string) => {
    if (!athlete) return;
    setWaitlistBusy(eventId);
    setError(null);
    try {
      const existing = waitlist.find((w) => w.eventId === eventId);
      if (existing) {
        const res = await leaveWaitlist(eventId, athlete.id);
        if (!res.success) throw new Error(res.error ?? "Could not leave the waitlist.");
        setWaitlist((prev) => prev.filter((w) => w.eventId !== eventId));
      } else {
        const res = await joinWaitlist(eventId, athlete.id);
        if (!res.success) throw new Error(res.error ?? "Could not join the waitlist.");
        const refreshed = await fetchAthleteWaitlist(athlete.id);
        setWaitlist(refreshed.data);
      }
    } catch (err) {
      setError(getErrorMessage(err, "Waitlist update failed."));
    } finally {
      setWaitlistBusy(null);
    }
  };

  const handleSubmit = async () => {
    if (!athlete || !volume) return;
    setError(null);

    const selections: EventSelection[] = Object.entries(drafts)
      .filter(([, d]) => d.selected)
      .map(([eventId, d]) => {
        const ev = events.find((e) => e.id === eventId);
        const seed = resolveSeedSource(
          { seedsAsNt: ev?.seedsAsNt === true },
          volume?.volume_number ?? 1,
          previousBest.get(eventId),
        );
        if (seed.source !== "declared") {
          // The database recomputes this on insert; sending it keeps the
          // optimistic UI honest rather than showing a time that then changes.
          return { eventId, seedsAsNt: ev?.seedsAsNt === true, isNt: seed.seedTimeMs == null, seedTimeMs: seed.seedTimeMs };
        }
        return {
          eventId,
          seedsAsNt: false,
          isNt: d.isNt,
          seedTimeMs: d.isNt ? null : parseTimeToMs(d.timeInput),
        };
      });

    // Only a volume-1 declared entry can be missing a time — everything else
    // is either looked up or legitimately NT.
    const invalidTime = selections.find(
      (s) =>
        !s.isNt &&
        s.seedTimeMs == null &&
        resolveSeedSource(
          { seedsAsNt: s.seedsAsNt === true },
          volume?.volume_number ?? 1,
          previousBest.get(s.eventId),
        ).source === "declared",
    );
    if (invalidTime) {
      setError(CLOCK_TIME_ERROR);
      return;
    }

    setSubmitting(true);
    try {
      const res = await submitEventRegistration({
        athleteId: athlete.id,
        parentLinkStatus: athlete.parentLinkStatus,
        safetyAcceptedAt: athlete.safetyAcceptedAt,
        meetVolumeId: volume.id,
        teamId,
        selections,
      });
      if (!res.success) {
        setError(res.error ?? "Failed to submit registration.");
        return;
      }
      setSuccess(true);
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col items-center justify-center gap-4 p-4 text-center">
        <CheckCircle2 className="size-12 text-emerald-500" />
        <h1 className="text-2xl font-bold">Entries submitted!</h1>
        <Badge variant="outline" className="gap-1.5 text-sm">
          <Banknote className="size-3.5" />
          Cash Payment Pending on Deck
        </Badge>
        <p className="text-sm text-muted-foreground">
          Your {selectedCount} {selectedCount === 1 ? "entry" : "entries"} for {volume?.name} are booked.
          {priced ? (
            <>
              {" "}
              Bring <strong>{formatEgp(priced.totalEgp)} in cash</strong> to the meet desk on
              deck — an admin will confirm payment there.
            </>
          ) : (
            " Pay cash at the meet desk on deck — the amount could not be loaded, so ask an admin to confirm it there."
          )}
        </p>
        <Button className="min-h-[48px] w-full" nativeButton={false} render={<Link href="/" />}>
          Back to home
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <Link href="/" className="flex min-h-[48px] items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        All Events
      </Link>

      <DataErrorBanner error={dataError} subject="the event schedule" />
      {/* No price, no entries. Registration is a commitment to pay a specific
          amount on deck, so a form that cannot state the amount must say so
          rather than quote a familiar-looking number. */}
      <DataErrorBanner error={settingsError} subject="entry pricing" />

      <header>
        <h1 className="text-xl font-bold sm:text-2xl">{volume?.name ?? "Meet"} — Event Registration</h1>
        <p className="text-sm text-muted-foreground">
          Select your races, enter Long Course seed times, and choose your team representation.
        </p>
        {eventLimit != null && (
          <Badge variant="outline" className="mt-2 gap-1.5 py-1">
            <ListChecks className="size-3.5" />
            {selectedCount + enteredCount} of {eventLimit} events used
          </Badge>
        )}
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : authError ? (
        <Alert variant="destructive">
          <AlertDescription>{authError}</AlertDescription>
        </Alert>
      ) : (
        <>
          {!entryGate.ok && (
            <Alert variant="destructive">
              <AlertDescription className="space-y-2">
                <p>{entryGate.error}</p>
                {/* A 15+ swimmer accepts for themselves. U14s cannot — the
                    RPC refuses, so no button is offered to them. */}
                {athlete && athlete.safetyAcceptedAt === null && !needsParentAcceptance && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-[44px] gap-2"
                    disabled={acceptingSafety}
                    onClick={() => void handleAcceptSafety()}
                  >
                    {acceptingSafety && <Loader2 className="size-4 animate-spin" />}
                    I accept the safety &amp; privacy terms
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Team representation</CardTitle>
              <CardDescription>For this volume only — you may transfer for future volumes.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant={teamId === null ? "default" : "outline"}
                className="min-h-[48px]"
                onClick={() => setTeamId(null)}
              >
                Unattached
              </Button>
              {teams.map((team) => (
                <Button
                  key={team.id}
                  type="button"
                  variant={teamId === team.id ? "default" : "outline"}
                  className="min-h-[48px]"
                  onClick={() => setTeamId(team.id)}
                >
                  {team.name}
                </Button>
              ))}
            </CardContent>
          </Card>

          {eventsBySession.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center text-sm text-muted-foreground">
                No events available for registration yet.
              </CardContent>
            </Card>
          ) : (
            eventsBySession.map(([sessionNumber, sessionEvents]) => (
              <Card key={sessionNumber}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">Session {sessionNumber}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {sessionEvents.map((ev) => {
                    const draft = drafts[ev.id];
                    const alreadyEntered = enteredEventIds.has(ev.id);
                    const capacity = capacities.get(ev.id);
                    const isFull = capacity?.availability === "full";
                    const queued = waitlist.find((w) => w.eventId === ev.id);
                    return (
                      <div key={ev.id} className="space-y-2 rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0">
                            <span className="font-medium">
                              {ev.distanceM}m {ev.stroke}
                            </span>
                            {/* Availability is stated on every race, not only
                                on full ones. A swimmer choosing between twenty
                                races needs to know which are about to go, and
                                a badge that only ever appears when it is too
                                late tells them nothing in time. */}
                            {capacity && (
                              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                                <Badge
                                  variant={availabilityVariant(capacity.availability)}
                                  className="text-[10px]"
                                  data-testid={`availability-${ev.id}`}
                                >
                                  {AVAILABILITY_LABELS[capacity.availability]}
                                </Badge>
                                <span className="text-[11px] text-muted-foreground">
                                  {describeAvailability(capacity)}
                                </span>
                              </span>
                            )}
                            {ev.surchargeEgp > 0 && (
                              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                                +{ev.surchargeEgp} EGP surcharge on this race
                              </span>
                            )}
                          </span>

                          {alreadyEntered ? (
                            <Badge variant="outline" className="h-9 shrink-0 px-4">
                              Already Entered
                            </Badge>
                          ) : isFull && !draft?.selected ? (
                            // Full races cannot be selected. Offering a
                            // Select button that fails on submit would waste
                            // the swimmer's time and lose their other picks.
                            <Button
                              type="button"
                              size="sm"
                              variant={queued ? "secondary" : "outline"}
                              className="min-h-[48px] shrink-0 px-4"
                              disabled={waitlistBusy === ev.id || !athlete}
                              onClick={() => void toggleWaitlist(ev.id)}
                            >
                              {waitlistBusy === ev.id ? (
                                <Loader2 className="size-4 animate-spin" />
                              ) : queued ? (
                                `Waiting — #${queued.position ?? "?"}`
                              ) : (
                                "Join waitlist"
                              )}
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant={draft?.selected ? "default" : "outline"}
                              className="min-h-[48px] shrink-0 px-4"
                              disabled={!draft?.selected && selectedCount >= remainingSlots}
                              onClick={() => toggleEvent(ev.id)}
                            >
                              {draft?.selected ? "Selected" : "Select"}
                            </Button>
                          )}
                        </div>
                        {!alreadyEntered && draft?.selected && (
                          seedFor(ev).source === "nt" ? (
                            // Nothing to ask for: either the event has no
                            // long course equivalent to declare a time from,
                            // or (volume 2+) the swimmer has never swum it.
                            <p className="text-xs text-muted-foreground">
                              <span className="font-bold text-foreground">Entered as NT.</span>{" "}
                              {ev.seedsAsNt
                                ? "This event has no official long course equivalent, so there is no comparable time to declare."
                                : "You haven't swum this event at a previous SSC volume."}{" "}
                              Seeding uses your best event&apos;s World Aquatics points.
                            </p>
                          ) : seedFor(ev).source === "historical" ? (
                            <p className="text-xs text-muted-foreground">
                              <span className="font-bold text-foreground">
                                Seeded at {formatTimeMs(seedFor(ev).seedTimeMs)}.
                              </span>{" "}
                              Your best official time for this event at a previous SSC volume —
                              times are taken from what you swam, not declared.
                            </p>
                          ) : (
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                              <ClockTimeInput
                                id={`seed-${ev.id}`}
                                label="Long Course seed time"
                                value={draft.timeInput}
                                disabled={draft.isNt}
                                className="min-w-0 flex-1"
                                onChange={(raw) => setTimeInput(ev.id, raw)}
                              />
                              <Button
                                type="button"
                                size="sm"
                                variant={draft.isNt ? "default" : "outline"}
                                className="min-h-[48px] px-4 sm:mt-7"
                                onClick={() => toggleNt(ev.id)}
                              >
                                NT
                              </Button>
                            </div>
                          )
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            ))
          )}

          {selectedCount > 0 && priced && currentTier && (
            <Card className="border-dashed">
              <CardContent className="space-y-3 py-4">
                {/* Every line, always. The requirement is that a swimmer can
                    see WHY the total is the total — which race costs what and
                    what the package covers — not just what it comes to. */}
                <dl className="space-y-1 text-sm">
                  {priced.lines.map((line, i) => (
                    <div key={`${line.kind}-${i}`} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">
                        <span className="opacity-60">{priceLineKindLabel(line.kind)}:</span>{" "}
                        {line.label}
                      </dt>
                      <dd className="shrink-0 tabular-nums">{formatEgp(line.amountEgp)}</dd>
                    </div>
                  ))}
                </dl>

                <div className="flex items-center justify-between border-t pt-2 text-sm">
                  <span className="font-medium">
                    Total at the {tierLabel(currentTier)} rate
                  </span>
                  <span className="text-lg font-bold tabular-nums">
                    {formatEgp(priced.totalEgp)}
                  </span>
                </div>

                {/* Said out loud, before they commit. The price is settled when
                    payment is collected, not when the entry is made, so a
                    swimmer who registers now and pays after the boundary pays
                    the later rate. Discovering that at the desk would be
                    indefensible. */}
                <p className="rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                  <strong>This price is set when you pay, not now.</strong>{" "}
                  {currentTierEndsAt
                    ? `The ${tierLabel(currentTier)} rate applies until ${currentTierEndsAt.toLocaleString()}. If you pay after that, you pay the next rate.`
                    : `You will be charged whichever rate is in force when an admin collects your payment.`}
                </p>

                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Banknote className="size-3.5 shrink-0" />
                  Pay cash on deck at the meet desk — no online payment required.
                </p>
              </CardContent>
            </Card>
          )}

          <Button
            type="button"
            className="min-h-[48px] w-full text-base font-semibold"
            disabled={submitting || selectedCount === 0 || !entryGate.ok || !priced}
            onClick={() => void handleSubmit()}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            Submit {selectedCount > 0 ? `${selectedCount} ` : ""}
            {selectedCount === 1 ? "Entry" : "Entries"}
            {selectedCount > 0 && priced ? ` — ${priced.totalEgp} EGP Cash on Deck` : ""}
          </Button>
        </>
      )}
    </main>
  );
}
