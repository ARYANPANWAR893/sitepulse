import type { Metadata } from "next";
import { Big_Shoulders, Public_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

const bigShoulders = Big_Shoulders({
  variable: "--font-big-shoulders",
  weight: ["500", "600", "700", "800"],
  subsets: ["latin"],
  display: "swap",
  fallback: ["Arial Narrow", "system-ui", "sans-serif"],
  adjustFontFallback: false,
});

const publicSans = Public_Sans({
  variable: "--font-public-sans",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
});

const title = "SitePulse — field-to-schedule intelligence";
const description =
  "Field supervisors send plain-language progress updates. SitePulse links each one to the right L5/L6 schedule activity with a confidence score and an append-only, hash-chained audit trail — escalating to a human the moment it isn't sure. SIH 2026 · PS SIH26122 · Oil India Limited.";

export const metadata: Metadata = {
  title,
  description,
  applicationName: "SitePulse",
  authors: [{ name: "Team SitePulse" }],
  keywords: [
    "SitePulse",
    "Smart India Hackathon 2026",
    "SIH26122",
    "Oil India Limited",
    "Primavera P6",
    "project controls",
    "schedule variance",
    "construction progress reporting",
  ],
  openGraph: {
    title,
    description,
    type: "website",
    siteName: "SitePulse",
  },
  twitter: { card: "summary_large_image", title, description },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Runs before first paint, so a pinned theme never flashes the other one.
  const noFlash = `(function(){try{var t=localStorage.getItem("sitepulse-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlash }} />
      </head>
      <body
        className={`${bigShoulders.variable} ${publicSans.variable} ${plexMono.variable}`}
      >
        {/* Below-the-fold sections animate in via IntersectionObserver. With
            JS off they would never un-hide, so force them visible. */}
        <noscript>
          <style>{`.reveal{opacity:1!important;transform:none!important}`}</style>
        </noscript>
        {children}
      </body>
    </html>
  );
}
