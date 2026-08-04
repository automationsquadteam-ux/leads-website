'use client';

import * as React from 'react';
import { Loader2, Search, X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Debounced search input.
 *
 * Debouncing at 300ms keeps a full-table query off every keystroke while still
 * feeling immediate. `useTransition` drives the spinner so the user can see the
 * request is in flight rather than wondering whether their typing registered.
 */
export function SearchBar({
  value,
  onChange,
  placeholder = 'Search…',
  pending = false,
  className,
  autoFocus = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  pending?: boolean;
  className?: string;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = React.useState(value);
  const [lastValue, setLastValue] = React.useState(value);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Re-sync when the URL changes underneath us (back button, cleared filters).
  // Adjusting state during render is React's documented pattern for reacting to
  // a changed prop an effect here would cause an extra render pass.
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }

  React.useEffect(() => {
    if (draft === value) return;
    const timer = setTimeout(() => onChange(draft), 300);
    return () => clearTimeout(timer);
  }, [draft, value, onChange]);

  // "/" focuses search from anywhere, the way Linear and GitHub behave.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      if (e.key === '/' && !typing) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={cn('relative flex-1', className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="search"
        role="searchbox"
        value={draft}
        autoFocus={autoFocus}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft('');
            onChange('');
          }
          // Enter commits immediately rather than waiting out the debounce.
          if (e.key === 'Enter') onChange(draft);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          'h-9 w-full rounded-md border border-border bg-surface pl-8 pr-16 text-sm',
          'placeholder:text-muted-foreground transition-colors',
          'hover:border-border-strong focus:border-primary focus:outline-none',
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
      />

      <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {pending ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
        ) : null}
        {draft ? (
          <button
            type="button"
            onClick={() => {
              setDraft('');
              onChange('');
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : (
          <kbd className="hidden rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground sm:inline">
            /
          </kbd>
        )}
      </div>
    </div>
  );
}
