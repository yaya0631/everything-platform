/**
 * Building apps from the pristine HeyPuter/everything clone (user-approved
 * setup-time work, one app at a time):
 *
 *   npm ci (or npm install when a lockfile ships)  â€” gitignored node_modules only
 *   npm run build [-- --base=/h/<name>/]           â€” vite picks the flag up
 *   git status --porcelain                          â€” abort when the clone is dirty
 *
 * The clone stays pristine: tracked files never change. Build outputs are
 * imported into cad-home's data folder; `--prune` removes node_modules again.
 * Everything here is plain Node with no shell scripting, so it works on Windows.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from './config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The platform root. */
const ROOT_DIR = path.resolve(HERE, '..');
export { ROOT_DIR };

export class BuildError extends Error {}

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GIT = process.platform === 'win32' ? 'git.exe' : 'git';
/** Memory cap for builds: passed to every Node child (later flag wins). */
const MEM = '--max-old-space-size=3072';

/** The clone root from the everythingDir setting (default ../upstream). */
export function upstreamRoot() {
  const raw = String(config.get('everythingDir') || '').trim();
  const p = path.resolve(ROOT_DIR, raw);
  if (!fs.existsSync(path.join(p, 'src'))) {
    throw new BuildError(
      `"${raw}" is not an HeyPuter/everything checkout. 'git clone ${'https://github.com/HeyPuter/everything'}' into it, or set Everything dir in Admin â†’ Hub.`,
    );
  }
  return p;
}

export function appSourceDir(name) {
  const dir = path.join(upstreamRoot(), 'src', name);
  if (!fs.existsSync(path.join(dir, 'package.json'))) throw new BuildError(`No app "${name}" in ${dir} (no package.json).`);
  return dir;
}

function run(cmd, args, { cwd, quiet } = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // Node refuses to spawn .cmd/.bat files without a shell (Windows safety
    // rule since Node 20.12), and npm is npm.cmd there. Our args never
    // contain spaces or shell metacharacters, so cmd.exe joining is safe.
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} ${MEM}`.trim() },
  });
  if (res.error) throw new BuildError(`${cmd} could not run: ${res.error.message}`);
  if (res.status !== 0) {
    const tail = `${res.stdout || ''}\n${res.stderr || ''}`.split(/\r?\n/).filter(Boolean).slice(-25).join('\n');
    throw new BuildError(`${cmd} ${args.join(' ')} failed (${res.status}):\n${tail}`);
  }
  return { stdout: res.stdout, stderr: res.stderr };
}

/** The clone's HEAD sha, or null when everythingDir is not a git clone. */
export function cloneSha() {
  const res = spawnSync(GIT, ['-C', upstreamRoot(), 'rev-parse', 'HEAD'], { encoding: 'utf8', shell: false });
  const sha = String(res.stdout || '').trim();
  return res.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** null when clean; a readable report when not. */
export function cloneDirty() {
  const res = spawnSync(GIT, ['-C', upstreamRoot(), 'status', '--porcelain'], { encoding: 'utf8', shell: false });
  if (res.status !== 0) return { note: 'everythingDir is not a git clone â€” the pristine-copy check was skipped.' };
  const lines = String(res.stdout || '').split(/\r?\n/).filter(Boolean);
  return lines.length ? { lines } : null;
}

/** The vite base setting written in the app's own config, if any. */
function declaredBase(dir) {
  for (const f of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
    const file = path.join(dir, f);
    if (!fs.existsSync(file)) continue;
    const m = /\bbase\s*:\s*['"]([^'"]+)['"]/.exec(fs.readFileSync(file, 'utf8'));
    if (m) return m[1];
  }
  return null;
}

/** JSON.parse tolerant of a UTF-8 BOM (a PowerShell-edited upstream file). */
const parseTolerant = (text) => JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Versions npm actually resolved, read straight from node_modules after install. */
export function resolvedDeps(dir) {
  const pkg = parseTolerant(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const out = {};
  for (const [name, wanted] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const pj = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
    try {
      const v = parseTolerant(fs.readFileSync(pj, 'utf8')).version;
      out[name] = `${v} (wanted ${wanted})`;
    } catch {
      out[name] = `not resolved (wanted ${wanted})`;
    }
  }
  return out;
}

/**
 * Build one app. Returns { distDir, base, baseForced, sha, deps, pathIssues }.
 * base: 'relative' when the app already uses relative asset URLs,
 * otherwise the absolute /h/<name>/ base path forced on the vite command.
 */
export function buildApp(name, { prune = false } = {}) {
  const dir = appSourceDir(name);
  const pkg = parseTolerant(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (!pkg.scripts?.build) throw new BuildError(`${name} has no build script.`);

  const lockfile = fs.existsSync(path.join(dir, 'package-lock.json'));
  if (lockfile) {
    console.log(`  dependencies: npm ci --ignore-scripts (lockfile shipped with ${name})`);
    run(NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
  } else {
    console.log('  dependencies: npm install --ignore-scripts (no lockfile; not recorded, never committed)');
    run(NPM, ['install', '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir });
  }

  const base = declaredBase(dir);
  const isVite = (pkg.devDependencies && pkg.devDependencies.vite) || (pkg.dependencies && pkg.dependencies.vite);
  const viteConfigured = isVite || fs.existsSync(path.join(dir, 'vite.config.js'));
  const forceBase = !viteConfigured ? null : base && !base.startsWith('/') ? null : `/h/${name}/`;
  const buildArgs = ['run', 'build', '--silent'];
  if (forceBase) buildArgs.push('--', `--base=${forceBase}`);
  console.log(`  build: npm ${buildArgs.join(' ')}${forceBase ? '' : ' (asset URLs left as the app configures them)'}`);
  run(NPM, buildArgs, { cwd: dir });

  const distDir = path.join(dir, distLayout(dir));
  if (!fs.existsSync(path.join(distDir, 'index.html'))) throw new BuildError(`${name} finished without dist/index.html.`);
  materializeWorkers(name, dir, distDir);
  const deps = resolvedDeps(dir);
  const unresolved = Object.entries(deps).filter(([, v]) => v.startsWith('not resolved')).map(([k]) => k);
  if (unresolved.length) console.log(`  note: ${unresolved.length} declared dependency versions not resolvable from node_modules`);
  if (prune) {
    console.log('  prune: removing node_modules again');
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  }
  return { distDir, base: forceBase || 'relative', sha: cloneSha(), title: pkg.name || name, description: pkg.description || '', deps };
}

/**
 * §10 worker onboarding for apps whose packaged-worker sources live only in
 * src/workers (their build bundles the code but ships no dist/workers/ dir).
 * Listed pairs are copied verbatim — renamed where the app's fixed worker URL
 * requires it (signatures hard-codes `signatures-email.puter.work`, so the
 * packaged row must be named `signatures-email`, not `email-worker`). Workers
 * the app deploys PER USER at runtime (signatures' sign-worker) are NOT
 * copy-listed: they go through workers.create like any member deployment.
 * The upstream clone is never touched.
 */
const WORKER_COPY = {
  invoicing: { 'email-worker.js': 'invoicing-email.js' },
  signatures: { 'email-worker.js': 'signatures-email.js' },
};

function materializeWorkers(name, dir, distDir) {
  const pairs = WORKER_COPY[name];
  if (!pairs) return;
  const srcDir = path.join(dir, 'src', 'workers');
  const destDir = path.join(distDir, 'workers');
  let copied = 0;
  for (const [from, to] of Object.entries(pairs)) {
    const src = path.join(srcDir, from);
    if (!fs.existsSync(src)) throw new BuildError(`${name} materialization: missing ${from} in src/workers.`);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, path.join(destDir, to));
    copied += 1;
  }
  if (copied) console.log(`  dist: materialized ${copied} packaged worker source(s) into dist/workers from src/workers (§10 onboarding)`);
}

function distLayout(dir) {
  // Standard vite layout; apps that build elsewhere say where (outDir in config).
  if (fs.existsSync(path.join(dir, 'dist'))) return 'dist';
  if (fs.existsSync(path.join(dir, 'build'))) return 'build';
  if (fs.existsSync(path.join(dir, 'public-build'))) return 'public-build';
  throw new BuildError(`Could not find were ${path.basename(dir)} put its build output (dist/, build/, public-build/).`);
}

/** Delete a built app's node_modules without touching anything else. */
export function pruneNodeModules(name) {
  fs.rmSync(path.join(appSourceDir(name), 'node_modules'), { recursive: true, force: true });
}
