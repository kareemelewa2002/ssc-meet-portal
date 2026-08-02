"use client";

import { AlertTriangle, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export interface DataErrorBannerProps {
  /** Failure text from a FetchResult. Renders nothing when null. */
  error: string | null;
  /** True when placeholder data is on screen (dev demo-fallback mode). */
  usedFallback?: boolean;
  /** What the user was trying to see, e.g. "heat sheets". */
  subject?: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * The visible half of lib/fetch-policy.ts. A backend failure must reach the
 * user as a failure — never as an empty list that reads like "no data yet",
 * and never as demo content masquerading as real results.
 */
export function DataErrorBanner({
  error,
  usedFallback = false,
  subject = "this data",
  onRetry,
  className,
}: DataErrorBannerProps) {
  if (!error) return null;

  return (
    <Alert
      variant={usedFallback ? "default" : "destructive"}
      className={cn(className)}
      data-testid="data-error-banner"
    >
      {usedFallback ? <Info className="size-4" /> : <AlertTriangle className="size-4" />}
      <AlertTitle>
        {usedFallback ? `Showing placeholder ${subject}` : `Couldn’t load ${subject}`}
      </AlertTitle>
      <AlertDescription className="space-y-1">
        <p>
          {usedFallback
            ? "The live query failed, so demo data is being shown because NEXT_PUBLIC_ALLOW_DEMO_FALLBACK is enabled. This never happens in production."
            : "The server rejected the request, so nothing below is live. This is a system error, not an empty schedule."}
        </p>
        <p className="font-mono text-xs break-all opacity-80">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1 min-h-[36px] font-semibold underline underline-offset-4"
          >
            Try again
          </button>
        )}
      </AlertDescription>
    </Alert>
  );
}
