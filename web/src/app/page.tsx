import type { Metadata } from "next";
import Menu from "@/components/inicio/Menu";

export const metadata: Metadata = {
  title: "FA CUP Chile · Inicio",
};

export default function Page() {
  return <Menu />;
}
