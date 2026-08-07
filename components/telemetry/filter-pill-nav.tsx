"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";

export interface PillOption {
  value: string;
  label: string;
}

/**
 * One row of the Aquatic Telemetry filter bar: a radio group rendered as
 * pills, with a single shared-layout background that SLIDES between them
 * rather than one background per pill fading in and out.
 *
 * The slide is Motion's layout projection (`layoutId`), which resolves the
 * move to a `transform` — no width/left animation, so it stays on the
 * compositor no matter how many pills are in the row. `useId()` scopes the
 * layoutId per instance, so the Gender row's indicator can never fly across
 * to the Stroke row.
 *
 * Filtering is pure client state: choosing a pill never touches the router
 * and never refetches, it only narrows the already-loaded event list.
 */
export function FilterPillNav({
  label,
  options,
  value,
  onChange,
}: {
  /** Names the group for screen readers — the visible caption is separate. */
  label: string;
  options: PillOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const reduceMotion = useReducedMotion();
  const layoutId = useId();

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="px-1 text-[10px] font-semibold tracking-widest text-[var(--muted-foreground)] uppercase">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-label={label}
        data-glass
        className="glass-hud flex flex-wrap items-center gap-1 rounded-full p-1"
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <motion.button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              whileTap={reduceMotion ? undefined : { scale: 0.96 }}
              transition={{ type: "spring", stiffness: 400, damping: 25 }}
              className="relative min-h-[40px] shrink-0 rounded-full px-3 text-xs font-bold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{
                color: active ? "var(--background)" : "var(--muted-foreground)",
                outlineColor: "var(--color-neon-cyan)",
              }}
            >
              {active && (
                <motion.span
                  layoutId={layoutId}
                  aria-hidden
                  className="absolute inset-0 rounded-full"
                  style={{
                    background: "var(--color-neon-cyan)",
                    boxShadow:
                      "0 0 16px -2px color-mix(in oklch, var(--color-neon-cyan) 60%, transparent)",
                  }}
                  // A zero-duration layout transition still moves the
                  // indicator to the right pill, it just arrives instantly —
                  // the reduced-motion contract is "no travel", not "no
                  // indicator".
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 380, damping: 32 }
                  }
                />
              )}
              <span className="relative z-10">{option.label}</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
