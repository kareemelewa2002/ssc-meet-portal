"use client";

import { useCallback, useEffect, useState } from "react";
import { Banknote, Building2, ClipboardCheck, UserRoundCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { describeError, failure, ok, type FetchResult } from "@/lib/fetch-policy";
import { RACE_PRICE_EGP } from "@/lib/event-registration";
import { SkeletonStat } from "@/components/ui/skeleton";
import { DataErrorBanner } from "@/components/ui/data-error-banner";

export interface AdminKpis {
  pendingSwimmers: number;
  unapprovedTeams: number;
  cashQueueCount: number;
  cashQueueEgp: number;
  draftHeatCards: number;
}

/** Four head:true counts + one small select — cheap enough to poll on focus,
 * and each is independently null-safe so one failing table never blanks the
 * whole strip. */
export async function fetchAdminKpis(): Promise<FetchResult<AdminKpis>> {
  const EMPTY: AdminKpis = {
    pendingSwimmers: 0,
    unapprovedTeams: 0,
    cashQueueCount: 0,
    cashQueueEgp: 0,
    draftHeatCards: 0,
  };
  try {
    const supabase = createClient();
    const [swimmers, teams, cash, drafts] = await Promise.all([
      supabase.from("athletes").select("*", { count: "exact", head: true }).eq("approved_by_admin", false),
      supabase.from("teams").select("*", { count: "exact", head: true }).eq("approved_by_admin", false),
      supabase.from("entries").select("*", { count: "exact", head: true }).eq("status", "pending_payment"),
      supabase.from("results").select("*", { count: "exact", head: true }).eq("status", "draft"),
    ]);

    const firstErr = swimmers.error ?? teams.error ?? cash.error ?? drafts.error;
    if (firstErr) return failure(describeError("Loading admin counters", firstErr), EMPTY);

    const cashCount = cash.count ?? 0;
    return ok({
      pendingSwimmers: swimmers.count ?? 0,
      unapprovedTeams: teams.count ?? 0,
      cashQueueCount: cashCount,
      // Every unpaid entry is one race at the flat deck price.
      cashQueueEgp: cashCount * RACE_PRICE_EGP,
      draftHeatCards: drafts.count ?? 0,
    });
  } catch (err) {
    return failure(describeError("Loading admin counters", err), EMPTY);
  }
}

interface Tile {
  key: keyof AdminKpis | "cash";
  label: string;
  value: string;
  /** Rendered smaller beside the figure (currency, units). */
  unit?: string;
  sub?: string;
  icon: typeof UserRoundCheck;
  /** Neon accent — only lights up when the counter is non-zero, so a clean
   * queue stays visually quiet and a backlog draws the eye. */
  accent: string;
  glow: string;
  active: boolean;
}

export function AdminKpiStrip({ className }: { className?: string }) {
  const [kpis, setKpis] = useState<AdminKpis | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetchAdminKpis();
    setKpis(res.data);
    setError(res.error);
  }, []);

  useEffect(() => {
    void load();
    // Counters go stale the moment an admin approves something in a tab
    // below, so refresh whenever the window regains focus.
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  if (error) {
    return <DataErrorBanner error={error} subject="admin counters" onRetry={() => void load()} className={className} />;
  }

  if (!kpis) {
    return (
      <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonStat key={i} />
        ))}
      </div>
    );
  }

  const tiles: Tile[] = [
    {
      key: "pendingSwimmers",
      label: "Pending Swimmers",
      value: String(kpis.pendingSwimmers),
      sub: kpis.pendingSwimmers === 0 ? "queue clear" : "awaiting approval",
      icon: UserRoundCheck,
      accent: "text-neon-cyan",
      glow: "shadow-[var(--shadow-brutal-cyan)]",
      active: kpis.pendingSwimmers > 0,
    },
    {
      key: "unapprovedTeams",
      label: "Unapproved Teams",
      value: String(kpis.unapprovedTeams),
      sub: kpis.unapprovedTeams === 0 ? "queue clear" : "awaiting approval",
      icon: Building2,
      accent: "text-neon-violet",
      glow: "shadow-[var(--shadow-brutal-violet)]",
      active: kpis.unapprovedTeams > 0,
    },
    {
      key: "cash",
      label: "Cash Queue",
      value: kpis.cashQueueEgp.toLocaleString(),
      unit: "EGP",
      sub: `${kpis.cashQueueCount} ${kpis.cashQueueCount === 1 ? "entry" : "entries"} on deck`,
      icon: Banknote,
      accent: "text-neon-orange",
      glow: "shadow-[var(--shadow-brutal-orange)]",
      active: kpis.cashQueueCount > 0,
    },
    {
      key: "draftHeatCards",
      label: "Draft Heat Cards",
      value: String(kpis.draftHeatCards),
      sub: kpis.draftHeatCards === 0 ? "none to review" : "awaiting publish",
      icon: ClipboardCheck,
      accent: "text-neon-lime",
      glow: "shadow-[var(--shadow-brutal-lime)]",
      active: kpis.draftHeatCards > 0,
    },
  ];

  return (
    <section
      aria-label="Admin telemetry"
      className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}
    >
      {tiles.map((t) => {
        const Icon = t.icon;
        return (
          <div
            key={t.key}
            className={cn(
              "rounded-2xl border-2 border-black bg-card p-3 transition-all sm:p-4",
              t.active ? t.glow : "shadow-brutal-sm",
            )}
          >
            <div className="flex items-center gap-2">
              <Icon className={cn("size-4 shrink-0", t.active ? t.accent : "text-muted-foreground")} />
              <p className="truncate text-[11px] font-bold tracking-wide uppercase text-muted-foreground">
                {t.label}
              </p>
            </div>
            <p className="mt-2 flex items-baseline gap-1 font-telemetry text-2xl leading-none font-extrabold sm:text-3xl">
              {t.value}
              {t.unit && (
                <span className="text-sm font-bold text-muted-foreground sm:text-base">{t.unit}</span>
              )}
            </p>
            {t.sub && <p className="mt-1 text-[11px] text-muted-foreground">{t.sub}</p>}
          </div>
        );
      })}
    </section>
  );
}
