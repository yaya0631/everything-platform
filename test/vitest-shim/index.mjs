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

const pushIt = (name, fn) => {
  const holder = state.suites.at(-1);
  const entry = { name, fn };
  if (holder) holder.its.push(entry);
  else state.loose.push(entry);
};

export function describe(name, fn) {
  const suite = { name, beforeEach: [], its: [] };
  state.suites.push(suite);
  fn();
}

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
  const holder = state.suites.at(-1);
  if (!holder) throw new Error('beforeEach outside describe is not supported by the shim');
  holder.beforeEach.push(fn);
};

export const afterEach = it; // never used by the file; loud wrong usage fails as a no-op runner bug
export const afterAll = it;
export const beforeAll = it;
export const inject = it; // vitest-only APIs: the file must not use these

export function viFn(impl) {
  const mock = { calls: [] };
  const measure = { current: impl };
  const fn = (...args) => {
    mock.calls.push(args);
    return measure.current?.(...args);
  };
  fn.mock = mock;
  fn.getSimpleName = () => 'vi.fn()';
  fn.mockClear = () => { mock.calls.length = 0; return fn; };
  fn.mockReset = () => { mock.calls.length = 0; measure.current = impl; return fn; };
  fn.mockImplementation = (next) => { measure.current = next; return fn; };
  fn.getMockImplementation = () => measure.current;
  return fn;
}

export const vi = { fn: viFn };

/* -- expect --------------------------------------------------------------- */

const fmt = (v) => {
  if (typeof v === 'string') return `"${v}"`;
  try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
};

function deepEq(a, b) {
  // vitest `toEqual` shape: object graphs compared structurally, arrays and
  // primitives by value; `undefined` properties are ignorable on both sides.
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
  });
  return api;
};

export function expect(actual, msg) {
  return make(actual, typeof msg === 'string' ? msg : '', false);
}

/* -- driver surface ------------------------------------------------------- */

export const casesOf = () => ({
  suites: state.suites.map((s) => ({ name: s.name, beforeEach: [...s.beforeEach], its: [...s.its] })),
  loose: [...state.loose],
});

export const countCases = () => state.suites.reduce((n, s) => n + s.its.length, 0) + state.loose.length;
