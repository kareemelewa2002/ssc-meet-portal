"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarPlus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useMyPortals } from "@/hooks/use-my-portals";
import { fetchMyLinkedChildren } from "@/lib/parents";
import { fetchMeetRegistrationCta, type MeetRegistrationCta } from "@/lib/meet-registration-cta";

/**
 * "Enter the live meet", on the home page, for accounts that still can.
 *
 * Registration previously had no entry point from the landing view at all —
 * it was reachable only by going to /meets, opening the volume, and finding
 * the button on the schedule tab. The single most time-critical action in the
 * product was three navigations deep behind a deadline.
 *
 * Renders nothing once every athlete on the account is entered, so it
 * disappears the moment it stops being useful rather than nagging someone who
 * has already done it. See lib/meet-registration-cta.ts for the full set of
 * conditions.
 */
export function MeetRegistrationCta({ outdoorMode }: { outdoorMode: boolean }) {
  const { user, loading: userLoading } = useCurrentUser();
  const { athleteId, isParent, loading: portalsLoading } = useMyPortals();
  const [cta, setCta] = useState<MeetRegistrationCta | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Wait for both the session and the portal facts. Running early would
      // decide "no athletes on this account" before either had resolved and
      // hide the card from the swimmers who most need it.
      if (userLoading || portalsLoading || !user) return;

      const children = isParent ? (await fetchMyLinkedChildren(user.id)).data : [];
      const result = await fetchMeetRegistrationCta({
        athleteId,
        children: children.map((c) => ({ athleteId: c.athleteId, fullName: c.fullName })),
        ownName: user.fullName,
      });
      if (!cancelled) setCta(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userLoading, portalsLoading, athleteId, isParent]);

  if (!cta) return null;

  const names = cta.unenteredNames;
  const description = cta.onBehalfOfChildren
    ? // Named, not counted: a parent of three needs to know WHICH child is
      // still missing, which a bare "1 child" does not answer.
      `${listNames(names)} ${names.length === 1 ? "is" : "are"} not entered yet.`
    : "You haven't entered this meet yet.";

  return (
    <Link href={cta.href} className="block min-h-[48px]">
      <Card
        className={cn(
          "transition-all hover:-translate-y-1 hover:shadow-brutal-lg active:translate-y-0 active:shadow-brutal",
          outdoorMode ? "border-yellow-300/60 bg-black" : "border-neon-orange/60 bg-neon-orange/10",
        )}
      >
        <CardContent className="flex items-center gap-3 py-4">
          <div
            className={cn(
              "flex size-11 shrink-0 items-center justify-center rounded-xl border-2 border-border-strong",
              outdoorMode ? "bg-yellow-300 text-black" : "bg-neon-orange text-black",
            )}
          >
            <CalendarPlus className="size-5" />
          </div>
          <div className="min-w-0">
            <p className={cn("font-bold tracking-tight", outdoorMode && "text-yellow-300")}>
              Register for {cta.volume.name}
            </p>
            <p
              className={cn("text-xs", outdoorMode ? "text-yellow-100/70" : "text-muted-foreground")}
            >
              {description} Pick your races and pay cash at the desk on deck.
            </p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

/** "Amir", "Amir and Layla", "Amir, Layla and Nour". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
