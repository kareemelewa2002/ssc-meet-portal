import { Suspense } from "react";
import { TelemetryClient } from "@/components/telemetry/telemetry-client";

export default async function Page({ params }: { params: Promise<{ volId: string }> }) {
  const { volId } = await params;
  return (
    <Suspense fallback={null}>
      <TelemetryClient volId={volId} />
    </Suspense>
  );
}
