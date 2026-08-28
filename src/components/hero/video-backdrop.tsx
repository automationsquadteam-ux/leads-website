'use client';

import { useEffect, useRef } from 'react';

/**
 * Full-bleed HLS video backdrop.
 *
 * Every branch below reports why it stopped. The first version of this failed
 * silently in three separate ways ,a rejected dynamic import, an hls.js
 * network error, and a refused autoplay all produced the same symptom (a flat
 * colour where the video should be) with nothing in the console. Chasing that
 * from the outside is guesswork, so each path now names itself.
 *
 * Fixed behaviours worth keeping:
 *
 * - `enableWorker: false`. hls.js normally demuxes in a Web Worker built from
 *   a blob: URL, which a strict CSP or a sandboxed frame refuses to execute.
 * - Safari is never given hls.js. It plays HLS natively via `src`, and
 *   attaching hls.js on top produces two pipelines on one element.
 * - `muted` + `playsInline` are both required for autoplay on iOS, and without
 *   `playsInline` iOS takes over the whole screen on first play.
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

    /*
     * Autoplay can be refused even when muted (Chrome weighs its Media
     * Engagement Index). Rather than give up, arm a one-shot listener so the
     * next click or keypress anywhere starts it ,by then the browser counts
     * the gesture as intent.
     */
    let armed = false;
    const playOnGesture = () => {
      void video.play().catch(() => {});
      window.removeEventListener('pointerdown', playOnGesture);
      window.removeEventListener('keydown', playOnGesture);
      armed = false;
    };
    const tryPlay = () => {
      video.play().catch((error: unknown) => {
        const name = error instanceof Error ? error.name : 'unknown';
        console.warn(
          `[VideoBackdrop] autoplay refused (${name}); will start on first interaction.`,
        );
        if (!armed) {
          armed = true;
          window.addEventListener('pointerdown', playOnGesture, { once: true });
          window.addEventListener('keydown', playOnGesture, { once: true });
        }
      });
    };

    // Safari / iOS: native HLS, no library.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      tryPlay();
      return () => {
        window.removeEventListener('pointerdown', playOnGesture);
        window.removeEventListener('keydown', playOnGesture);
      };
    }

    let destroyed = false;
    let hls: import('hls.js').default | null = null;

    import('hls.js')
      .then(({ default: Hls }) => {
        if (destroyed) return;

        if (!Hls.isSupported()) {
          console.warn('[VideoBackdrop] hls.js reports no MSE support in this browser.');
          return;
        }

        hls = new Hls({ enableWorker: false });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);

        /*
         * hls.js surfaces transient network/media problems as recoverable
         * errors and expects the app to call the matching recovery. Without
         * this a single dropped segment ends playback permanently ,the
         * stream simply stops and nothing says so.
         */
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.warn('[VideoBackdrop] fatal network error, retrying:', data.details);
            hls?.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.warn('[VideoBackdrop] fatal media error, recovering:', data.details);
            hls?.recoverMediaError();
          } else {
            console.error('[VideoBackdrop] unrecoverable error:', data.details);
            hls?.destroy();
          }
        });
      })
      .catch((error: unknown) => {
        // Previously an unhandled rejection: the import failing looked exactly
        // like the video simply not being there.
        console.error('[VideoBackdrop] could not load hls.js:', error);
      });

    return () => {
      destroyed = true;
      window.removeEventListener('pointerdown', playOnGesture);
      window.removeEventListener('keydown', playOnGesture);
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
      // `metadata`, not `none`: with `none` some builds of Chrome never begin
      // buffering an MSE-attached source until something else nudges it, which
      // reads as "the video did not load".
      preload="metadata"
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
