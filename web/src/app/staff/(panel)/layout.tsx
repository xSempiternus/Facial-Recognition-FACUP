import { PendientesProvider } from "@/components/staff/Pendientes";
import { Shell } from "@/components/staff/Shell";

export default function PanelLayout({ children }: LayoutProps<"/staff">) {
  return (
    <PendientesProvider>
      <Shell>{children}</Shell>
    </PendientesProvider>
  );
}
