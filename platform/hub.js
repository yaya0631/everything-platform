#!/usr/bin/env node
/**
 * Hub CLI: install, update and remove the apps built from the pristine
 * HeyPuter/everything clone.
 *
 *   npm run hub -- list
 *   npm run hub -- install <name> [--prune] [--from <dist-folder>]
 *   npm run hub -- update  <name> [--prune] [--force]
 *   npm run hub -- remove  <name>
 *   npm run hub -- status
 *
 * Setup-time work only: the clone stays pristine (npm touches only its
 * gitignored node_modules), builds are imported into the platform's data folder,
 * and the working copy must come out clean or the install aborts. One app is
 * built at a time. `--from` imports a dist folder built elsewhere instead of
 * npm-installing here.
 */
import path from 'node:path';
import * as hub from './lib/hub.js';
import * as build from './lib/hub-build.js';

const HELP = `Hub commands:
  npm run hub -- install <name> [--prune] [--from <dist-folder>]
  npm run hub -- update  <name> [--prune] [--force]
  npm run hub -- remove  <name>
  npm run hub -- list
  npm run hub -- status

  --prune          delete node_modules in the clone after a successful build
  --from <folder>  import a built dist/ instead of npm-installing and building
  --force          rebuild even when nothing changed
`;

function parse(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prune') flags.prune = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--from') flags.from = argv[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else flags._.push(a);
  }
  return flags;
}

function checkClone() {
  const root = build.upstreamRoot();
  console.log(`clone: ${root}`);
  console.log(`commit: ${build.cloneSha() || '(not a git clone)'}`);
  const dirty = build.cloneDirty();
  if (dirty) {
    if (dirty.lines) {
      console.error('The clone has local changes; install all — everything must stay pristine:');
      for (const l of dirty.lines) console.error(`  ${l}`);
      process.exitCode = 1;
    } else if (dirty.note) console.log(dirty.note);
  } else {
    console.log('clone state: clean');
  }
  return root;
}

function rowLine(a) {
  const kb = Math.max(1, Math.round(a.size / 1024));
  const off = a.enabled ? '' : ' [off]';
  const acc = a.access === 'users' ? ` (${a.users.length} person(s))` : '';
  const from = a.source === 'import' ? 'imported' : (a.sha ? `from ${a.sha.slice(0, 8)}` : '');
  return `  ${a.name.padEnd(24)} ${kb} KiB ${from} ${a.base === 'relative' ? 'relative URLs' : a.base}${off}${acc}  — ${a.title}`;
}

const commands = {
  help() {
    console.log(HELP);
  },

  list() {
    const apps = hub.listApps();
    console.log(apps.length ? `${apps.length} app(s) installed:` : 'No apps installed yet.');
    for (const a of apps) console.log(rowLine(a));
  },

  status() {
    checkClone();
    console.log('');
    commands.list();
  },

  async install(name, flags) {
    if (!name) throw new Error('Usage: npm run hub -- install <name>');
    let distDir;
    let meta;
    if (flags.from) {
      distDir = path.resolve(flags.from);
      checkClone();
      meta = { sha: build.cloneSha() || 'imported', base: 'relative', source: 'import', title: name };
    } else {
      checkClone();
      console.log(`building ${name} …`);
      const out = build.buildApp(name, { prune: flags.prune });
      distDir = out.distDir;
      meta = { sha: out.sha, base: out.base, source: 'build', title: out.title };
    }
    const app = hub.installFromDist(name, distDir, meta);
    console.log('');
    console.log(`installed: ${rowLine(app).trim()}`);
    console.log('clone status:');
    const dirty = build.cloneDirty();
    console.log(dirty?.lines?.length ? `  DIRTY:\n${dirty.lines.map((l) => `    ${l}`).join('\n')}` : '  clean');
  },

  async update(name, flags) {
    if (!name) throw new Error('Usage: npm run hub -- update <name>');
    const installed = hub.listApps().find((a) => a.name === name);
    if (!installed) throw new Error(`"${name}" is not installed — use install instead.`);
    checkClone();
    const sha = build.cloneSha();
    if (!flags.force && sha && installed.sha === sha) {
      console.log(`${name} was already built from this commit (${sha.slice(0, 8)}). Nothing to do (use --force to rebuild).`);
      return;
    }
    console.log(`rebuilding ${name} …`);
    const out = build.buildApp(name, { prune: flags.prune });
    const app = hub.installFromDist(name, out.distDir, { sha: out.sha, base: out.base, source: 'build', title: name });
    console.log(`updated: ${rowLine(app).trim()}`);
    const dirty = build.cloneDirty();
    console.log(dirty?.lines?.length ? `clone status: DIRTY\n${dirty.lines.join('\n')}` : 'clone status: clean');
  },

  async remove(name) {
    if (!name) throw new Error('Usage: npm run hub -- remove <name>');
    hub.removeApp(name);
    console.log(`removed ${name} (installed files and catalog row; the clone was never touched).`);
  },
};

async function main() {
  const flags = parse(process.argv.slice(2));
  if (flags.help || !flags._.length) return commands.help();
  const [cmd, name] = flags._;
  const fn = commands[cmd];
  if (!fn) throw new Error(`Unknown command "${cmd}".\n${HELP}`);
  await fn(name, flags);
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exitCode = 1;
});
