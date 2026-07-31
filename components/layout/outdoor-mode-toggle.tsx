"use client";

import { Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";

export function OutdoorModeToggle() {
  const { outdoorMode, toggle } = useOutdoorMode();

  return (
    <Button
      type="button"
      variant={outdoorMode ? "secondary" : "outline"}
      size="icon"
      className="size-11 min-h-[48px] min-w-[48px]"
      aria-pressed={outdoorMode}
      aria-label="Toggle high-contrast outdoor mode"
      onClick={toggle}
    >
      <Sun className="size-5" />
    </Button>
  );
}
