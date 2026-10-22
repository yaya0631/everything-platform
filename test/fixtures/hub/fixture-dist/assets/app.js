// Bundle content that upstream loads Puter from its own code (chess, checkers,
// backgammon, 3d) — the serve-time rewrite must swap this URL to the shim.
export const PUTER_SRC = 'https://js.puter.com/v2/';
export const ALSO_EXTERNAL = 'https://fonts.gstatic.com/s/fix/v1/w.woff2';
export const marker = 'fixture-app-bundle';
// Root-absolute app-own paths a bundle may embed (path-prefix issues):
export const SW = navigator.serviceWorker.register('/sw.js');
export const LOGO = `<img src="/icon.svg" alt="">`;
export const MANIFEST_REF = fetch('/manifest.webmanifest');
