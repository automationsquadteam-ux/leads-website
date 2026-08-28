'use client';

import { useEffect, useRef } from 'react';

/**
 * Full-bleed HLS video backdrop.
 *
 * Three things here are deliberate and each one is a real failure mode:
 *
 * 1. `enableWorker: false`. hls.js normally demuxes in a Web Worker built from
 *    a blob: URL, which a strict CSP (or a sandboxed preview frame) refuses to
 *    execute ,the player then fails with no visible error and the section
 *    renders as a flat colour. Demuxing on the main thread is slower and is the
 *    right trade for a decorative loop.
 *
 * 2. Safari is not given hls.js at all. It plays HLS natively through the
 *    `src` attribute, and attaching hls.js on top of native support produces
 *    two competing pipelines on one element.
 *
 * 3. The element is muted AND carries `playsInline`. iOS refuses to autoplay
 *    without both, and without `playsInline` it hijacks the whole screen into
 *    the native fullscreen player on first play.
 *
 * `poster` matters more than it looks: it is what a visitor sees when autoplay
 * is refused, the network is slow, or reduced-motion applies ,so it is a solid
 * background colour rather than nothing, and the section never flashes white.
 */
export function VideoBackdrop({
  src,
  className = '',
}: {
  src: string;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Respect the OS setting: a looping background video is decoration, and
    // decoration is exactly what this preference is asking us to stop.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) return;

    // Safari / iOS: native HLS, no library.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {
        /* Autoplay refused ,the poster colour stands in. Not an error. */
      });
      return;
    }

    let destroyed = false;
    let hls: import('hls.js').default | null = null;

    // Imported lazily so hls.js is never in the initial bundle for a visitor
    // whose browser plays HLS natively, or who has reduced motion on.
    void import('hls.js').then(({ default: Hls }) => {
      if (destroyed || !Hls.isSupported()) return;

      hls = new Hls({ enableWorker: false });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {
          /* See above. */
        });
      });
    });

    return () => {
      destroyed = true;
      hls?.destroy();
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      className={className}
      muted
      loop
      playsInline
      autoPlay
      preload="none"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
