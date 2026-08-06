"use client";

import { useState } from "react";
import Link from "next/link";
import { SlidersHorizontal, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { UserRoleManagement } from "@/components/admin/user-role-management";
import { PendingTeamApprovals } from "@/components/admin/pending-team-approvals";
import { RefereeHeatCards } from "@/components/admin/referee-heat-cards";
import { CashPayments } from "@/components/admin/cash-payments";
import { RelaySquadPayments } from "@/components/admin/relay-squad-payments";
import { AppHeader } from "@/components/layout/app-header";
import { AdminKpiStrip } from "@/components/admin/admin-kpi-strip";

const TABS = [
  { id: "teams", label: "Pending Team Approvals", shortLabel: "Teams" },
  { id: "heatcards", label: "Referee Heat Cards", shortLabel: "Heat Cards" },
  { id: "cash", label: "Cash Payments", shortLabel: "Cash" },
  { id: "users", label: "User & Role Management", shortLabel: "Users" },
] as const;

/** Admin screens that are whole pages rather than tabs of this one. Both
 * were previously reachable only by typing the URL. */
const ADMIN_PAGES = [
  {
    href: "/admin/control-unit",
    label: "Control Unit",
    description: "Session times, capacity, turnaround, pricing",
    icon: SlidersHorizontal,
  },
  {
    href: "/admin/seeding",
    label: "Seeding",
    description: "Seed entries into heats and publish sheets",
    icon: Wand2,
  },
] as const;

export default function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("cash");

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

      <nav aria-label="Admin tools" className="grid gap-2 sm:grid-cols-2">
        {ADMIN_PAGES.map((page) => {
          const Icon = page.icon;
          return (
            <Link
              key={page.href}
              href={page.href}
              className="flex min-h-[64px] items-center gap-3 rounded-2xl border-2 border-black bg-card p-3 shadow-brutal-sm transition-colors hover:bg-muted/50"
            >
              <Icon className="size-5 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate font-bold">{page.label}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {page.description}
                </span>
              </span>
            </Link>
          );
        })}
      </nav>

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

      {tab === "teams" && <PendingTeamApprovals />}
      {tab === "heatcards" && <RefereeHeatCards />}
      {tab === "cash" && (
        <div className="space-y-4">
          <CashPayments />
          <RelaySquadPayments />
        </div>
      )}
      {tab === "users" && <UserRoleManagement />}
      </main>
    </div>
  );
}
