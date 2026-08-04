import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-primary text-primary-foreground hover:bg-primary-hover shadow-sm disabled:hover:bg-primary',
  secondary:
    'bg-surface text-foreground border border-border hover:bg-surface-hover disabled:hover:bg-surface',
  outline:
    'bg-transparent text-foreground border border-border-strong hover:bg-surface-hover disabled:hover:bg-transparent',
  ghost: 'bg-transparent text-muted-foreground hover:bg-surface-hover hover:text-foreground',
  danger: 'bg-danger text-white hover:bg-danger-hover shadow-sm disabled:hover:bg-danger',
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
        'inline-flex cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap',
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
