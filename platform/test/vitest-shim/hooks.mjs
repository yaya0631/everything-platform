import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Resolve hook for the upstream adapter: the one specifier we remap is
 * `vitest` (to test/vitest-shim/index.mjs) so upstream test files import the
 * shim verbatim; everything else resolves normally.
 *
 * RUNTIME mode (CAD_RUNTIME_HELPERS=1): additionally maps the
 * signatures worker test helpers to the cad-home runtime seam
 * (test/runtime/*.mjs), so the SAME upstream cases execute against our
 * runtime transport instead of the upstream in-memory fakes. The marker is
 * set only by the runtime adapter, never by the upstream-only adapters. */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest' || specifier.startsWith('vitest/')) {
    return { url: new URL('./index.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (process.env.CAD_RUNTIME_HELPERS === '1'
    && typeof context.parentURL === 'string'
    && context.parentURL.includes('/upstream/src/signatures/tests/')) {
    const base = new URL('../runtime/', import.meta.url);
    if (specifier === './helpers/worker-harness.js') {
      return { url: new URL('worker-harness.mjs', base).href, shortCircuit: true };
    }
    if (specifier === './helpers/fake-puter.js') {
      return { url: new URL('fake-puter.mjs', base).href, shortCircuit: true };
    }
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
