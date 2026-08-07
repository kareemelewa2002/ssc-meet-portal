"use client";

import { useEffect } from "react";
import { useOutdoorMode } from "@/components/providers/outdoor-mode-provider";

/**
 * Mirrors `useOutdoorMode()`'s boolean onto `<html data-outdoor>`, which is
 * what `app/globals.css`'s `:root[data-outdoor="true"]` selector reads.
 *
 * Needed now that the Aquatic Telemetry theme is the whole app's `:root`
 * (TECH_STACK_DECISIONS.md §12): before that promotion, only
 * `telemetry-theme-scope.tsx` set this attribute, on a `<div>` wrapping just
 * the telemetry route. The provider itself intentionally stays a plain
 * boolean context — see its own file — so this is the one place translating
 * that boolean into the DOM, rather than the provider reaching outside React
 * to mutate `document` on every consumer's behalf.
 *
 * Renders nothing; mounted once, inside OutdoorModeProvider, in the root
 * layout.
 */
export function OutdoorModeHtmlSync() {
  const { outdoorMode } = useOutdoorMode();

  useEffect(() => {
    if (outdoorMode) {
      document.documentElement.setAttribute("data-outdoor", "true");
    } else {
      document.documentElement.removeAttribute("data-outdoor");
    }
  }, [outdoorMode]);

  return null;
}
