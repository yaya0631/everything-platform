# Vendored Pyodide (for the 3d app)

The 3d app's Python console loads Pyodide lazily. Upstream pinned
`pyodide@314.0.7` as a dev dependency and fetched the runtime from
`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/` at first use. That is a CDN
dependency and is blocked by this hub's `script-src 'self'` CSP, so a local
copy ships here. The served 3d bundle is rewritten from the jsDelivr URL to
`/hub/pyodide/` at serve time (see `lib/hub-rewrite.js`); the vendor folder is
never exposed as a general file server (see `servePyodideFile` in
`lib/hub.js`).

Source: the `pyodide` npm package at version **314.0.7**, already present in
`upstream/src/3d/node_modules/pyodide` when the 3d app was built. Only the core
runtime files are copied; no PyPI packages, no micropip, no CDN fetches:

| File | Bytes | Purpose |
|---|---:|---|
| `pyodide.mjs` | 17,931 | ES module entry point |
| `pyodide.asm.mjs` | 1,250,344 | Emscripten glue |
| `pyodide.asm.wasm` | 9,598,218 | CPython + runtime WebAssembly |
| `python_stdlib.zip` | 2,545,637 | Python standard library |
| `pyodide-lock.json` | 119,077 | package metadata for the pinned release |

License: Pyodide is MPL-2.0; CPython and the Python standard library are under
the PSF license. `LICENSE` here is the MPL-2.0 text; the 3d app's
`THIRD_PARTY_NOTICES.md` names Pyodide as well. Keep this notice with the files
when redistributing.

To update: point the 3d build at a newer `pyodide` dependency, copy the five
files from that package into this folder, update the version/table above, and
change the version regex in `lib/hub-rewrite.js` only if the URL shape changes.
