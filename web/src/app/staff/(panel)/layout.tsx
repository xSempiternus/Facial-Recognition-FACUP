import { Shell } from "@/components/staff/Shell";

export default function PanelLayout({ children }: LayoutProps<"/staff">) {
  return <Shell>{children}</Shell>;
}
