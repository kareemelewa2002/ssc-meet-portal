"use client";

import { useToastManager } from "@/components/ui/toast";

/** Friendly success/error toast helpers on top of Base UI's toast manager —
 * used for confirming saves (times, approvals, cash payments) and surfacing
 * validation errors without blocking the UI (HCI heuristic #5: error
 * prevention & recognition; #1: visibility of system status). */
export function useToast() {
  const manager = useToastManager();

  return {
    success: (title: string, description?: string) =>
      manager.add({ type: "success", title, description, timeout: 4000 }),
    error: (title: string, description?: string) =>
      manager.add({ type: "error", title, description, timeout: 6000 }),
  };
}
