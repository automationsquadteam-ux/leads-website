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
      {/*
        ONE scrim, not two.

        This stacked a flat `bg-background/70` and a gradient reaching /80 on
        top of it, which multiply: 0.6 video x 0.3 x ~0.3 left roughly 5% of
        the footage visible, i.e. a flat dark page ,which is exactly how it
        was reported. A single layer is the only way the arithmetic stays
        legible to whoever tunes this next.

        0.6 over a 0.6-opacity video leaves ~24% of the footage showing:
        clearly moving, still dark enough to read a dense table over. This is
        the number to change if it wants to be more or less present ,adjust
        it rather than adding another layer.
      */}
      <div className="absolute inset-0 bg-background/60" />
    </div>
  );
}
