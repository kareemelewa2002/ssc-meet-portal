"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SkinsKnockout } from "@/components/admin/skins-knockout";
import { UserRoleManagement } from "@/components/admin/user-role-management";

const TABS = [
  { id: "skins", label: "Skins Knockout", shortLabel: "Skins" },
  { id: "users", label: "User & Role Management", shortLabel: "Users" },
] as const;

export default function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("skins");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-3 pb-24 sm:p-6">
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-1 sm:flex">
        {TABS.map((t) => (
          <Button
            key={t.id}
            type="button"
            variant={tab === t.id ? "default" : "ghost"}
            className={cn("min-h-[44px] min-w-0 truncate sm:flex-none")}
            onClick={() => setTab(t.id)}
          >
            <span className="sm:hidden">{t.shortLabel}</span>
            <span className="hidden sm:inline">{t.label}</span>
          </Button>
        ))}
      </div>

      {tab === "skins" && <SkinsKnockout eventId="50m-freestyle-skins" />}
      {tab === "users" && <UserRoleManagement />}
    </main>
  );
}
