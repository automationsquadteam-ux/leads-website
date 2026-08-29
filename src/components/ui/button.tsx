import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

/*
 * `rounded-full` on the primary action is the one shape borrowed wholesale
 * from the landing hero ,it is the CTA treatment, so the button that commits
 * a change should read the same everywhere. Secondary and ghost keep the
 * softer `rounded-md`: a toolbar of pills is noisier than a toolbar of
 * rectangles, and only one action per view should look like the CTA.
 */
const VARIANTS: Record<Variant, string> = {
  primary:
    'rounded-full bg-primary text-primary-foreground font-semibold tracking-wide hover:bg-primary-hover shadow-[0_0_0_1px_rgb(92_157_255/0.2),0_6px_20px_-8px_rgb(92_157_255/0.5)] disabled:hover:bg-primary',
  secondary:
    'rounded-md bg-surface text-foreground border border-border hover:border-border-strong hover:bg-surface-hover disabled:hover:bg-surface',
  outline:
    'rounded-md bg-transparent text-foreground border border-border-strong hover:border-primary/50 hover:bg-surface-hover disabled:hover:bg-transparent',
  ghost:
    'rounded-md bg-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground',
  danger:
    'rounded-full bg-danger text-white font-semibold hover:bg-danger-hover shadow-[0_6px_20px_-8px_rgb(242_106_95_/_0.5)] disabled:hover:bg-danger',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3 text-sm gap-2',
  lg: 'h-10 px-4 text-sm gap-2',
  // 36px is below the 44px touch guideline, so icon buttons in touch contexts
  // rely on the surrounding padding of their container to extend the hit area.
  icon: 'h-9 w-9 p-0',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // aria-busy tells assistive tech the control is working, not broken.
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center font-medium whitespace-nowrap',
        'transition-colors duration-150',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" /> : null}
      {children}
    </button>
  );
});
