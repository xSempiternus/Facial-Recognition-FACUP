import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { preload } from "react-dom";
import "./globals.css";

// Geist (OFL, ver src/fonts/Geist-LICENSE.txt): sans neutra y precisa. Local: el kiosko funciona sin internet.
const geist = localFont({
  src: "../fonts/Geist-Variable.woff2",
  weight: "100 900",
  variable: "--font-geist",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Llegada · FA CUP Chile",
  description: "Kiosko de asistencia con reconocimiento facial de FA CUP Chile.",
};

export const viewport: Viewport = {
  themeColor: "#050706",
  viewportFit: "cover", // pantalla completa bajo el notch; el contenido respeta env(safe-area-inset-*)
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // Precarga del modelo facial y su wasm: se descargan mientras carga la interfaz, no después.
  preload("/models/face_landmarker.task", { as: "fetch", crossOrigin: "anonymous" });
  preload("/mediapipe/vision_wasm_internal.wasm", { as: "fetch", crossOrigin: "anonymous" });
  return (
    <html lang="es" className={`${geist.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
