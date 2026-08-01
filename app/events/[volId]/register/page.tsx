import { EventRegistrationClient } from "@/components/events/event-registration-client";

export default async function EventRegisterPage({
  params,
}: {
  params: Promise<{ volId: string }>;
}) {
  const { volId } = await params;
  return <EventRegistrationClient volId={volId} />;
}
