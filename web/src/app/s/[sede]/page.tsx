import type { Metadata } from "next";
import { Suspense } from "react";
import Menu from "@/components/inicio/Menu";

export const metadata: Metadata = {
  title: "FA CUP Chile · Inicio",
};

async function Contenido({ params }: { params: Promise<{ sede: string }> }) {
  const { sede } = await params;
  return <Menu sede={decodeURIComponent(sede)} />;
}

export default function Page({ params }: { params: Promise<{ sede: string }> }) {
  return (
    <Suspense fallback={null}>
      <Contenido params={params} />
    </Suspense>
  );
}
