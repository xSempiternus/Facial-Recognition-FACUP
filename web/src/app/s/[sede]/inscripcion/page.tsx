import type { Metadata } from "next";
import { Suspense } from "react";
import Inscripcion from "@/components/inscripcion/Inscripcion";

export const metadata: Metadata = {
  title: "Inscripción · FA CUP Chile",
  robots: { index: false, follow: false },
};

async function Contenido({ params }: { params: Promise<{ sede: string }> }) {
  const { sede } = await params;
  return <Inscripcion sede={decodeURIComponent(sede)} />;
}

export default function Page({ params }: { params: Promise<{ sede: string }> }) {
  return (
    <Suspense fallback={null}>
      <Contenido params={params} />
    </Suspense>
  );
}
