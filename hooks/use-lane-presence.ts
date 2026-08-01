"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  canClaimLane,
  type LaneNumber,
  type PresenceOccupant,
  type RefereeDeckMode,
} from "@/lib/referee-lanes";

export interface UseLanePresenceArgs {
  heatId: string;
  refereeId: string;
  refereeName: string;
}

export interface UseLanePresenceResult {
  occupants: PresenceOccupant[];
  mode: RefereeDeckMode;
  focusedLane: LaneNumber | null;
  claimError: string | null;
  selectMode: (mode: RefereeDeckMode, lane?: LaneNumber | null) => Promise<boolean>;
  release: () => Promise<void>;
}

type PresencePayload = {
  refereeId: string;
  refereeName: string;
  laneNumber: LaneNumber | null;
  mode: RefereeDeckMode;
};

function flattenPresence(
  state: Record<string, PresencePayload[] | undefined>,
): PresenceOccupant[] {
  const out: PresenceOccupant[] = [];
  for (const metas of Object.values(state)) {
    const meta = metas?.[0];
    if (!meta?.refereeId) continue;
    out.push({
      refereeId: meta.refereeId,
      refereeName: meta.refereeName,
      laneNumber: meta.laneNumber,
      mode: meta.mode,
    });
  }
  return out;
}

/**
 * Supabase Presence channel for deck-lane exclusive claims.
 * Falls back to local-only state when realtime/auth is unavailable.
 */
export function useLanePresence({
  heatId,
  refereeId,
  refereeName,
}: UseLanePresenceArgs): UseLanePresenceResult {
  const [occupants, setOccupants] = useState<PresenceOccupant[]>([]);
  const [mode, setMode] = useState<RefereeDeckMode>("observer");
  const [focusedLane, setFocusedLane] = useState<LaneNumber | null>(null);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [channelReady, setChannelReady] = useState(false);

  const channelName = useMemo(() => `heat-lane-locks:${heatId}`, [heatId]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(channelName, {
      config: { presence: { key: refereeId } },
    });

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<PresencePayload>();
      setOccupants(flattenPresence(state));
    });

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") setChannelReady(true);
    });

    return () => {
      void supabase.removeChannel(channel);
      setChannelReady(false);
    };
  }, [channelName, refereeId]);

  const track = useCallback(
    async (nextMode: RefereeDeckMode, lane: LaneNumber | null) => {
      const payload: PresencePayload = {
        refereeId,
        refereeName,
        laneNumber: nextMode === "lane" ? lane : null,
        mode: nextMode,
      };

      // Always update local occupants for demo / offline resilience.
      setOccupants((prev) => {
        const others = prev.filter((o) => o.refereeId !== refereeId);
        return [...others, payload];
      });

      if (!channelReady) return;

      try {
        const supabase = createClient();
        const channels = supabase.getChannels();
        const channel = channels.find((c) => c.topic.includes(channelName));
        if (channel) {
          await channel.track(payload);
        }
      } catch {
        // Local claim already applied.
      }
    },
    [channelReady, channelName, refereeId, refereeName],
  );

  const selectMode = useCallback(
    async (nextMode: RefereeDeckMode, lane: LaneNumber | null = null) => {
      setClaimError(null);

      if (nextMode === "lane") {
        if (lane == null) {
          setClaimError("Select a lane number (1–6).");
          return false;
        }
        const check = canClaimLane(occupants, lane, refereeId);
        if (!check.ok) {
          setClaimError(check.badge);
          return false;
        }
        setMode("lane");
        setFocusedLane(lane);
        await track("lane", lane);
        return true;
      }

      setMode(nextMode);
      setFocusedLane(null);
      await track(nextMode, null);
      return true;
    },
    [occupants, refereeId, track],
  );

  const release = useCallback(async () => {
    setMode("observer");
    setFocusedLane(null);
    setClaimError(null);
    setOccupants((prev) => prev.filter((o) => o.refereeId !== refereeId));
    if (!channelReady) return;
    try {
      const supabase = createClient();
      const channels = supabase.getChannels();
      const channel = channels.find((c) => c.topic.includes(channelName));
      if (channel) await channel.untrack();
    } catch {
      // ignore
    }
  }, [channelReady, channelName, refereeId]);

  return {
    occupants,
    mode,
    focusedLane,
    claimError,
    selectMode,
    release,
  };
}
