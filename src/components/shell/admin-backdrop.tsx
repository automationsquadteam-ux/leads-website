'use client';

import { VideoBackdrop } from '@/components/hero/video-backdrop';

const HLS_SRC =
  'https://stream.mux.com/tLkHO1qZoaaQOUeVWo8hEBeGQfySP02EPS02BmnNFyXys.m3u8';

/**
 * The looping backdrop behind the admin shell.
 *
 * Fixed rather than absolute so it stays put while a long leads table scrolls
 * over it ,a backdrop that scrolls with the content reads as a parallax
 * gimmick and makes the moving image compete with the rows.
 *
 * The video runs at the same 60% as the landing hero, asked for directly ,an
 * earlier pass had it at 22%, which was legible but barely visible and did not
 * read as the same design.
 *
 * What carries the contrast at that opacity is the scrim underneath the
 * content, not a dimmer video. A flat scrim is used rather than the hero's
 * gradients alone, and the reason is structural: a gradient only guarantees
 * contrast where it happens to be dark, which is fine for a hero (text pooled
 * in one corner) and wrong here, where a table can occupy every pixel. The
 * gradient is kept on top of it for depth.
 *
 * `-z-10` with no opaque background on the shell above it is what lets the
 * video show through the page's gaps; the translucent surface tokens (the
 * `admin-video` class in globals.css) are what let it show through the cards.
 */
export function AdminBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <VideoBackdrop src={HLS_SRC} className="size-full object-cover opacity-60" />
      {/* The contrast floor for everything above. */}
      <div className="absolute inset-0 bg-background/70" />
      {/* Depth on top of it, densest behind the top bar. */}
      <div className="absolute inset-0 bg-linear-to-b from-background/80 via-background/40 to-background/75" />
    </div>
  );
}
