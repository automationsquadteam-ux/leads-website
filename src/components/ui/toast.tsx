'use client';

import * as React from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

import { cn } from '@/lib/utils';

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error';
}

const ToastContext = React.createContext<{
  toast: (message: string, tone?: Toast['tone']) => void;
} | null>(null);

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const toast = React.useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    // Auto-dismiss inside the 3–5s guideline.
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const value = React.useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/*
        aria-live="polite" announces without stealing focus, which a toast must
        never do it would yank the user out of whatever they were doing.
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-lg border bg-surface-raised px-3 py-2.5 shadow-lg',
              t.tone === 'success' ? 'border-success/30' : 'border-danger/30',
            )}
          >
            {t.tone === 'success' ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            )}
            <p className="flex-1 text-sm">{t.message}</p>
            <button
              type="button"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss notification"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
