import type { Metadata, Viewport } from 'next';
import { Inter, Instrument_Serif, Plus_Jakarta_Sans } from 'next/font/google';

import { themeScript } from '@/lib/theme-script';
import './globals.css';

// Self-hosted at build time: no external request at runtime, no layout shift.
// All three are declared here rather than imported per-page: next/font
// deduplicates and preloads them once, and a font loaded inside a component
// would be re-requested on every route that renders it.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

/** Eyebrows and small caps labels ,geometric, holds up at 11px. */
const jakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-jakarta',
});

/**
 * Used italic, for single emphasised words inside a sans headline. Only 400
 * exists for this family, so asking for another weight fails the build.
 */
const instrumentSerif = Instrument_Serif({
  subsets: ['latin'],
  weight: '400',
  style: 'italic',
  display: 'swap',
  variable: '--font-instrument-serif',
});

/**
 * Icons, the Open Graph image and the Twitter card are NOT declared here.
 * Next resolves them from the file conventions in this directory —
 * `icon.png`, `apple-icon.png`, `opengraph-image.png`, `twitter-image.png` —
 * and emits the tags with hashed, cache-busting URLs. Declaring them by hand as
 * well would produce duplicate tags that disagree after the next asset change.
 *
 * `metadataBase` resolves those relative URLs to absolute ones, which OG
 * scrapers require. It falls back to the Vercel-provided host so a preview
 * deployment does not advertise localhost.
 */
function siteUrl(): URL {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL;
  if (explicit) return new URL(explicit);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  }
  if (process.env.VERCEL_URL) return new URL(`https://${process.env.VERCEL_URL}`);
  return new URL('http://localhost:3000');
}

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: 'Automation Squad · Leads CRM', template: '%s · Automation Squad' },
  description: 'Cold outreach CRM research, review, and send.',
  applicationName: 'Automation Squad Leads CRM',
  // The CRM is private. /stats overrides nothing here because it is aggregate
  // only, and staying out of search results is the right default for both.
  robots: { index: false, follow: false },
  openGraph: {
    type: 'website',
    siteName: 'Automation Squad',
    title: 'Automation Squad · Leads CRM',
    description: 'Cold outreach CRM research, review, and send.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Automation Squad · Leads CRM',
    description: 'Cold outreach CRM research, review, and send.',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximumScale / user-scalable=no pinch zoom must stay available.
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jakarta.variable} ${instrumentSerif.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
