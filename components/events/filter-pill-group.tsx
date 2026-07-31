"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FilterPillGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  outdoorMode,
  allowAll = true,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T | null;
  onChange: (v: T | null) => void;
  outdoorMode: boolean;
  /** When false, no "All" pill is rendered — one option is always selected. */
  allowAll?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span
        className={cn(
          "text-xs font-semibold tracking-wide uppercase",
          outdoorMode ? "text-yellow-100/60" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">
        {allowAll && (
          <Button
            type="button"
            size="sm"
            variant={value === null ? "default" : "outline"}
            className="min-h-[48px] px-3 text-xs"
            onClick={() => onChange(null)}
          >
            All
          </Button>
        )}
        {options.map((opt) => (
          <Button
            key={opt.value}
            type="button"
            size="sm"
            variant={value === opt.value ? "default" : "outline"}
            className="min-h-[48px] px-3 text-xs"
            onClick={() => onChange(allowAll && value === opt.value ? null : opt.value)}
          >
            {opt.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
