"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CLOCK_TIME_ERROR,
  CLOCK_TIME_HINT,
  CLOCK_TIME_PLACEHOLDER,
  parseClockTime,
  parseTimeToMs,
} from "@/lib/format";
import { cn } from "@/lib/utils";

export interface ClockTimeInputProps {
  id: string;
  label?: string;
  value: string;
  onChange: (raw: string, ms: number | null) => void;
  disabled?: boolean;
  className?: string;
  outdoorMode?: boolean;
  showHint?: boolean;
  /** When true, show the validation message while the field is non-empty and invalid. */
  showError?: boolean;
}

export function ClockTimeInput({
  id,
  label = "Time",
  value,
  onChange,
  disabled,
  className,
  outdoorMode,
  showHint = true,
  showError = true,
}: ClockTimeInputProps) {
  const trimmed = value.trim();
  const invalid = trimmed.length > 0 && !parseClockTime(trimmed).ok;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        placeholder={CLOCK_TIME_PLACEHOLDER}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn("min-h-[48px] font-mono", outdoorMode && "border-yellow-300/40")}
        value={value}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw, parseTimeToMs(raw));
        }}
      />
      {showHint && (
        <p
          className={cn(
            "text-xs",
            outdoorMode ? "text-yellow-100/70" : "text-muted-foreground",
          )}
        >
          {CLOCK_TIME_HINT}
        </p>
      )}
      {showError && invalid && (
        <p className="text-xs text-destructive" role="alert">
          {CLOCK_TIME_ERROR}
        </p>
      )}
    </div>
  );
}
