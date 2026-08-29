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
 * - **MSE is preferred over native HLS**, not the other way round. See the long
 *   note at the source-selection branch: Chrome claims `"maybe"` for native
 *   HLS and cannot actually play it, so asking `canPlayType` first hands the
 *   element a playlist it will never decode. Native is the fallback, and it is
 *   real only on iOS Safari.
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

    // Belt and braces. The `muted` attribute IS present in the server-rendered
    // HTML (verified), so this is not the fix it was first assumed to be — but
    // setting the property costs nothing and removes one variable.
    video.muted = true;
    video.defaultMuted = true;

    /*
     * PLAYBACK IS RETRIED, NOT ATTEMPTED ONCE.
     *
     * The reported symptom was a still first frame in Chrome while the same
     * build animated in VS Code's embedded browser. Both are Chromium; what
     * differs is the autoplay policy, which Electron-based hosts usually
     * disable and Chrome does not. A muted video is *supposed* to be allowed,
     * but Chrome can still refuse (background tab at load, a media setting, an
     * extension), and a single `play()` on one event gives up silently when it
     * does.
     *
     * So: try on every event that can mean "there is now something to play",
     * and arm a gesture listener UNCONDITIONALLY rather than only after a
     * rejection ,a `play()` promise that resolves while the element stays
     * paused is a real state, and the earlier version had no answer for it.
     * Everything is removed as soon as playback actually starts.
     */
    const cleanups: Array<() => void> = [];

    const playOnGesture = () => {
      void video.play().catch(() => {});
    };
    window.addEventListener('pointerdown', playOnGesture);
    window.addEventListener('keydown', playOnGesture);
    cleanups.push(() => {
      window.removeEventListener('pointerdown', playOnGesture);
      window.removeEventListener('keydown', playOnGesture);
    });

    const onPlaying = () => {
      // Playing for real: drop the gesture listeners so they cost nothing.
      window.removeEventListener('pointerdown', playOnGesture);
      window.removeEventListener('keydown', playOnGesture);
    };
    video.addEventListener('playing', onPlaying);
    cleanups.push(() => video.removeEventListener('playing', onPlaying));

    const tryPlay = () => {
      video.play().catch((error: unknown) => {
        const name = error instanceof Error ? error.name : 'unknown';
        console.warn(
          `[VideoBackdrop] play() refused (${name}); will retry, and on first interaction.`,
        );
      });
    };

    // Any of these can be the moment data first becomes playable.
    for (const event of ['loadeddata', 'canplay', 'canplaythrough'] as const) {
      video.addEventListener(event, tryPlay);
      cleanups.push(() => video.removeEventListener(event, tryPlay));
    }

    const runCleanups = () => {
      for (const fn of cleanups) fn();
    };

    let destroyed = false;
    let hls: import('hls.js').default | null = null;

    /*
     * MSE FIRST, NATIVE ONLY AS FALLBACK. The order here is the bug that
     * produced `NotSupportedError` in Chrome, and it is worth stating plainly
     * because it looks harmless the other way round.
     *
     * This used to test `canPlayType('application/vnd.apple.mpegurl')` first
     * and treat any truthy answer as "this browser plays HLS natively". But
     * `canPlayType` returns a THREE-state string ,`""`, `"maybe"`, or
     * `"probably"` ,and Chrome on Windows answers **"maybe"** for HLS, which
     * is truthy while being an outright lie: Chrome has no native HLS demuxer.
     * So the element was handed an .m3u8 as a plain `src`, could not decode a
     * playlist as media, and every `play()` rejected with NotSupportedError.
     *
     * That is also the whole Chrome-vs-VS-Code difference reported earlier:
     * Electron answers `""` for the same call, fell through to hls.js, and
     * played fine ,so the autoplay policy was never involved.
     *
     * `Hls.isSupported()` (a real MSE capability check) is therefore asked
     * first, which is the order hls.js's own documentation uses. Native is
     * reached only where MSE genuinely is not available, which in practice
     * means iOS Safari ,the one place native HLS is real.
     */
    import('hls.js')
      .then(({ default: Hls }) => {
        if (destroyed) return;

        if (!Hls.isSupported()) {
          // No MSE. Native HLS is the only remaining option, and on iOS Safari
          // it is a genuine one.
          if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = src;
            tryPlay();
            return;
          }
          console.error('[VideoBackdrop] neither MSE nor native HLS is available here.');
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
      runCleanups();
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
