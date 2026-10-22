/**
 * The cad-home Puter shim loader.
 *
 * The shim itself is a real JavaScript file (lib/shim/puter.js) so it can be
 * syntax-checked like the rest of the codebase instead of being assembled
 * from template strings. Everything else replaces js.puter.com for the hub
 * apps; see the file headers in lib/shim/ for the details.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SHIM_FILE = path.join(DIR, 'shim', 'puter.js');
const CSS_FILE = path.join(DIR, 'shim', 'puter.css');
const WORKER_MAP_FILE = path.join(DIR, 'shim', 'worker-url-map.js');

const cache = new Map();

function withCache(file, initializer) {
  const mtime = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;
  const value = initializer();
  cache.set(file, { mtime, value });
  return value;
}

/** The shim source; `${shimOrigin}` is substituted client-server side only. */
export function shimSource({ apiOrigin = '/api/hub', hostingBase = '' } = {}) {
  const src = withCache(SHIM_FILE, () => fs.readFileSync(SHIM_FILE, 'utf8'));
  const map = withCache(WORKER_MAP_FILE, () => fs.readFileSync(WORKER_MAP_FILE, 'utf8'));
  return `${src.replace('CAD_HUB_API_ORIGIN', JSON.stringify(apiOrigin))
    .replace('CAD_HUB_HOSTING_BASE', JSON.stringify(hostingBase))}\n${map}`;
}

export function workerUrlMapSource() {
  return withCache(WORKER_MAP_FILE, () => fs.readFileSync(WORKER_MAP_FILE, 'utf8'));
}

/** The picker CSS the shim injects via <link> (strict CSP: no inline styles). */
export function shimCss() {
  return withCache(CSS_FILE, () => fs.readFileSync(CSS_FILE, 'utf8'));
}
