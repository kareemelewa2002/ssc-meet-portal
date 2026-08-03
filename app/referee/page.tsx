"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { HeatResultEntry } from "@/components/referee/heat-result-entry";
import { FilterPillGroup } from "@/components/events/filter-pill-group";
import { AppHeader } from "@/components/layout/app-header";
import { createClient } from "@/lib/supabase/client";
import { firstOf } from "@/lib/live-heats";
import type { Gender, HeatGroup, PublishStatus, SessionRow } from "@/lib/supabase/types";
import { heatTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

type RawDeckEvent = {
  name: string;
  event_order: number;
  session_id: string;
  stroke: string;
  distance_m: number;
  is_skins: boolean;
};

type RawAthlete = {
  id: string;
  users: { full_name: string } | { full_name: string }[] | null;
  teams: { name: string } | { name: string }[] | null;
};

/** One heat, with everything needed to render and score it in place. */
interface RefereeDeckHeat {
  heatId: string;
  heatNumber: number;
  heatGroup: HeatGroup;
  /** null only for legacy heats seeded before male/female were split. */
  gender: Gender | null;
  status: PublishStatus;
  eventId: string;
  eventName: string;
  eventOrder: number;
  sessionId: string | null;
  sessionNumber: number | null;
  /** True when this event is the one Skins qualification is drawn from, so an
   * NS here genuinely costs a swimmer their Skins place. Computed by matching
   * the Skins event's own stroke and distance rather than assuming freestyle —
   * a later volume may run Skins on a different stroke. */
  feedsSkins: boolean;
  lanes: RefereeLane[];
}

// Satisfies HeatResultEntry's HeatLaneAthlete, which treats athleteId as
// optional for a lane that might not have a seeded entry yet.
interface RefereeLane {
  heatLaneId: string;
  laneNumber: number;
  athleteName: string;
  athleteId: string;
  teamName?: string;
  seedTimeMs?: number | null;
  entryId?: string;
}

/**
 * NO DEMO FALLBACK.
 *
 * This page used to seed itself with six hard-coded swimmers so it looked
 * populated before any real data loaded. Those placeholders were given
 * RFC4122-shaped ids to get past the uuid column type — which meant they also
 * sailed past isValidUuid() and reached the database, where they failed the
 * foreign key instead ("results_heat_lane_id_fkey"). A referee could enter
 * times against swimmers who did not exist and only find out on submit.
 *
 * Validity is not existence. The deck now starts empty and says so, matching
 * the fail-loud policy in lib/fetch-policy.ts: never render something
 * scoreable that isn't real.
 */

/**
 * The consolidated Referee role's deck page: one screen covers call-room
 * lane assignment AND heat time entry (see AGENTS scope lock — usher/entry_helper/
 * chief_referee no longer exist as separate concepts). Any referee who opens
 * a heat has full write access to every lane; the terminal action is
 * submitting the completed card to the Admin review queue, never publishing
 * directly (see enforce_result_publish in supabase/schema.sql).
 */
export default function RefereePage() {
  const [outdoorMode, setOutdoorMode] = useState(false);

  const [deck, setDeck] = useState<RefereeDeckHeat[]>([]);
  const [loadingDeck, setLoadingDeck] = useState(true);
  // Filters, not gates: they narrow the stacked list, they do not decide
  // which single heat is visible.
  const [sessionFilter, setSessionFilter] = useState<string | null>(null);
  const [eventFilter, setEventFilter] = useState<string | null>(null);
  const [genderFilter, setGenderFilter] = useState<string | null>(null);
  const [unscoredOnly, setUnscoredOnly] = useState(false);

  // The deck loader needs session numbers to order heats the way they are
  // swum; a ref avoids making the loader depend on (and re-run for) sessions.
  const sessionsRef = useRef<SessionRow[]>([]);

  const loadSchedule = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data: sess } = await supabase
        .from("sessions")
        .select("*")
        .order("session_number", { ascending: true });
      if (sess?.length) sessionsRef.current = sess;
    } catch {
      // Fail closed: an empty deck is honest, a fabricated one is not.
    }
  }, []);

  /**
   * Loads EVERY heat with its lanes in two queries, rather than drilling
   * session -> event -> heat one at a time.
   *
   * A referee on deck does not page through a picker to find the heat in
   * front of them; they scan down the sheet. So the deck lists all heats
   * stacked, and the pickers become filters that narrow the list instead of
   * gating it.
   */
  const loadDeck = useCallback(async () => {
    setLoadingDeck(true);
    try {
      const supabase = createClient();
      const { data: heatRows, error: heatError } = await supabase
        .from("heats")
        .select("id, heat_number, heat_group, gender, status, event_id, events ( name, event_order, session_id, stroke, distance_m, is_skins )")
        .order("heat_number", { ascending: true });

      if (heatError || !heatRows?.length) {
        setDeck([]);
        return;
      }

      type RawHeatRow = {
        id: string;
        heat_number: number;
        heat_group: HeatGroup;
        gender: Gender | null;
        status: PublishStatus;
        event_id: string;
        events: RawDeckEvent | RawDeckEvent[] | null;
      };

      const heatIds = (heatRows as unknown as RawHeatRow[]).map((h) => h.id);
      const { data: laneRows } = await supabase
        .from("heat_lanes")
        .select(
          // Qualify the FK — athletes has two (user_id and parent_id), so a
          // bare "users(...)" embed is ambiguous to PostgREST (PGRST201).
          "id, heat_id, lane_number, entries ( id, seed_time_ms, athletes ( id, users!athletes_user_id_fkey ( full_name ), teams ( name ) ) )",
        )
        .in("heat_id", heatIds)
        .order("lane_number", { ascending: true });

      type RawLaneRow = {
        id: string;
        heat_id: string;
        lane_number: number;
        entries:
          | { id: string; seed_time_ms: number | null; athletes: RawAthlete | RawAthlete[] | null }
          | { id: string; seed_time_ms: number | null; athletes: RawAthlete | RawAthlete[] | null }[]
          | null;
      };

      const lanesByHeat = new Map<string, RefereeLane[]>();
      for (const lane of (laneRows ?? []) as unknown as RawLaneRow[]) {
        const entry = firstOf(lane.entries);
        const athlete = entry ? firstOf(entry.athletes) : null;
        const user = athlete ? firstOf(athlete.users) : null;
        const team = athlete ? firstOf(athlete.teams) : null;
        if (!athlete || !user) continue;
        const list = lanesByHeat.get(lane.heat_id) ?? [];
        list.push({
          heatLaneId: lane.id,
          laneNumber: lane.lane_number,
          athleteName: user.full_name,
          athleteId: athlete.id,
          teamName: team?.name,
          seedTimeMs: entry?.seed_time_ms ?? null,
          entryId: entry?.id,
        });
        lanesByHeat.set(lane.heat_id, list);
      }

      // Which (stroke, distance) feeds Skins this volume — read from the
      // Skins event itself, never hard-coded to freestyle.
      const { data: skinsRows } = await supabase
        .from("events")
        .select("stroke, distance_m")
        .eq("is_skins", true)
        .limit(1);
      const skinsSource = skinsRows?.[0] ?? null;

      const sessionNumberById = new Map(sessionsRef.current.map((s) => [s.id, s.session_number]));
      const built: RefereeDeckHeat[] = (heatRows as unknown as RawHeatRow[])
        .map((h) => {
          const event = firstOf(h.events);
          return {
            heatId: h.id,
            heatNumber: h.heat_number,
            heatGroup: h.heat_group,
            gender: h.gender ?? null,
            status: h.status,
            eventId: h.event_id,
            eventName: event?.name ?? "Event",
            eventOrder: event?.event_order ?? 0,
            sessionId: event?.session_id ?? null,
            sessionNumber: sessionNumberById.get(event?.session_id ?? "") ?? null,
            feedsSkins:
              !!skinsSource &&
              !!event &&
              event.is_skins === false &&
              event.stroke === skinsSource.stroke &&
              event.distance_m === skinsSource.distance_m,
            lanes: (lanesByHeat.get(h.id) ?? []).sort((a, b) => a.laneNumber - b.laneNumber),
          };
        })
        // The order they are actually swum.
        .sort(
          (a, b) =>
            (a.sessionNumber ?? 0) - (b.sessionNumber ?? 0) ||
            a.eventOrder - b.eventOrder ||
            a.heatNumber - b.heatNumber,
        );

      setDeck(built);
    } catch {
      // Fail closed: an empty deck is honest, a fabricated one is not.
      setDeck([]);
    } finally {
      setLoadingDeck(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      // Schedule first: the deck orders heats by session number.
      await loadSchedule();
      await loadDeck();
    })();
  }, [loadSchedule, loadDeck]);

  const sessionNumbers = useMemo(
    () => [...new Set(deck.map((h) => h.sessionNumber).filter((n): n is number => n != null))].sort(),
    [deck],
  );
  const eventNames = useMemo(
    () => [...new Set(deck.map((h) => h.eventName))],
    [deck],
  );

  const visibleHeats = useMemo(
    () =>
      deck
        .filter((h) => !sessionFilter || String(h.sessionNumber) === sessionFilter)
        .filter((h) => !eventFilter || h.eventName === eventFilter)
        .filter((h) => !genderFilter || h.gender === genderFilter)
        .filter((h) => !unscoredOnly || h.status !== "published"),
    [deck, sessionFilter, eventFilter, genderFilter, unscoredOnly],
  );

  return (
    <div className={cn("min-h-screen", outdoorMode && "bg-black text-yellow-300")}>
      <AppHeader title="Referee Deck" className={cn(outdoorMode && "border-yellow-300/30 bg-black/95")} />
      <main
        className={cn(
          "mx-auto flex w-full max-w-3xl flex-col gap-4 p-3 pb-24 sm:p-6",
        )}
      >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className={cn("text-2xl font-bold tracking-tight", outdoorMode && "text-yellow-300")}>
            Referee heat entry
          </h1>
          <p className={cn("text-sm", outdoorMode ? "text-yellow-100/80" : "text-muted-foreground")}>
            Check in swimmers, enter times, and submit the heat card to Admin.
          </p>
        </div>
        <Button
          type="button"
          variant={outdoorMode ? "secondary" : "outline"}
          size="icon"
          className="size-11 min-h-[48px] min-w-[48px]"
          aria-pressed={outdoorMode}
          aria-label="Toggle high-contrast outdoor mode"
          onClick={() => setOutdoorMode((v) => !v)}
        >
          <Sun className="size-5" />
        </Button>
      </div>

      <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
        <CardHeader>
          <CardTitle className={outdoorMode ? "text-yellow-300" : undefined}>Filter the deck</CardTitle>
          <CardDescription className={outdoorMode ? "text-yellow-100/70" : undefined}>
            Every heat is listed below in the order it is swum. These narrow the list — they
            don&rsquo;t hide the rest of the meet behind a picker.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-4">
          {sessionNumbers.length > 1 && (
            <FilterPillGroup
              label="Session"
              value={sessionFilter}
              onChange={setSessionFilter}
              outdoorMode={outdoorMode}
              options={sessionNumbers.map((n) => ({ value: String(n), label: `S${n}` }))}
            />
          )}
          {eventNames.length > 1 && (
            <FilterPillGroup
              label="Event"
              value={eventFilter}
              onChange={setEventFilter}
              outdoorMode={outdoorMode}
              options={eventNames.map((n) => ({ value: n, label: n }))}
            />
          )}
          <FilterPillGroup
            label="Gender"
            value={genderFilter}
            onChange={setGenderFilter}
            outdoorMode={outdoorMode}
            options={[
              { value: "male", label: "Men" },
              { value: "female", label: "Women" },
            ]}
          />
          <div className="space-y-1.5">
            <Label>Show</Label>
            <Button
              type="button"
              variant={unscoredOnly ? "default" : "outline"}
              className="min-h-[48px]"
              aria-pressed={unscoredOnly}
              onClick={() => setUnscoredOnly((v) => !v)}
            >
              Not yet published
            </Button>
          </div>
        </CardContent>
      </Card>

      {loadingDeck ? (
        <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
          <CardContent className="py-8 text-center">
            <p className={cn("text-sm", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}>
              Loading the deck…
            </p>
          </CardContent>
        </Card>
      ) : visibleHeats.length === 0 ? (
        <Card className={cn(outdoorMode && "border-yellow-300/40 bg-black")}>
          <CardContent className="space-y-2 py-8 text-center">
            <p className={cn("font-bold", outdoorMode && "text-yellow-300")}>
              {deck.length === 0 ? "No heats seeded yet" : "No heats match this filter"}
            </p>
            <p
              className={cn(
                "mx-auto max-w-md text-sm",
                outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
              )}
            >
              {deck.length === 0
                ? "Heats are generated once an admin confirms a swimmer's payment. Nothing can be scored until then."
                : `${deck.length} heats in this meet — clear a filter to see them.`}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {visibleHeats.map((heat) => (
            <HeatResultEntry
              key={heat.heatId}
              heatId={heat.heatId}
              heatLabel={`${heat.eventName} — ${heatTitle(heat)}${
                heat.sessionNumber != null ? ` · Session ${heat.sessionNumber}` : ""
              }`}
              lanes={heat.lanes}
              outdoorMode={outdoorMode}
              feedsSkins={heat.feedsSkins}
            />
          ))}
        </div>
      )}
      </main>
    </div>
  );
}
