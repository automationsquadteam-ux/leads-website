export const THEME_STORAGE_KEY = 'leadscrm-theme';

/**
 * Injected into <head> and run before paint so the stored theme is applied
 * before first render otherwise dark-mode users get a white flash.
 *
 * Lives in its own (non-"use client") module because a Server Component can
 * only import a plain value like this from a server-importable file; pulling it
 * out of the client component would yield a client-reference proxy, not a string.
 */
/*
 * The default is 'dark', not 'system'.
 *
 * The design is dark-first ,the landing hero is video over #070b0a, and the
 * glass surfaces and the mint accent are tuned against that ground. A visitor
 * on a light-preferring OS previously landed on the light theme, which is the
 * secondary treatment, so the first impression was the weaker one. An explicit
 * choice from the toggle still wins, and 'system' is still selectable; only the
 * unset default changed.
 */
export const themeScript = `
(function(){
  try {
    var t = localStorage.getItem('${THEME_STORAGE_KEY}') || 'dark';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch (e) {
    document.documentElement.classList.add('dark');
  }
})();
`;
