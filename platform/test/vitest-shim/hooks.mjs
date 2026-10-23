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
 * set only by the runtime adapter, never by the upstream-only adapters.
 *
 * vi.mock support: test files that call `vi.mock('<spec>', factory)` are
 * rewritten at load time (see loadUnder): each mock's factory source is
 * extracted and REGISTERED against the absolute module it targets, and the
 * statement itself is removed from the file body. Every resolve afterwards
 * that lands on a registered module returns a virtual module whose body is
 * the factory's return value (vitest's module-mock semantics, hoisted by the
 * transform instead of the loader). The registry lives only inside the
 * adapter process (node --test runs each file in its own process). */
const MOCK_URL_PREFIX = 'cad-mock:?for=';

/** Reads a module's static export names (declaration exports and
 * `export { ... }` lists) so a virtual mock module still serves every name
 * an importer may reference, with the mock overriding same-name exports
 * (vitest merges the mock over the real module this way). */
function readModuleExports(absHref) {
  const text = fs.readFileSync(fileURLToPath(absHref), 'utf8');
  const out = new Set();
  for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const piece of m[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  return [...out];
}

/** Statically lists the top-level keys a mock factory returns. Declared
 * limitation (documented in the runtime adapter): the factory must return a
 * flat object literal (keys parsed textually) — the current mock users in
 * signatures all do exactly that. */
function mockKeys(factorySrc) {
  const m = factorySrc.match(/\(\s*\{([\s\S]*)\}\s*\)\s*$/);
  if (!m) return [];
  return [...m[1].matchAll(/(^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g)].map((x) => x[2]);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest' || specifier.startsWith('vitest/')) {
    return { url: new URL('./index.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (process.env.CAD_RUNTIME_HELPERS === '1'
    && typeof context.parentURL === 'string' && context.parentURL.includes('/tests/')) {
    const base = new URL('../runtime/', import.meta.url);
    if (specifier === './helpers/worker-harness.js') {
      return { url: new URL('worker-harness.mjs', base).href, shortCircuit: true };
    }
    if (specifier === './helpers/fake-puter.js') {
      return { url: new URL('fake-puter.mjs', base).href, shortCircuit: true };
    }
  }
  const resolved = await nextResolve(specifier, context);
  const factories = globalThis.__CAD_MOCK_FACTORIES__;
  // An import carrying the ?__cad_real query explicitly wants the real
  // module behind a mock (the virtual mock module re-exports from it).
  if (factories && !resolved.url.includes('?__cad_real=') && factories.has(resolved.url)) {
    return { url: MOCK_URL_PREFIX + encodeURIComponent(resolved.url), shortCircuit: true };
  }
  return resolved;
}

/** Extracts every `vi.mock('<spec>', factory)` statement from a test file:
 * registers the factory against the absolute target module and returns the
 * source with those statements removed (they must not run: registration
 * already happened, running them again would double-register). */
function extractMocks(source, fileUrl, registry) {
  let out = '';
  let i = 0;
  const uses = [];
  while (true) {
    const at = source.indexOf('vi.mock(', i);
    if (at === -1) { out += source.slice(i); break; }
    // find the matching close paren of the call
    let depth = 0;
    let end = at;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) { end += 1; break; } }
    }
    const call = source.slice(at, end);
    const m = call.match(/^vi\.mock\(\s*(['"])([^'"]+)\1\s*,\s*([\s\S]*)$/);
    if (!m) throw new Error(`[upstream adapter] vi.mock could not be parsed in ${fileUrl}: ${call.slice(0, 80)}`);
    const spec = m[2];
    // factory: everything up to (but not including) the final ')'
    const factorySrc = call.slice(call.indexOf(',') + 1, call.length - 1).trim().replace(/;$/, '');
    const abs = new URL(spec, fileUrl).href;
    if (registry.has(abs)) throw new Error(`[upstream adapter] double vi.mock for ${spec} in ${fileUrl}`);
    // the factory runs outside module scope: `vi` is not in scope there, so
    // rewrite every vi.* reference to the shim global.
    registry.set(abs, {
      factorySrc: factorySrc.replace(/\bvi\./g, 'globalThis.__CAD_VI__.'),
      keys: [...new Set([...mockKeys(factorySrc), ...readModuleExports(abs)])],
    });
    uses.push(at);
    out += source.slice(i, at);
    // skip an optional trailing semicolon/whitespace before the next source
    i = end;
    if (source[i] === ';') i += 1;
  }
  return { source: out, uses };
}

/** Vite's ?raw import is used by signatures to embed its worker source. */
export async function load(url, context, nextLoad) {
  if (url.endsWith('?raw')) {
    const sourcePath = fileURLToPath(url.slice(0, -4));
    const source = fs.readFileSync(sourcePath, 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(source)};`, shortCircuit: true };
  }
  if (url.startsWith(MOCK_URL_PREFIX)) {
    const href = decodeURIComponent(url.slice(MOCK_URL_PREFIX.length));
    const entry = globalThis.__CAD_MOCK_FACTORIES__.get(href);
    if (!entry) throw new Error(`[upstream adapter] missing mock factory for ${href}`);
    // Self-contained virtual module: the factory inlined verbatim (it runs at
    // module evaluation on the main thread, where the shim's `vi` lives),
    // merged over the real module's namespace. Loader-thread globals are NOT
    // shared with the main thread, so nothing here may read them at runtime —
    // the keys needed for static export declarations were computed at
    // registration and passed through generated source. Every mock name
    // overrides the real module's same-name export (vitest's semantics).
    const source = [
      `import { vi } from 'vitest';`,
      `import * as __real from ${JSON.stringify(`${href}?__cad_real=1`)};`,
      `const __mock = (${entry.factorySrc})();`,
      `const __ns = { ...__real, ...__mock };`,
    ];
    for (const keyOut of entry.keys) {
      if (keyOut === 'default') continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(keyOut)) continue;
      source.push(`export const ${keyOut} = __ns[${JSON.stringify(keyOut)}];`);
    }
    if (entry.keys.includes('default')) {
      source.push(`export default __ns['default'];`);
    }
    return { format: 'module', source: source.join('\n') + '\n', shortCircuit: true };
  }
  // The real module behind a mock, imported with the ?__cad_real query: read
  // it directly (the default loader does not accept query strings on file
  // URLs reliably).
  if (url.includes('?__cad_real=')) {
    const realUrl = url.split('?')[0];
    const text = fs.readFileSync(fileURLToPath(realUrl), 'utf8');
    return { format: 'module', source: text, shortCircuit: true };
  }
  // Transform pass for upstream test files: hook vi.mock registration in
  // BEFORE the file's imports resolve (a module's deps are resolved after
  // the module source is read, so registration here is genuinely hoisted).
  const res = await nextLoad(url, context);
  const sourceText = typeof res?.source === 'string' ? res.source : (res?.source ? String(res.source) : '');
  if (sourceText.includes('vi.mock(')
    && /\/upstream\/src\/.*\/tests\/[^/]+\.test\.js$/.test(url)) {
    globalThis.__CAD_MOCK_FACTORIES__ = globalThis.__CAD_MOCK_FACTORIES__ ?? new Map();
    const { source } = extractMocks(sourceText, url, globalThis.__CAD_MOCK_FACTORIES__);
    return { ...res, source, shortCircuit: true };
  }
  return res;
}
