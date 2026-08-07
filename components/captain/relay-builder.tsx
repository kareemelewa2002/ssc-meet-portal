"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, Users } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterSelect } from "@/components/events/filter-select";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { AthleteLink } from "@/components/athletes/athlete-link";
import { useToast } from "@/hooks/use-toast";
import { fetchVolumeByNumber } from "@/lib/volumes";
import { fetchMeetSettings, type MeetSettings } from "@/lib/meet-settings";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import {
  RELAY_LEGS,
  createRelaySquad,
  deleteRelaySquad,
  fetchRelayCandidates,
  fetchRelayEvents,
  fetchTeamSquads,
  genderRequirement,
  legStroke,
  nextSquadLetter,
  relaySquadFeeEgp,
  validateSquad,
  type RelayCandidate,
  type RelayEvent,
  type RelaySquadView,
} from "@/lib/relays";
import type { AgeGroup } from "@/lib/supabase/types";

const AGE_GROUPS: AgeGroup[] = ["U14", "U17", "Open"];

/**
 * Lets a team captain build relay squads.
 *
 * An athlete can enter individual races unattached, but a relay is a team
 * entry, so this is the only route into one — and only the captain of that
 * team (or an admin) can use it, enforced by RLS rather than by hiding a
 * button.
 */
export function RelayBuilder({ teams }: { teams: { id: string; name: string }[] }) {
  const toast = useToast();
  const [volumeId, setVolumeId] = useState<string | null>(null);
  const [volumeName, setVolumeName] = useState<string>("this meet");
  // Per-swimmer relay fee from the Control Unit. Null means it could not be
  // read, and the fee line says so rather than quoting a stale figure.
  const [settings, setSettings] = useState<MeetSettings | null>(null);
  const [teamId, setTeamId] = useState<string>(teams[0]?.id ?? "");
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [eventId, setEventId] = useState<string>("");
  const [ageGroup, setAgeGroup] = useState<AgeGroup>("Open");
  const [candidates, setCandidates] = useState<RelayCandidate[]>([]);
  const [squads, setSquads] = useState<RelaySquadView[]>([]);
  const [legs, setLegs] = useState<(string | null)[]>(Array(RELAY_LEGS).fill(null));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busySquadId, setBusySquadId] = useState<string | null>(null);

  const event = events.find((e) => e.id === eventId) ?? null;

  // The relay fee is per SWIMMER, flat across the meet: it is not tiered and
  // does not vary by session, so there is nothing to look up per event. null
  // until the settings load, and the quote is withheld rather than guessed —
  // a plausible price standing in for a failed read is the failure mode
  // lib/fetch-policy.ts exists to prevent.
  const relayPriceEgp = settings?.relaySwimmerPriceEgp ?? null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The relay programme belongs to a meet, so resolve the current one.
      const vol = await fetchVolumeByNumber("1");
      if (cancelled || !vol.data) return;
      setVolumeId(vol.data.id);
      setVolumeName(vol.data.name);
      const [ev, cfg] = await Promise.all([
        fetchRelayEvents(vol.data.id),
        fetchMeetSettings(vol.data.id),
      ]);
      if (cancelled) return;
      setEvents(ev.data);
      setSettings(cfg.data);
      setError(ev.error ?? cfg.error);
      if (ev.data.length > 0) setEventId((prev) => prev || ev.data[0].id);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!volumeId || !teamId || !eventId) return;
    const [cand, sq] = await Promise.all([
      fetchRelayCandidates(teamId, volumeId, eventId),
      fetchTeamSquads(teamId, volumeId),
    ]);
    setCandidates(cand.data);
    setSquads(sq.data);
    setError(cand.error ?? sq.error);
  }, [volumeId, teamId, eventId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Rebuilding a squad for a different event/age means the picks no longer apply.
  useEffect(() => {
    setLegs(Array(RELAY_LEGS).fill(null));
  }, [eventId, ageGroup, teamId]);

  const draft = useMemo(
    () => ({ eventName: event?.name ?? "", ageGroup, legs }),
    [event, ageGroup, legs],
  );
  const validation = useMemo(() => validateSquad(draft, candidates), [draft, candidates]);
  const need = event ? genderRequirement(event.name) : { male: 2, female: 2 };

  // Selectable for a given leg: on the team, in the squad's age group, not
  // already committed to this relay, and not already on another leg here.
  const optionsForLeg = (legIndex: number) =>
    candidates
      .filter((c) => c.ageGroup === ageGroup)
      .filter((c) => c.takenBySquad === null)
      .filter((c) => !legs.some((id, i) => id === c.athleteId && i !== legIndex))
      .map((c) => ({
        value: c.athleteId,
        label: `${c.fullName} · ${c.gender === "male" ? "M" : "F"}${
          c.enteredInMeet ? "" : " · not entered"
        }`,
      }));

  const squadsForEvent = squads.filter((s) => s.eventId === eventId);

  const submit = async () => {
    if (!event || !validation.ok) return;
    setSaving(true);
    try {
      const res = await createRelaySquad({
        eventId: event.id,
        teamId,
        ageGroup,
        squadLetter: nextSquadLetter(squadsForEvent.map((s) => s.squadLetter)),
        athleteIdsByLeg: legs.filter((id): id is string => id !== null),
      });
      if (!res.success) {
        toast.error("Couldn't enter the squad", res.error ?? "Unknown error");
        return;
      }
      setLegs(Array(RELAY_LEGS).fill(null));
      await reload();
      toast.success("Relay squad entered", "It sits pending payment until an admin confirms it.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (squadId: string) => {
    setBusySquadId(squadId);
    try {
      const res = await deleteRelaySquad(squadId);
      if (!res.success) {
        toast.error("Couldn't remove the squad", res.error ?? "Unknown error");
        return;
      }
      await reload();
      toast.success("Squad removed");
    } finally {
      setBusySquadId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="size-5" />
          Relay squads
        </CardTitle>
        <CardDescription>
          A relay is a team entry, so only a captain can enter one. Every swimmer must be on your
          team, in the squad&apos;s age group, and already entered in {volumeName}. Enter as many
          squads as you can fill — a swimmer can only be in one squad per relay.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataErrorBanner error={error} subject="relay data" onRetry={() => void reload()} />

        <div className="flex flex-wrap gap-4">
          {teams.length > 1 && (
            <FilterSelect
              label="Team"
              allowAll={false}
              value={teamId}
              onChange={(v) => v && setTeamId(v)}
              outdoorMode={false}
              options={teams.map((t) => ({ value: t.id, label: t.name }))}
            />
          )}
          <FilterSelect
            label="Relay"
            allowAll={false}
            value={eventId}
            onChange={(v) => v && setEventId(v)}
            outdoorMode={false}
            options={events.map((e) => ({ value: e.id, label: `S${e.sessionNumber} · ${e.name}` }))}
          />
          <FilterSelect<AgeGroup>
            label="Age group"
            allowAll={false}
            value={ageGroup}
            onChange={(v) => v && setAgeGroup(v)}
            outdoorMode={false}
            options={AGE_GROUPS.map((g) => ({ value: g, label: AGE_GROUP_LABELS[g] }))}
          />
        </div>

        {event && (
          <div className="space-y-3 rounded-xl border-2 border-border-strong p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{need.male} male</Badge>
              <Badge>{need.female} female</Badge>
              <Badge variant="outline">{AGE_GROUP_LABELS[ageGroup]}</Badge>
              <span className="text-muted-foreground">
                {relayPriceEgp == null
                  ? "Squad fee unavailable — ask an admin at the desk"
                  : `${relaySquadFeeEgp(relayPriceEgp)} EGP (${RELAY_LEGS} × ${relayPriceEgp} EGP race fee), payable at the desk`}
              </span>
            </div>

            {Array.from({ length: RELAY_LEGS }, (_, i) => {
              const stroke = legStroke(event.stroke, i + 1);
              return (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[5.5rem]">
                    <p className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
                      Leg {i + 1}
                    </p>
                    {/* Medley order is fixed, so the leg IS the stroke — the
                        captain's choice is who swims it. */}
                    <p className="text-sm font-bold">{stroke ?? "Freestyle"}</p>
                  </div>
                  <FilterSelect
                    label={`Swimmer for leg ${i + 1}`}
                    allowAll={false}
                    className="flex-1"
                    value={legs[i]}
                    onChange={(v) =>
                      setLegs((prev) => prev.map((id, idx) => (idx === i ? v : id)))
                    }
                    outdoorMode={false}
                    options={optionsForLeg(i)}
                  />
                </div>
              );
            })}

            {validation.errors.length > 0 && (
              <ul className="space-y-1 text-sm text-muted-foreground">
                {validation.errors.map((e) => (
                  <li key={e}>• {e}</li>
                ))}
              </ul>
            )}

            <Button
              type="button"
              className="min-h-[48px] gap-2"
              disabled={!validation.ok || saving}
              onClick={() => void submit()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Enter squad {nextSquadLetter(squadsForEvent.map((s) => s.squadLetter))}
            </Button>
          </div>
        )}

        {squadsForEvent.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-bold">Entered for this relay</p>
            {squadsForEvent.map((squad) => (
              <div key={squad.id} className="space-y-2 rounded-xl border-2 border-border-strong p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>Squad {squad.squadLetter}</Badge>
                    <Badge variant="outline">{AGE_GROUP_LABELS[squad.ageGroup]}</Badge>
                    <Badge variant={squad.status === "confirmed" ? "default" : "secondary"}>
                      {squad.status === "confirmed" ? "Paid" : "Pending payment"}
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-[48px] gap-1 text-sm"
                    disabled={busySquadId === squad.id || squad.status === "confirmed"}
                    onClick={() => void remove(squad.id)}
                    title={
                      squad.status === "confirmed"
                        ? "Paid squads can only be changed by an admin"
                        : undefined
                    }
                  >
                    {busySquadId === squad.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                    Remove
                  </Button>
                </div>
                <ol className="space-y-1 text-sm">
                  {squad.legs.map((leg) => (
                    <li key={leg.legNumber} className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">Leg {leg.legNumber}</span>
                      {leg.stroke && (
                        <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                          {leg.stroke}
                        </Badge>
                      )}
                      <AthleteLink athleteId={leg.athleteId} name={leg.athleteName} />
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
