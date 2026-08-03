"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getErrorMessage } from "@/lib/utils";
import {
  buildSkinsQualifierBoards,
  populateSkinsHeatSheets,
  type CategoryQualifierBoard,
  type SkinsCandidate,
} from "@/lib/skins-qualification";
import type { DraftHeat } from "@/lib/seeding";
import type { SkinsQualifierRpcRow, SkinsResponse } from "@/lib/supabase/types";

export interface UseSkinsQualifiersResult {
  boards: CategoryQualifierBoard[];
  candidates: SkinsCandidate[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  respond: (athleteId: string, category: SkinsCandidate["category"], response: Exclude<SkinsResponse, "pending">) => Promise<void>;
  syncInvitations: () => Promise<number>;
  buildHeatSheets: () => DraftHeat[];
}

function mapRpcRow(row: SkinsQualifierRpcRow): SkinsCandidate {
  return {
    athleteId: row.athlete_id,
    athleteName: row.athlete_name,
    teamName: row.team_name,
    category: row.category,
    gender: row.gender,
    sourceRank: row.source_rank,
    bestTimeMs: row.best_time_ms,
    response: row.response,
  };
}

/**
 * Loads Skins qualifiers for a Session 3 skins event via
 * `get_skins_qualifiers`, exposes accept/decline, and can build heat sheets
 * from confirmed (accepted) athletes.
 */
export function useSkinsQualifiers(skinsEventId: string | null): UseSkinsQualifiersResult {
  const [candidates, setCandidates] = useState<SkinsCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!skinsEventId) {
      setCandidates([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { data, error: rpcError } = await supabase.rpc("get_skins_qualifiers", {
        event_id_param: skinsEventId,
      });
      if (rpcError) throw rpcError;
      setCandidates((data ?? []).map(mapRpcRow));
    } catch (err) {
      setError(getErrorMessage(err, "Failed to load Skins qualifiers."));
    } finally {
      setLoading(false);
    }
  }, [skinsEventId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const respond = useCallback(
    async (
      athleteId: string,
      category: SkinsCandidate["category"],
      response: Exclude<SkinsResponse, "pending">,
    ) => {
      if (!skinsEventId) throw new Error("No skins event selected.");
      const supabase = createClient();
      const { error: updateError } = await supabase
        .from("skins_qualifications")
        .update({
          response,
          responded_at: new Date().toISOString(),
        })
        .eq("skins_event_id", skinsEventId)
        .eq("athlete_id", athleteId)
        .eq("category", category);
      if (updateError) throw updateError;

      // Optimistic local update; rollover recomputed from boards helper.
      setCandidates((prev) =>
        prev.map((c) =>
          c.athleteId === athleteId && c.category === category ? { ...c, response } : c,
        ),
      );
      await refresh();
    },
    [skinsEventId, refresh],
  );

  const syncInvitations = useCallback(async () => {
    if (!skinsEventId) return 0;
    const supabase = createClient();
    const { data, error: syncError } = await supabase.rpc("sync_skins_invitations", {
      event_id_param: skinsEventId,
    });
    if (syncError) throw syncError;
    await refresh();
    return data ?? 0;
  }, [skinsEventId, refresh]);

  const boards = buildSkinsQualifierBoards(candidates);

  const buildHeatSheets = useCallback(() => {
    const accepted = candidates.filter((c) => c.response === "accepted");
    return populateSkinsHeatSheets(accepted);
  }, [candidates]);

  return {
    boards,
    candidates,
    loading,
    error,
    refresh,
    respond,
    syncInvitations,
    buildHeatSheets,
  };
}
