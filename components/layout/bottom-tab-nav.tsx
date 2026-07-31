"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Calendar, Home, Radio, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";

interface BottomTabNavProps {
  volId: string;
}

export function BottomTabNav({ volId }: BottomTabNavProps) {
  const pathname = usePathname();

  const tabs = [
    { href: "/", label: "Events", icon: Home, active: pathname === "/" },
    {
      href: `/events/${volId}/live`,
      label: "Live",
      icon: Radio,
      active: pathname.includes("/live"),
    },
    {
      href: `/events/${volId}/leaderboard`,
      label: "Standings",
      icon: Trophy,
      active: pathname.includes("/leaderboard"),
    },
    {
      href: `/events/${volId}/schedule`,
      label: "Schedule",
      icon: Calendar,
      active: pathname.includes("/schedule"),
    },
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur-sm md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid grid-cols-4">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={cn(
                "flex min-h-[56px] flex-col items-center justify-center gap-0.5 text-xs transition-colors",
                tab.active ? "font-semibold text-primary" : "text-muted-foreground",
              )}
            >
              <Icon className="size-5" />
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
