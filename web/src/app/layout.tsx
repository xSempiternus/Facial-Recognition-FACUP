import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
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
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es" className={`${geist.variable} h-full`}>
      <body className="h-full">{children}</body>
    </html>
  );
}
