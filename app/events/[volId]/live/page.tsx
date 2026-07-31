import { Suspense } from "react";
import { LiveEventsClient } from "@/components/events/live-client";

export default async function LivePage({
  params,
}: {
  params: Promise<{ volId: string }>;
}) {
  const { volId } = await params;
  return (
    <Suspense fallback={null}>
      <LiveEventsClient volId={volId} />
    </Suspense>
  );
}
