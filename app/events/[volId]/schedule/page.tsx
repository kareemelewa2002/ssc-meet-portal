import { ScheduleClient } from "@/components/events/schedule-client";

export default async function SchedulePage({
  params,
}: {
  params: Promise<{ volId: string }>;
}) {
  const { volId } = await params;
  return <ScheduleClient volId={volId} />;
}
