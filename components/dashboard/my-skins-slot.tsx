"use client";

import { useMemo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SkeletonRow } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { useSkinsQualifiers } from "@/hooks/use-skins-qualifiers";
import { formatTimeMs } from "@/lib/format";
import type { AgeGroup } from "@/lib/supabase/types";

const CATEGORY_LABELS: Record<AgeGroup, string> = {
  U14: "14 & Under",
  U17: "17 & Under",
  Open: "Open",
};

/**
 * The signed-in swimmer's OWN Skins slot, and nothing else.
 *
 * This replaces a card that published all six qualifier boards — every
 * category, both genders, every name and every accept/decline state — to
 * every athlete who opened their dashboard. That is a deck document: it is
 * what the referee and the admin running the roll call need, and it already
 * exists for them on /admin/seeding and the referee deck. On a personal
 * dashboard it answered a question nobody asked while burying the one that
 * matters — "am I in?" — inside a grid of other people's names.
 *
 * Renders nothing at all when this swimmer has no slot. An absent card is
 * the honest representation of "you did not qualify": a card saying so would
 * appear on every dashboard for the whole meet, telling most of the field
 * about a race they were never in.
 */
export function MySkinsSlot({ athleteId }: { athleteId: string | null }) {
  const skinsEventId = process.env.NEXT_PUBLIC_SKINS_EVENT_ID ?? null;
  const { boards, loading, error } = useSkinsQualifiers(skinsEventId);

  const mine = useMemo(() => {
    if (!athleteId) return null;
    for (const board of boards) {
      // Search every bucket, not just `active`: a waitlisted swimmer needs to
      // know they are next in line, and one who declined needs their own
      // dashboard to reflect that rather than looking like they never
      // qualified.
      const qualifier =
        board.active.find((q) => q.athleteId === athleteId) ??
        board.waitlisted.find((q) => q.athleteId === athleteId) ??
        board.declined.find((q) => q.athleteId === athleteId);
      if (!qualifier) continue;

      const inSwimOff =
        board.swimOff?.athletes.some((a) => a.athleteId === athleteId) ?? false;
      return { qualifier, board, inSwimOff };
    }
    return null;
  }, [boards, athleteId]);

  // No athlete row, no configured Skins event, or simply not a qualifier —
  // all three mean there is nothing to say here.
  if (!athleteId || !skinsEventId) return null;
  if (loading) return <SkeletonRow />;
  if (error) return <DataErrorBanner error={error} subject="your Skins slot" />;
  if (!mine) return null;

  const { qualifier, board, inSwimOff } = mine;
  const categoryLabel = `${CATEGORY_LABELS[qualifier.category]} ${
    qualifier.gender === "male" ? "Men" : "Women"
  }`;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle>Your Skins slot</CardTitle>
          {qualifier.response === "accepted" ? (
            <Badge className="border-neon-lime/60 bg-neon-lime/15 text-neon-lime" variant="outline">
              Accepted
            </Badge>
          ) : qualifier.response === "declined" ? (
            <Badge variant="outline" className="text-muted-foreground">
              Declined
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="border-neon-orange/60 bg-neon-orange/15 text-neon-orange"
            >
              Awaiting your answer
            </Badge>
          )}
        </div>
        <CardDescription>
          {categoryLabel} · qualified on {formatTimeMs(qualifier.bestTimeMs)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {inSwimOff ? (
          // Nobody holds a tied place until it has been raced for, so this
          // must not read as "you are in".
          <p className="rounded-md border-2 border-border-strong bg-neon-orange/15 p-2">
            <span className="font-bold">Swim-off required.</span> You are level on{" "}
            {formatTimeMs(board.swimOff!.contestedTimeMs)} with{" "}
            {board.swimOff!.athletes
              .filter((a) => a.athleteId !== athleteId)
              .map((a) => a.athleteName)
              .join(" and ")}
            . The place is decided in the water — report to the referee.
          </p>
        ) : qualifier.isActiveQualifier && qualifier.slotNumber != null ? (
          <p>
            You hold <span className="font-bold">slot #{qualifier.slotNumber}</span> of six in{" "}
            {categoryLabel}.
          </p>
        ) : qualifier.response === "declined" ? (
          <p className="text-muted-foreground">
            You declined this slot. It has passed to the next swimmer on the board.
          </p>
        ) : (
          <p>
            You are on the waitlist for {categoryLabel}. If a swimmer ahead of you declines, the
            slot rolls down to you.
          </p>
        )}

        {qualifier.response === "pending" && !inSwimOff && (
          <p className="text-muted-foreground">
            Skins slots are accepted or declined <span className="font-semibold">in person</span> at
            the venue — find an admin at the desk to confirm either way.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
