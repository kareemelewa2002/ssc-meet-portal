import { BottomTabNav } from "@/components/layout/bottom-tab-nav";

export default async function VolumeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ volId: string }>;
}) {
  const { volId } = await params;

  return (
    <div className="min-h-screen pb-16 md:pb-0">
      {children}
      <BottomTabNav volId={volId} />
    </div>
  );
}
