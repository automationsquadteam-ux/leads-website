import * as React from 'react';

import { cn } from '@/lib/utils';

const FIELD_BASE =
  'w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground ' +
  'placeholder:text-muted-foreground transition-colors ' +
  'hover:border-border-strong focus:border-primary focus:outline-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-muted';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD_BASE, 'h-9', className)} {...props} />;
  },
);

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(FIELD_BASE, 'min-h-24 resize-y py-2 leading-relaxed', className)}
      {...props}
    />
  );
});

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select ref={ref} className={cn(FIELD_BASE, 'h-9 cursor-pointer pr-8', className)} {...props}>
      {children}
    </select>
  );
});

/** Visible label — placeholder-only labelling fails the forms guidelines. */
export function Label({
  className,
  required,
  children,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement> & { required?: boolean }) {
  return (
    <label className={cn('block text-xs font-medium text-muted-foreground', className)} {...props}>
      {children}
      {required ? (
        <span className="ml-0.5 text-danger" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor} required={required}>
        {label}
      </Label>
      {children}
      {/* Hint stays visible; errors sit next to the field, never only at the top. */}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
