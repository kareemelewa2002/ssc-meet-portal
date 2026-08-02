import { redirect } from "next/navigation";

/** Legacy route. The combined "heat sheets & results" view is now split into
 * /heats and /results, so this permanently forwards to the heat sheet. */
export default async function LivePage({
  params,
}: {
  params: Promise<{ volId: string }>;
}) {
  const { volId } = await params;
  redirect(`/events/${volId}/heats`);
}
