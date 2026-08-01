import type { Metadata, Viewport } from "next";
import { Fredoka } from "next/font/google";
import "./globals.css";
import RegisterSW from "./components/RegisterSW";

const fredoka = Fredoka({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "Country Racer",
  description:
    "10 random countries race as glossy flag marbles around a themed oval track - pick a stage, set the laps, and watch who takes gold, silver, and bronze. A tiny, playful game for kids.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Country Racer",
  },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${fredoka.variable} h-full antialiased`}>
      <body className="min-h-full" suppressHydrationWarning>
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
