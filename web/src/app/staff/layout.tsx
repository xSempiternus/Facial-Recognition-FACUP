import type { Metadata } from "next";
import { ToastProvider } from "@/components/staff/ui";
import "./staff.css";

export const metadata: Metadata = {
  title: "Panel del staff · FA CUP Chile",
  robots: { index: false, follow: false },
};

// Zona con login: sus páginas cargan los datos en el cliente, así que no se valida la navegación instantánea.
export const instant = false;

export default function StaffLayout({ children }: LayoutProps<"/staff">) {
  return (
    <div className="staff">
      <ToastProvider>{children}</ToastProvider>
    </div>
  );
}
