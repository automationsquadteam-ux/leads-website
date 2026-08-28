import { cn } from '@/lib/utils';

/**
 * The 200x200 liquid-glass tile that floats above the headline.
 *
 * The glass itself (`.glass`) and its 1.4px gradient frame (`.glass-frame`)
 * are utilities in globals.css rather than inline styles, because both are
 * reused by the app shell and the metric cards ,defining the blur radius in
 * one place is what keeps a page from stacking four different blurs.
 *
 * `-translate-y-[50px]` lifts it into the space above the headline so it
 * overlaps rather than stacks. It is decorative furniture, so it is hidden
 * from assistive tech below `sm` where it would otherwise push the headline
 * off a small screen.
 */
export function GlassCard({
  tag,
  headlinePlain,
  headlineItalic,
  headlineRest,
  description,
  className,
}: {
  tag: string;
  headlinePlain: string;
  headlineItalic: string;
  headlineRest?: string;
  description: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'glass glass-frame relative flex size-[200px] shrink-0 -translate-y-[50px] flex-col justify-between rounded-2xl p-5',
        className,
      )}
    >
      <span className="font-display text-[14px] leading-none font-medium tracking-widest text-primary">
        {tag}
      </span>

      <h2 className="text-[18px] leading-snug font-medium text-balance text-foreground">
        {headlinePlain} <em className="font-serif-italic">{headlineItalic}</em>
        {headlineRest ? ` ${headlineRest}` : ''}
      </h2>

      <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}
