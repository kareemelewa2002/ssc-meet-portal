"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Banknote, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { createClient } from "@/lib/supabase/client";
import { fetchVolumeByNumber } from "@/lib/volumes";
import { fetchTeams } from "@/lib/teams";
import { canSubmitEntries } from "@/lib/register";
import {
  RACE_PRICE_EGP,
  computeRegistrationTotalEgp,
  fetchAthleteEnteredEventIds,
  fetchRegisterableEvents,
  submitEventRegistration,
  type EventSelection,
  type RegisterableEvent,
} from "@/lib/event-registration";
import { CLOCK_TIME_ERROR, parseTimeToMs } from "@/lib/format";
import { ClockTimeInput } from "@/components/ui/clock-time-input";
import type { MeetVolumeRow, ParentLinkStatus, TeamRow } from "@/lib/supabase/types";
import { DataErrorBanner } from "@/components/ui/data-error-banner";

interface EventDraft {
  selected: boolean;
  isNt: boolean;
  timeInput: string;
}

interface CurrentAthlete {
  id: string;
  parentLinkStatus: ParentLinkStatus;
  approvedByAdmin: boolean;
}

export function EventRegistrationClient({ volId }: { volId: string }) {
  const [volume, setVolume] = useState<MeetVolumeRow | null>(null);
  const [events, setEvents] = useState<RegisterableEvent[]>([]);
  const [teams, setTeams] = useState<TeamRow[]>([]);
  const [athlete, setAthlete] = useState<CurrentAthlete | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataError, setDataError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [enteredEventIds, setEnteredEventIds] = useState<Set<string>>(new Set());

  const [drafts, setDrafts] = useState<Record<string, EventDraft>>({});
  const [teamId, setTeamId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const volResult = await fetchVolumeByNumber(volId);
      if (cancelled) return;
      setVolume(volResult.data);
      if (volResult.error) setDataError(volResult.error);

      let loadedEvents: RegisterableEvent[] = [];
      if (volResult.data) {
        const [ev, tm] = await Promise.all([
          fetchRegisterableEvents(volResult.data.id),
          fetchTeams(),
        ]);
        loadedEvents = ev;
        if (!cancelled) {
          setEvents(ev);
          setTeams(tm.data.filter((t) => t.approved_by_admin));
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
          .select("id, parent_link_status, approved_by_admin")
          .eq("user_id", user.id)
          .maybeSingle();
        if (!athleteRow) {
          if (!cancelled) setAuthError("Only athlete accounts can register for meet events.");
          return;
        }
        if (!cancelled) {
          setAthlete({
            id: athleteRow.id,
            parentLinkStatus: athleteRow.parent_link_status,
            approvedByAdmin: athleteRow.approved_by_admin,
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
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [volId]);

  const entryGate = useMemo(
    () =>
      athlete
        ? canSubmitEntries({
            parentLinkStatus: athlete.parentLinkStatus,
            approvedByAdmin: athlete.approvedByAdmin,
          })
        : { ok: true as const },
    [athlete],
  );

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
    if (enteredEventIds.has(eventId)) return;
    setDrafts((prev) => {
      const existing = prev[eventId];
      return {
        ...prev,
        [eventId]: existing?.selected
          ? { ...existing, selected: false }
          : { selected: true, isNt: existing?.isNt ?? false, timeInput: existing?.timeInput ?? "" },
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

  const handleSubmit = async () => {
    if (!athlete || !volume) return;
    setError(null);

    const selections: EventSelection[] = Object.entries(drafts)
      .filter(([, d]) => d.selected)
      .map(([eventId, d]) => ({
        eventId,
        isNt: d.isNt,
        seedTimeMs: d.isNt ? null : parseTimeToMs(d.timeInput),
      }));

    const invalidTime = selections.find((s) => !s.isNt && s.seedTimeMs == null);
    if (invalidTime) {
      setError(CLOCK_TIME_ERROR);
      return;
    }

    setSubmitting(true);
    try {
      const res = await submitEventRegistration({
        athleteId: athlete.id,
        parentLinkStatus: athlete.parentLinkStatus,
        approvedByAdmin: athlete.approvedByAdmin,
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
          Bring <strong>{computeRegistrationTotalEgp(selectedCount)} EGP in cash</strong> to the meet desk on
          deck — an admin will confirm payment there.
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

      <header>
        <h1 className="text-xl font-bold sm:text-2xl">{volume?.name ?? "Meet"} — Event Registration</h1>
        <p className="text-sm text-muted-foreground">
          Select your races, enter Long Course seed times, and choose your team representation.
        </p>
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
              <AlertDescription>{entryGate.error}</AlertDescription>
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
                    return (
                      <div key={ev.id} className="space-y-2 rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">
                            {ev.distanceM}m {ev.stroke}
                          </span>
                          {alreadyEntered ? (
                            <Badge variant="outline" className="h-9 px-4">
                              Already Entered
                            </Badge>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant={draft?.selected ? "default" : "outline"}
                              className="min-h-[48px] px-4"
                              onClick={() => toggleEvent(ev.id)}
                            >
                              {draft?.selected ? "Selected" : "Select"}
                            </Button>
                          )}
                        </div>
                        {!alreadyEntered && draft?.selected && (
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
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            ))
          )}

          {selectedCount > 0 && (
            <Card className="border-dashed">
              <CardContent className="space-y-2 py-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {selectedCount} {selectedCount === 1 ? "race" : "races"} × {RACE_PRICE_EGP} EGP
                  </span>
                  <span className="text-lg font-bold tabular-nums">
                    {computeRegistrationTotalEgp(selectedCount)} EGP
                  </span>
                </div>
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
            disabled={submitting || selectedCount === 0 || !entryGate.ok}
            onClick={() => void handleSubmit()}
          >
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            Submit {selectedCount > 0 ? `${selectedCount} ` : ""}
            {selectedCount === 1 ? "Entry" : "Entries"}
            {selectedCount > 0 ? ` — ${computeRegistrationTotalEgp(selectedCount)} EGP Cash on Deck` : ""}
          </Button>
        </>
      )}
    </main>
  );
}
