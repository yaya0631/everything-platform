import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Resolve hook for the upstream adapter: the one specifier we remap is
 * `vitest` (to test/vitest-shim/index.mjs) so upstream test files import the
 * shim verbatim; everything else resolves normally. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest' || specifier.startsWith('vitest/')) {
    return { url: new URL('./index.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

/** Vite's ?raw import is used by signatures to embed its worker source. */
export async function load(url, context, nextLoad) {
  if (url.endsWith('?raw')) {
    const sourcePath = fileURLToPath(url.slice(0, -4));
    const source = fs.readFileSync(sourcePath, 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  }
  return nextLoad(url, context);
}
