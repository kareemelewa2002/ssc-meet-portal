"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkinsKnockout } from "@/components/admin/skins-knockout";
import { UserRoleManagement } from "@/components/admin/user-role-management";
import { PendingSwimmerApprovals } from "@/components/admin/pending-swimmer-approvals";
import { PendingTeamApprovals } from "@/components/admin/pending-team-approvals";
import { RefereeHeatCards } from "@/components/admin/referee-heat-cards";
import { CashPayments } from "@/components/admin/cash-payments";
import { AppHeader } from "@/components/layout/app-header";

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

  return (
    <div className="min-h-screen">
      <AppHeader title="Admin Dashboard" />
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-1 sm:flex sm:flex-wrap sm:grid-cols-none">
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
      {tab === "skins" && <SkinsKnockout eventId="50m-freestyle-skins" />}
      {tab === "users" && <UserRoleManagement />}
      </main>
    </div>
  );
}
