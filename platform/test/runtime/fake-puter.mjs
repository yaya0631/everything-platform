/**
 * RUNTIME variant of upstream `signatures/tests/helpers/fake-puter.js`.
 * Same import surface (makeFs / makeFakePuter / re-exported makeKv), with the
 * app-side slices backed by the cad-home runtime: makeFs goes through
 * lib/hub-fsops.js (the same transport the parent's me frame uses) and makeKv
 * comes from the runtime worker harness (lib/hub-kv.js transport).
 *
 * Not in scope yet (declared): makeFakePuter's full fake (auth/workers/fetchTo)
 * is not runtime-ported; using it right now fails LOUDLY instead of silently
 * falling back to upstream-only fakes, which would understate coverage.
 */
import { vi } from '../vitest-shim/index.mjs';
import { makeKv, makeFs } from './worker-harness.mjs';

export { makeKv };
export { makeFs };

export function makeFakePuter() {
  throw new Error(
    'makeFakePuter is not runtime-ported yet: this case would run on upstream-only '
    + 'fakes and not count as cad-home runtime coverage. Map it or exclude it explicitly.',
  );
}
