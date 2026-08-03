"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { SkinsKnockout, type SkinsSwimmer } from "@/components/admin/skins-knockout";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import { AGE_GROUP_LABELS } from "@/lib/athletes";
import { LANE_SEQUENCE } from "@/lib/seeding";
import { materialiseSkinsHeat, type SkinsLane } from "@/lib/skins-qualification";
import { formatTimeMs } from "@/lib/format";
import type { AgeGroup, Gender } from "@/lib/supabase/types";

/**
 * Loads the real Skins qualifiers and runs one board's bracket.
 *
 * The knockout component renders `initialSwimmers ?? []` and never fetched
 * anything itself, while the admin page mounted it with only an eventId — so
 * the bracket was permanently empty and always showed "Awaiting published
 * results", no matter how many results had actually been published. This is
 * the missing half.
 *
 * Skins is split by age group AND gender (men and women never race each
 * other), so there are six boards and only one can be on the blocks at a
 * time. The admin picks which one they are running.
 */
export function SkinsBoardRunner({ eventId, eventName }: { eventId: string; eventName?: string }) {
  const { boards, candidates, loading, error, refresh } = useSkinsQualifiers(eventId);
  const [selected, setSelected] = useState<`${AgeGroup}-${Gender}` | null>(null);
  const [lanes, setLanes] = useState<SkinsLane[]>([]);
  const [laneError, setLaneError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);

  // Only boards with somebody on them are worth offering.
  const populated = useMemo(
    () => boards.filter((b) => b.active.length > 0),
    [boards],
  );

  const activeBoard = useMemo(() => {
    if (populated.length === 0) return null;
    const key = selected ?? (`${populated[0].category}-${populated[0].gender}` as const);
    return populated.find((b) => `${b.category}-${b.gender}` === key) ?? populated[0];
  }, [populated, selected]);

  // The bracket can only be scored against REAL heat_lanes rows, so the board
  // is materialised before it is rendered. Placeholder ids would fail the UUID
  // check on publish and the round would score silently into nothing.
  const boardKey = activeBoard ? `${activeBoard.category}-${activeBoard.gender}` : null;
  const athleteIds = useMemo(
    () => (activeBoard ? activeBoard.active.slice(0, LANE_SEQUENCE.length).map((q) => q.athleteId) : []),
    [activeBoard],
  );

  const prepare = useCallback(async () => {
    if (!activeBoard || athleteIds.length === 0) {
      setLanes([]);
      return;
    }
    setPreparing(true);
    const res = await materialiseSkinsHeat(
      eventId,
      activeBoard.category,
      activeBoard.gender,
      athleteIds,
    );
    setLanes(res.data);
    setLaneError(res.error);
    setPreparing(false);
  }, [activeBoard, athleteIds, eventId]);

  useEffect(() => {
    void prepare();
    // boardKey, not activeBoard: switching boards should rebuild, but a
    // re-render with an equivalent board object should not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardKey, athleteIds.join(",")]);

  const swimmers: SkinsSwimmer[] = useMemo(() => {
    if (!activeBoard || lanes.length === 0) return [];
    const byAthlete = new Map(lanes.map((l) => [l.athleteId, l]));
    return activeBoard.active
      .slice(0, LANE_SEQUENCE.length)
      .map((q): SkinsSwimmer | null => {
        const lane = byAthlete.get(q.athleteId);
        if (!lane) return null;
        return {
          entryId: lane.entryId,
          athleteId: q.athleteId,
          athleteName: q.athleteName,
          teamName: q.teamName ?? undefined,
          laneNumber: lane.laneNumber,
          outcome: null,
          finishPlace: null,
        };
      })
      .filter((s): s is SkinsSwimmer => s !== null)
      .sort((a, b) => a.laneNumber - b.laneNumber);
  }, [activeBoard, lanes]);

  if (loading && candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">Loading Skins qualifiers…</p>;
  }

  return (
    <div className="space-y-4">
      <DataErrorBanner error={error} subject="Skins qualifiers" onRetry={() => void refresh()} />
      <DataErrorBanner error={laneError} subject="the Skins heat" onRetry={() => void prepare()} />

      {populated.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{eventName ?? "Skins"}</CardTitle>
            <CardDescription>
              Nobody has qualified yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Qualification is drawn from published results of the matching non-Skins event — the
              same stroke and distance as this Skins event, whatever that is for this volume.
              Publish that event&apos;s heat cards and the boards fill in automatically.
            </p>
            {candidates.length > 0 && (
              <p>
                {candidates.length} swimmer{candidates.length === 1 ? " has" : "s have"} a
                qualifying time, but none currently hold an active slot.
              </p>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Which board are you running?</CardTitle>
              <CardDescription>
                Men and women race separately in every age group, so each board runs its own
                bracket of six.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {populated.map((b) => {
                const key = `${b.category}-${b.gender}` as const;
                const isActive = activeBoard
                  ? `${activeBoard.category}-${activeBoard.gender}` === key
                  : false;
                return (
                  <Button
                    key={key}
                    type="button"
                    variant={isActive ? "default" : "outline"}
                    className="min-h-[48px] gap-2"
                    onClick={() => setSelected(key)}
                  >
                    {AGE_GROUP_LABELS[b.category]} {b.gender === "male" ? "Men" : "Women"}
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {b.active.length}
                    </Badge>
                  </Button>
                );
              })}
            </CardContent>
          </Card>

          {activeBoard?.swimOff && (
            <div className="rounded-md border-2 border-black bg-neon-orange/15 p-3 text-sm">
              <p className="font-bold">Swim-off required before this board can run.</p>
              <p>
                {activeBoard.swimOff.athletes.map((a) => a.athleteName).join(" and ")} are level on{" "}
                {formatTimeMs(activeBoard.swimOff.contestedTimeMs)}, contesting{" "}
                {activeBoard.swimOff.slotsRemaining === 1
                  ? "the last slot"
                  : `${activeBoard.swimOff.slotsRemaining} slots`}
                .
              </p>
            </div>
          )}

          {preparing && swimmers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Setting up the lanes…</p>
          ) : (
          <SkinsKnockout
            // Remounts when the board changes, so the bracket state does not
            // carry over from one field to another.
            key={activeBoard ? `${activeBoard.category}-${activeBoard.gender}` : "none"}
            eventId={eventId}
            eventName={
              activeBoard
                ? `${eventName ?? "Skins"} — ${AGE_GROUP_LABELS[activeBoard.category]} ${
                    activeBoard.gender === "male" ? "Men" : "Women"
                  }`
                : eventName
            }
            initialSwimmers={swimmers}
          />
          )}
        </>
      )}
    </div>
  );
}
