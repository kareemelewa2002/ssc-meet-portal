"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DataErrorBanner } from "@/components/ui/data-error-banner";
import { resolveSkinsEventId } from "@/lib/skins-qualification";
import { SkinsKnockout } from "@/components/admin/skins-knockout";
import { UserRoleManagement } from "@/components/admin/user-role-management";
import { PendingSwimmerApprovals } from "@/components/admin/pending-swimmer-approvals";
import { PendingTeamApprovals } from "@/components/admin/pending-team-approvals";
import { RefereeHeatCards } from "@/components/admin/referee-heat-cards";
import { CashPayments } from "@/components/admin/cash-payments";
import { AppHeader } from "@/components/layout/app-header";
import { AdminKpiStrip } from "@/components/admin/admin-kpi-strip";

const TABS = [
  { id: "pending", label: "Pending Swimmer Registrations", shortLabel: "Swimmers" },
  { id: "teams", label: "Pending Team Approvals", shortLabel: "Teams" },
  { id: "heatcards", label: "Referee Heat Cards", shortLabel: "Heat Cards" },
  { id: "cash", label: "Cash Payments", shortLabel: "Cash" },
  { id: "skins", label: "Skins Knockout", shortLabel: "Skins" },
  { id: "users", label: "User & Role Management", shortLabel: "Users" },
] as const;

export default function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("pending");
  // The Skins bracket queries uuid columns, so it can only ever be mounted
  // with a real event UUID — never the old "50m-freestyle-skins" slug.
  const [skinsEventId, setSkinsEventId] = useState<string | null>(null);
  const [skinsError, setSkinsError] = useState<string | null>(null);
  const [skinsResolving, setSkinsResolving] = useState(false);
  // A ref, not state: setSkinsResolving(true) inside the effect would retrigger
  // it if `skinsResolving` were a dependency, and the resulting cleanup would
  // cancel the in-flight lookup before it ever resolved.
  const skinsRequested = useRef(false);

  useEffect(() => {
    if (tab !== "skins" || skinsRequested.current) return;
    skinsRequested.current = true;
    let cancelled = false;
    setSkinsResolving(true);
    (async () => {
      const result = await resolveSkinsEventId();
      if (cancelled) return;
      setSkinsEventId(result.data);
      setSkinsError(result.error);
      setSkinsResolving(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  return (
    <div className="min-h-screen">
      <AppHeader title="Admin Dashboard" />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-extrabold tracking-tight sm:text-3xl">Command Center</h1>
        <p className="text-sm text-muted-foreground">
          Live approval queues, cash on deck, and referee heat cards awaiting review.
        </p>
      </header>

      <AdminKpiStrip />

      <div className="grid grid-cols-2 gap-2 rounded-xl border-2 border-black bg-muted/30 p-1 sm:flex sm:flex-wrap sm:grid-cols-none">
        {TABS.map((t) => (
          <Button
            key={t.id}
            type="button"
            variant={tab === t.id ? "default" : "ghost"}
            className={cn("min-h-[48px] min-w-0 truncate sm:flex-none")}
            onClick={() => setTab(t.id)}
          >
            <span className="sm:hidden">{t.shortLabel}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </Button>
        ))}
      </div>

      {tab === "pending" && <PendingSwimmerApprovals />}
      {tab === "teams" && <PendingTeamApprovals />}
      {tab === "heatcards" && <RefereeHeatCards />}
      {tab === "cash" && <CashPayments />}
      {tab === "skins" && (
        <>
          <DataErrorBanner error={skinsError} subject="the Skins event" />
          {skinsResolving ? (
            <p className="text-sm text-muted-foreground">Resolving the Skins event…</p>
          ) : skinsEventId ? (
            <SkinsKnockout eventId={skinsEventId} />
          ) : (
            !skinsError && (
              <p className="text-sm text-muted-foreground">
                No Skins event found for this meet. Seed an event with{" "}
                <code className="font-mono">is_skins = true</code>, or set{" "}
                <code className="font-mono">NEXT_PUBLIC_SKINS_EVENT_ID</code> to its UUID.
              </p>
            )
          )}
        </>
      )}
      {tab === "users" && <UserRoleManagement />}
      </main>
    </div>
  );
}
