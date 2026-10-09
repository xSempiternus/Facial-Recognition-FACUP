import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// Tipografía oficial FA CUP Chile (PlutoSans Condensed).
const pluto = localFont({
  src: [
    { path: "../fonts/PlutoSansCondRegular.otf", weight: "400", style: "normal" },
    { path: "../fonts/PlutoSansCondBold.otf", weight: "700", style: "normal" },
  ],
  variable: "--font-pluto",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Llegada · FA CUP Chile",
  description: "Kiosko de asistencia con reconocimiento facial de FA CUP Chile.",
};

export const viewport: Viewport = {
  themeColor: "#03140a",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`${pluto.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
