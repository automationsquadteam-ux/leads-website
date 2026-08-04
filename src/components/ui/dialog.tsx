'use client';

import * as React from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * Built on the native <dialog> element, which gives us a focus trap, Escape to
 * close, inert background and top-layer stacking for free — all things a
 * hand-rolled modal usually gets wrong.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  className,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  className?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      aria-labelledby="dialog-title"
      onClose={onClose}
      // Clicking the backdrop (the dialog element itself) dismisses.
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] max-w-lg rounded-lg border border-border bg-surface p-0',
        'text-foreground shadow-xl backdrop:bg-black/50 backdrop:backdrop-blur-[2px]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 id="dialog-title" className="text-sm font-semibold">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close dialog">
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {children ? <div className="px-4 py-4">{children}</div> : null}

      {footer ? (
        <div className="flex justify-end gap-2 border-t border-border bg-muted/40 px-4 py-3">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}
