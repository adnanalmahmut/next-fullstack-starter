import { Geist_Mono } from "next/font/google";
import localFont from "next/font/local";

const thmanyahSans = localFont({
  src: [
    {
      path: "./fonts/thmanyah-sans-regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/thmanyah-sans-medium.woff2",
      weight: "500",
      style: "normal",
    },
    {
      path: "./fonts/thmanyah-sans-bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-thmanyah-sans",
  display: "swap",
  preload: true,
  fallback: ["Arial", "sans-serif"],
  adjustFontFallback: "Arial",
});

const thmanyahSerifDisplay = localFont({
  src: [
    {
      path: "./fonts/thmanyah-serif-display-bold.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "./fonts/thmanyah-serif-display-black.woff2",
      weight: "900",
      style: "normal",
    },
  ],
  variable: "--font-thmanyah-serif-display",
  display: "swap",
  preload: false,
  fallback: ["Times New Roman", "serif"],
  adjustFontFallback: "Times New Roman",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export { geistMono, thmanyahSans, thmanyahSerifDisplay };
