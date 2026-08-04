'use client';

import * as React from 'react';

/**
 * localStorage-backed state via useSyncExternalStore.
 *
 * Reading persisted values in a mount effect (`useEffect(() => setX(read()))`)
 * causes a cascading render and trips react-hooks/set-state-in-effect.
 * useSyncExternalStore is the intended tool: React calls getServerSnapshot
 * during SSR/hydration and swaps to the client snapshot afterwards, so there is
 * no hydration mismatch and no extra render pass we control.
 */

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  // `storage` fires for changes made in *other* tabs; the local set() calls notify().
  window.addEventListener('storage', callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener('storage', callback);
  };
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be disabled or full; behave as if nothing was stored.
    return null;
  }
}

/** Raw string flavour for values another script also reads (e.g. the theme). */
export function usePersistedString(key: string, fallback: string): [string, (next: string) => void] {
  const value = React.useSyncExternalStore(
    subscribe,
    () => readRaw(key) ?? fallback,
    () => fallback,
  );

  const set = React.useCallback(
    (next: string) => {
      try {
        localStorage.setItem(key, next);
      } catch {
        /* ignore */
      }
      notify();
    },
    [key],
  );

  return [value, set];
}

/**
 * JSON flavour, for structured values such as persisted column widths.
 *
 * `fallback` must be referentially stable (a module-level constant, not an
 * inline literal) it participates in the memo dependencies, so a fresh object
 * each render would return a fresh value each render.
 */
export function usePersistedJson<T>(key: string, fallback: T): [T, (next: T) => void] {
  const raw = React.useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null,
  );

  const value = React.useMemo<T>(() => {
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }, [raw, fallback]);

  const set = React.useCallback(
    (next: T) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      notify();
    },
    [key],
  );

  return [value, set];
}
