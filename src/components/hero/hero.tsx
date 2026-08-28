import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

import { VideoBackdrop } from './video-backdrop';
import { CenterGlow, GridLines } from './atmosphere';
import { GlassCard } from './glass-card';
import { SiteNav, type NavLink } from './site-nav';

const HLS_SRC =
  'https://stream.mux.com/tLkHO1qZoaaQOUeVWo8hEBeGQfySP02EPS02BmnNFyXys.m3u8';

/**
 * The landing hero: video, overlays, atmosphere, glass tile, headline, CTA.
 *
 * The stack is ordered back-to-front and every layer is explicit, because the
 * order is what makes the text legible over moving video:
 *
 *   video (60% opacity) → left-to-right gradient → bottom-up gradient →
 *   glow → grid lines → content
 *
 * Both gradients are load-bearing rather than decorative. Video luminance
 * changes frame to frame, so white text over raw footage passes contrast in
 * one second and fails in the next; the gradients put a guaranteed floor under
 * the regions the text actually occupies (left third, bottom half).
 *
 * Everything except the video and the nav is a server component ,only those
 * two need the client, and keeping the headline server-rendered means it is in
 * the initial HTML for crawlers and for anyone whose JS has not arrived.
 */
export function Hero({
  eyebrow,
  headline,
  headlineAccent,
  description,
  ctaLabel,
  ctaHref,
  links,
  card,
}: {
  eyebrow: string;
  headline: string;
  /** Rendered in mint immediately after the headline ,typically a full stop. */
  headlineAccent: string;
  description: string;
  ctaLabel: string;
  ctaHref: string;
  links: NavLink[];
  card: {
    tag: string;
    headlinePlain: string;
    headlineItalic: string;
    headlineRest?: string;
    description: string;
  };
}) {
  return (
    <section className="relative isolate min-h-[100svh] overflow-hidden bg-[#070b0a]">
      <VideoBackdrop
        src={HLS_SRC}
        className="absolute inset-0 size-full object-cover opacity-60"
      />

      {/* Left-to-right: anchors the headline column. */}
      <div
        className="absolute inset-0 bg-linear-to-r from-[#070b0a] via-[#070b0a]/70 to-transparent"
        aria-hidden="true"
      />
      {/* Bottom-up: anchors the CTA and the scroll boundary. */}
      <div
        className="absolute inset-0 bg-linear-to-t from-[#070b0a] via-[#070b0a]/40 to-transparent"
        aria-hidden="true"
      />

      <CenterGlow className="top-[12%] left-1/2 h-[380px] w-[130%] -translate-x-1/2 opacity-80" />
      <GridLines />

      <SiteNav links={links} />

      <div className="relative z-10 mx-auto flex min-h-[100svh] max-w-7xl flex-col justify-center px-5 pt-28 pb-16 sm:px-8">
        <div className="hidden sm:block">
          <GlassCard {...card} />
        </div>

        <p className="font-display text-[11px] font-bold tracking-[0.2em] text-primary uppercase">
          {eyebrow}
        </p>

        <h1 className="mt-4 max-w-4xl text-[40px] leading-[0.95] font-extrabold tracking-tight text-white uppercase sm:text-[56px] lg:text-[72px]">
          {headline}
          <span className="text-primary">{headlineAccent}</span>
        </h1>

        <p className="mt-6 max-w-[512px] text-[14px] leading-relaxed text-white/70">
          {description}
        </p>

        <div className="mt-9">
          <Link
            href={ctaHref}
            className="group inline-flex items-center gap-2.5 rounded-full bg-primary px-7 py-3.5 text-[13px] font-bold tracking-wide text-primary-foreground uppercase transition-colors hover:bg-primary-hover"
          >
            {ctaLabel}
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        </div>
      </div>
    </section>
  );
}
