"use client";

import { useLayoutEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CLOCK_TIME_ERROR,
  CLOCK_TIME_HINT,
  CLOCK_TIME_PLACEHOLDER,
  maskClockTimeInput,
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

  const inputRef = useRef<HTMLInputElement>(null);
  // Where the caret must land after the mask rewrote the value. React
  // re-renders with the masked string and the browser would otherwise drop
  // the caret at the end, which strands a referee mid-correction.
  const pendingCaret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret == null || !inputRef.current) return;
    pendingCaret.current = null;
    inputRef.current.setSelectionRange(caret, caret);
  });

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <Label htmlFor={id}>{label}</Label>}
      <Input
        id={id}
        ref={inputRef}
        // numeric, not decimal: the mask supplies the "." and ":", so the
        // phone keypad only ever needs digits.
        inputMode="numeric"
        autoComplete="off"
        placeholder={CLOCK_TIME_PLACEHOLDER}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn("min-h-[48px] font-mono", outdoorMode && "border-yellow-300/40")}
        value={value}
        onChange={(e) => {
          const masked = maskClockTimeInput(
            e.target.value,
            e.target.selectionStart,
            // The value the field held before this keystroke — the only way
            // to tell "backspaced the colon" from "typed nothing new".
            value,
          );
          pendingCaret.current = masked.caret;
          onChange(masked.value, parseTimeToMs(masked.value));
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
