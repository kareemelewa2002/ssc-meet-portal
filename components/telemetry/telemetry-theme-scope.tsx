"use client";

import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";
import { cn } from "@/lib/utils";

/**
 * Scopes the Aquatic Telemetry dark theme (app/globals.css's
 * `.telemetry-dark`) to this subtree only — see the comment on that class
 * for why it is a class scope and not a `:root` override.
 *
 * Reuses the SAME Outdoor Mode toggle/context every other page already
 * shares (OutdoorModeProvider, mounted once at the root layout), rather than
 * inventing a second high-contrast toggle — Outdoor Mode here means
 * `.telemetry-dark[data-outdoor="true"]`, the escalated-contrast variant of
 * this theme, exactly as decided for this feature. Every other page's own
 * meaning of `outdoorMode` (solid black/yellow) is untouched by this file.
 */
export function TelemetryThemeScope({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { outdoorMode } = useOutdoorMode();

  return (
    <div
      className={cn("telemetry-dark min-h-screen", className)}
      data-outdoor={outdoorMode ? "true" : undefined}
    >
      {children}
    </div>
  );
}
