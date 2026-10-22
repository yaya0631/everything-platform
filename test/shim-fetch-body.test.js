import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the shim never chains Request construction; a body may enter exactly one Request', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const read = (rel) => fs.readFileSync(path.join(here, '..', 'lib', 'shim', rel), 'utf8');

  const mapper = read('worker-url-map.js');
  // The worker-alias boundary: one mapped Request carrying the caller's body.
  // A chained `new Request(url, someRequest)` detaches the body stream in a
  // real browser and uploads die mid-flight (real-Chromium e2e proof).
  assert.ok(!/new\s+Request\s*\([^,()]+,\s*request\s*\)/.test(mapper), 'url-map must not rebuild a Request from a Request');
  assert.ok(/new\s+Request\s*\(\s*mappedUrl\s*,\s*init\s*\)/.test(mapper), 'url-map maps init straight onto the local URL');

  const shim = read('puter.js');
  // puter.js re-homes puter.site hosts only; a Request whose URL it does not
  // rewrite must be handed on untouched so its body stream stays intact.
  const fetchAt = shim.indexOf('window.fetch = function');
  const body = shim.slice(fetchAt, fetchAt + 1500);
  assert.ok(/reqMapped === reqUrl\)\s*return nativeFetch\(input,\s*init\)/.test(body), 'unchanged URLs keep the original Request object');
  assert.ok(!/new Request\([^,()]+,\s*input\s*\)/.test(body), 'shim fetch must not rebuild a Request from a Request');
});
