/**
 * Vitest-API shim for the upstream adapter: lets cad-home run an upstream
 * test file UNMODIFIED under node:test (driven by test/rsvp-upstream.test.js
 * through a module resolve hook that maps `vitest` here). Only the APIs that
 * file actually uses are implemented — an upstream upgrade adding a new
 * matcher fails deliberately and loudly, which forces review of the shim.
 *
 * Semantics carried across: describe/it(=test) nesting, beforeEach per case,
 * expect(actual, message?) with the matcher set below, and `vi.fn` spies
 * (mock.calls + mockClear + mockImplementation — what the worker harness
 * and the tests touch).
 */
const state = { suites: [], loose: [] };

/* File-level hook scopes. Upstream files may register beforeEach/afterEach at
 * top level (applies to every case of THAT file). The adapter opens one scope
 * per imported file with openFileScope(); describes and file hooks inside it
 * get attributed to it. Files that never open a scope share the default
 * scope, which keeps the shape older adapters see unchanged. */
const defaultScope = { beforeEach: [], afterEach: [], suites: [] };
const scopes = [defaultScope];
let currentScope = defaultScope;
export function openFileScope() {
  currentScope = { beforeEach: [], afterEach: [], suites: [] };
  scopes.push(currentScope);
  return currentScope;
}

const pushIt = (name, fn) => {
  const holder = state.suites.at(-1);
  const entry = { name, fn };
  if (holder) holder.its.push(entry);
  else state.loose.push(entry);
};

export function describe(name, fn) {
  const suite = { name, beforeEach: [], afterEach: [], its: [] };
  state.suites.push(suite);
  currentScope.suites.push(suite);
  // NB: suites are never popped from state.suites — casesOf() snapshots the
  // whole accumulated list after the module imports finish. describeDepth
  // tracks which hooks actually belong to a suite body: hooks registered at
  // top level of the FILE go to the file scope (vitest's semantics).
  describeDepth += 1;
  try {
    fn();
  } finally {
    describeDepth -= 1;
  }
}
let describeDepth = 0;

export const it = (name, fn) => pushIt(name, fn);
it.each = (rows) => (name, fn) => {
  for (const row of rows) {
    const values = Array.isArray(row) ? row : [row];
    let index = 0;
    const title = String(name).replace(/%[sdifoOj]/g, () => String(values[index++]));
    pushIt(title, () => fn(...values));
  }
};
export const test = it;
export const beforeEach = (fn) => {
  const holder = describeDepth > 0 ? state.suites.at(-1) : null;
  if (holder) holder.beforeEach.push(fn);
  else currentScope.beforeEach.push(fn);
};

export const afterEach = (fn) => {
  const holder = describeDepth > 0 ? state.suites.at(-1) : null;
  if (holder) holder.afterEach.push(fn);
  else currentScope.afterEach.push(fn);
};
export const afterAll = it;
export const beforeAll = it;
export const inject = it; // vitest-only APIs: the file must not use these

export function viFn(impl) {
  const mock = { calls: [] };
  const measure = { current: impl, once: [] };
  const fn = (...args) => {
    mock.calls.push(args);
    if (measure.once.length) {
      const next = measure.once.shift();
      // A once-queue entry either resolves/rejects with a canned value or
      // falls through to a one-shot implementation.
      if (next && next.reject) return Promise.reject(next.error);
      if (next && next.resolve !== undefined) return Promise.resolve(next.resolve);
      return next(...args);
    }
    return measure.current?.(...args);
  };
  fn.mock = mock;
  fn.getSimpleName = () => 'vi.fn()';
  fn.mockClear = () => { mock.calls.length = 0; return fn; };
  fn.mockReset = () => { mock.calls.length = 0; measure.current = impl; measure.once.length = 0; return fn; };
  fn.mockImplementation = (next) => { measure.current = next; return fn; };
  fn.getMockImplementation = () => measure.current;
  fn.mockReturnValueOnce = (value) => { measure.once.push(() => value); return fn; };
  fn.mockRejectedValueOnce = (error) => { measure.once.push({ reject: true, error }); return fn; };
  fn.mockResolvedValueOnce = (value) => { measure.once.push({ resolve: value }); return fn; };
  fn.mockReturnValue = (value) => { measure.current = () => value; return fn; };
  fn.mockResolvedValue = (value) => { measure.current = () => Promise.resolve(value); return fn; };
  fn.mockRejectedValue = (error) => { measure.current = () => Promise.reject(error); return fn; };
  spyRegistry.add(fn);
  return fn;
}

/** Every spy the shim made (vi.mock's factories included) — clearAllMocks
 * sweeps these, mirroring vitest's global mock clearing. */
const spyRegistry = new Set();

/** Global-stub bookkeeping for vi.stubGlobal / vi.unstubAllGlobals. */
const globalStubs = new Map();

export const vi = {
  fn: viFn,
  // Module mocking happens in the loader: hooks.mjs rewrites test files that
  // call vi.mock at load time and serves the factory result as a virtual
  // module, which is the hoisted semantics a plain runtime cannot get by
  // running the call. This hook therefore stays a loud no-op.
  mock() {
    throw new Error('[upstream adapter] vi.mock only works through the load-time transform (hooks.mjs); '
      + 'a call reaching here means the file was loaded outside that path.');
  },
  clearAllMocks: () => { for (const fn of spyRegistry) { fn.mock.calls.length = 0; } },
  resetAllMocks: () => { for (const fn of spyRegistry) fn.mockReset(); },
  stubGlobal: (name, value) => {
    globalStubs.set(name, Object.prototype.hasOwnProperty.call(globalThis, name)
      ? { had: true, value: globalThis[name] }
      : { had: false });
    globalThis[name] = value;
  },
  unstubAllGlobals: () => {
    for (const [name, prev] of globalStubs) {
      if (prev.had) globalThis[name] = prev.value;
      else delete globalThis[name];
    }
    globalStubs.clear();
  },
};

globalThis.__CAD_VI__ = vi;
globalThis.__CAD_MOCK_NAMESPACES__ = globalThis.__CAD_MOCK_NAMESPACES__ ?? new Map();

/* -- expect --------------------------------------------------------------- */

const fmt = (v) => {
  if (typeof v === 'string') return `"${v}"`;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};

function deepEq(a, b) {
  // vitest `toEqual` shape: object graphs compared structurally, arrays and
  // primitives by value; `undefined` properties are ignorable on both sides.
  const asy = asym(b);
  if (asy) return asy(a);
  if (a === b) return true;
  if (a == null || b == null) return a === b || (a == null && b === undefined) || (b == null && a === undefined);
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEq(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEq(a[k], b[k]));
  }
  return false;
}

/** Asymmetric matchers (expect.stringMatching/stringContaining/anything):
 * tagged so deepEq and the spy-arg matcher recognize them as predicates over
 * the ACTUAL value instead of structural shapes. */
const asym = (e) => {
  if (!e || typeof e !== 'object' || !e.__cadAsym) return null;
  if (e.__cadAsym === 'stringMatching') return (a) => e.re.test(String(a));
  if (e.__cadAsym === 'stringContaining') return (a) => String(a).includes(e.s);
  if (e.__cadAsym === 'anything') return (a) => a !== null && a !== undefined;
  return null;
};

function subset(actual, sub) {
  for (const [k, want] of Object.entries(sub)) {
    if (!(k in actual)) return false;
    if (want && typeof want === 'object' && typeof actual[k] === 'object') {
      if (!subset(actual[k], want)) return false;
    } else if (!deepEq(actual[k], want)) return false;
  }
  return true;
}

const make = (actual, msg, negate) => {
  const api = {};
  const fail = (text) => new Error(`[upstream adapter] ${msg ? `${msg}: ` : ''}${text}${negate ? ' (negated matcher)' : ''}`);
  const check = (ok, text) => {
    if (negate ? ok : !ok) throw fail(text);
    return undefined;
  };
  Object.defineProperty(api, 'not', { get: () => make(actual, msg, !negate) });
  Object.defineProperty(api, 'rejects', { get: () => ({
    toThrow: async (expected) => {
      let thrown = null;
      try { await actual; } catch (err) { thrown = err; }
      if (!thrown) throw fail('expected promise to reject');
      const message = String(thrown?.message ?? thrown);
      const matches = expected === undefined
        || (expected instanceof RegExp && expected.test(message))
        || (typeof expected === 'string' && message.includes(expected))
        || (typeof expected === 'function' && thrown instanceof expected);
      check(matches, `expected rejection ${fmt(message)} to match ${fmt(expected)}`);
    },
  }) });
  Object.defineProperty(api, 'resolves', { get: () => ({
    toMatchObject: async (expected) => {
      const value = await actual;
      check(subset(value ?? {}, expected), `expected resolved ${fmt(value)} to match object ${fmt(expected)}`);
    },
  }) });
  Object.assign(api, {
    toBe: (expected) => check(Object.is(actual, expected), `expected ${fmt(actual)} to be ${fmt(expected)}`),
    toBeInstanceOf: (cls) => check(actual instanceof cls, `expected ${fmt(actual)} to be instanceof ${cls?.name ?? String(cls)}`),
    toEqual: (expected) => check(deepEq(actual, expected), `expected ${fmt(actual)} to equal ${fmt(expected)}`),
    toBeNull: () => check(actual === null, `expected ${fmt(actual)} to be null (undefined is not null)`),
    toBeUndefined: () => check(actual === undefined, `expected ${fmt(actual)} to be undefined`),
    toBeTruthy: () => check(!!actual, `expected ${fmt(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `expected ${fmt(actual)} to be falsy`),
    toBeGreaterThan: (n) => check(typeof actual === 'number' && actual > n, `expected ${fmt(actual)} > ${n}`),
    toBeGreaterThanOrEqual: (n) => check(typeof actual === 'number' && actual >= n, `expected ${fmt(actual)} >= ${n}`),
    toBeLessThan: (n) => check(typeof actual === 'number' && actual < n, `expected ${fmt(actual)} < ${n}`),
    toBeLessThanOrEqual: (n) => check(typeof actual === 'number' && actual <= n, `expected ${fmt(actual)} <= ${n}`),
    toContain: (n) => check(
      (typeof actual === 'string' && actual.includes(n))
      || (Array.isArray(actual) && actual.some((v) => deepEq(v, n))),
      `expected ${fmt(actual)} to contain ${fmt(n)}`,
    ),
    toHaveLength: (n) => check(
      (Array.isArray(actual) || typeof actual === 'string') && actual.length === n,
      `expected length ${n}, got ${fmt(actual?.length)}`,
    ),
    toHaveProperty: function (key, expected) {
      const parts = Array.isArray(key) ? key : String(key).split('.');
      let value = actual;
      for (const part of parts) {
        if (value == null || !Object.prototype.hasOwnProperty.call(value, part)) {
          return check(false, `expected ${fmt(actual)} to have property ${fmt(key)}`);
        }
        value = value[part];
      }
      const matches = arguments.length < 2 || deepEq(value, expected);
      return check(matches, `expected property ${fmt(key)} to be ${fmt(expected)}, got ${fmt(value)}`);
    },
    toMatch: (re) => check(new RegExp(re.source ?? re, re.flags ?? '').test(actual), `expected ${fmt(actual)} to match ${re}`),
    toMatchObject: (sub) => check(subset(actual ?? {}, sub), `expected ${fmt(actual)} to match object ${fmt(sub)}`),
    toHaveBeenCalled: () => check((actual?.mock?.calls?.length ?? 0) > 0, 'expected the spy to have been called'),
    toHaveBeenCalledTimes: (n) => check((actual?.mock?.calls?.length ?? 0) === n, `expected spy call count ${n}, got ${actual?.mock?.calls?.length ?? 0}`),
    // vitest's spy-argument matcher: a call matches when every argument
    // deep-equals the expected value in order; trailing expected arguments
    // that are `undefined` may be absent on the actual call (optional args).
    toHaveBeenCalledWith: (...expected) => {
      const calls = actual?.mock?.calls ?? [];
      const matchesCall = (args) => args.length <= expected.length
        && args.every((v, i) => deepEq(v, expected[i]))
        && expected.slice(args.length).every((e) => e === undefined);
      return check(calls.some(matchesCall),
        `expected the spy to have been called with ${fmt(expected)}, calls: ${fmt(calls)}`);
    },
  });
  return api;
};

export function expect(actual, msg) {
  return make(actual, typeof msg === 'string' ? msg : '', false);
}
// vitest statics: asymmetric matchers hang off expect itself.
expect.stringMatching = (re) => ({ __cadAsym: 'stringMatching', re });
expect.stringContaining = (s) => ({ __cadAsym: 'stringContaining', s });
expect.anything = () => ({ __cadAsym: 'anything' });

/* -- driver surface ------------------------------------------------------- */

export const casesOf = () => ({
  // Each suite gets its file scope's hooks grafted on: beforeEach file-first
  // (vitest's nesting order), afterEach suite-first (inner-out teardown).
  suites: scopes.flatMap((sc, i) => sc.suites.map((s) => ({
    name: s.name,
    fileIndex: i,
    beforeEach: [...sc.beforeEach, ...s.beforeEach],
    afterEach: [...s.afterEach, ...sc.afterEach],
    its: [...s.its],
  }))),
  loose: [...state.loose],
});

export const countCases = () => state.suites.reduce((n, s) => n + s.its.length, 0) + state.loose.length;
