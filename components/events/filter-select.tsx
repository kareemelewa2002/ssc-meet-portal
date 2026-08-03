"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Sentinel for the "All" choice. Base UI Select treats null/"" as "nothing
 * chosen", which would make clearing a filter indistinguishable from never
 * having set one — so "All" needs a real value of its own. */
const ALL = "__all__";

/**
 * A labelled dropdown filter.
 *
 * Replaces the previous pill-button group: with a full meet programme the
 * Event filter alone ran to eighteen buttons, which wrapped over several rows
 * and pushed the actual results off the screen on a phone. A dropdown costs
 * one tap and takes one line whatever the option count.
 */
export function FilterSelect<T extends string>({
  label,
  options,
  value,
  onChange,
  outdoorMode,
  allowAll = true,
  className,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T | null) => void;
  outdoorMode: boolean;
  /** When false there is no "All" choice — one option is always selected. */
  allowAll?: boolean;
  className?: string;
}) {
  const selected = value ?? (allowAll ? ALL : "");
  // Just "All": the field label sits directly above, and pluralising it
  // generically produced "All session" / "All gender".
  const labelFor = (v: string) =>
    v === ALL ? "All" : options.find((o) => o.value === v)?.label ?? label;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span
        className={cn(
          "text-xs font-semibold tracking-wide uppercase",
          outdoorMode ? "text-yellow-100/60" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <Select
        value={selected}
        onValueChange={(next) => {
          if (!next) return;
          onChange(next === ALL ? null : (next as T));
        }}
      >
        <SelectTrigger
          className={cn(
            // h-auto defeats the primitive's data-[size=default]:h-8, which
            // otherwise wins over min-h and gives a 32px tap target.
            "h-auto min-h-[48px] w-full min-w-[9rem]",
            outdoorMode && "border-yellow-300/60 bg-black text-yellow-300",
          )}
          aria-label={label}
        >
          {/* Select.Value renders the raw value string by default — a render
              function is required to show the matching label instead. */}
          <SelectValue>{(v: string) => labelFor(v)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {allowAll && <SelectItem value={ALL}>All</SelectItem>}
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
