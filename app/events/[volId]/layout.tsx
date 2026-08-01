import { BottomTabNav } from "@/components/layout/bottom-tab-nav";
import { AppHeader } from "@/components/layout/app-header";

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
      <AppHeader />
      {children}
      <BottomTabNav volId={volId} />
    </div>
  );
}
