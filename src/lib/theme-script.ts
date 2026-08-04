export const THEME_STORAGE_KEY = 'leadscrm-theme';

/**
 * Injected into <head> and run before paint so the stored theme is applied
 * before first render — otherwise dark-mode users get a white flash.
 *
 * Lives in its own (non-"use client") module because a Server Component can
 * only import a plain value like this from a server-importable file; pulling it
 * out of the client component would yield a client-reference proxy, not a string.
 */
export const themeScript = `
(function(){
  try {
    var t = localStorage.getItem('${THEME_STORAGE_KEY}') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {}
})();
`;
