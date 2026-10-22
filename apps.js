#!/usr/bin/env node
/**
 * Deploy and manage hosted web apps from the command line. Works while the
 * server is running (SQLite in WAL mode).
 *
 *   npm run app -- deploy <name> <folder> [--owner x] [--public] [--title "x"]
 *   npm run app -- list
 *   npm run app -- rollback <name>
 *   npm run app -- remove <name>
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './lib/store.js';
import * as apps from './lib/apps.js';
import { APPS_DIR } from './lib/paths.js';

const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith('--'));
const flag = (name) => flags.includes(`--${name}`);
const optionValue = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

const USAGE = `Usage:
  npm run app -- deploy <name> <folder> [--owner x] [--public] [--title "x"]
  npm run app -- list
  npm run app -- rollback <name>
  npm run app -- remove <name>`;

function fail(msg) {
  console.error(`Error: ${msg}`);
  console.error(USAGE);
  process.exit(1);
}

function pickOwner(explicit) {
  if (explicit) {
    const name = store.normalizeName(explicit);
    const a = store.getAccount(name);
    if (!a) throw new Error(`There is no account called "${name}".`);
    if (!apps.canHostApps(a)) throw new Error(`"${name}" cannot host apps. Run: npm run user -- host ${name}`);
    return name;
  }
  const admins = store.listUsers().filter((u) => !u.disabled && u.is_admin).sort((a, b) => a.name.localeCompare(b.name));
  if (!admins.length) throw new Error('No admin account exists. Create one with: npm run user -- add <name>, then pass --owner or make them a host with: npm run user -- host <name>');
  return admins[0].name;
}

async function deploy(name, folder, { owner, isPublic, title } = {}) {
  if (!apps.validName(name)) throw new Error('App names are 2 to 32 lowercase letters, digits or dashes, starting with a letter or digit.');
  const src = path.resolve(String(folder ?? ''));
  if (!fs.statSync(path.join(src, 'index.html')).isFile()) {
    throw new Error(`There is no index.html in ${path.basename(src)}. Pick the folder that holds the app itself.`);
  }
  const ownerName = pickOwner(owner);
  if (apps.get(name)) {
    const seen = apps.get(name);
    if (seen.owner !== ownerName && !store.getAccount(ownerName).is_admin) throw new Error(`"${name}" already belongs to ${seen.owner}. An admin needs to re-deploy it.`);
  }
  const files = [];
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(path.relative(src, full));
    }
  };
  walk(src);
  for (const rel of files) await apps.putStagingFile(name, rel, fs.readFileSync(path.join(src, rel)));
  const published = await apps.publish(name, { owner: ownerName, title, visibility: isPublic ? 'public' : 'private' });
  store.audit(ownerName, 'apps.published', { app: name, via: 'cli' });
  console.log(`Deployed ${files.length} file(s) to "${name}" for ${ownerName}.`);
  console.log(isPublic ? `Public page: /p/${name}/  (public apps are only reachable over the public link)` : `Private page: /apps/${name}/`);
  return published;
}

async function siteFileCount(name) {
  const walk = (p) => {
    let n = 0;
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      if (e.isDirectory()) n += walk(path.join(p, e.name));
      else if (e.isFile()) n++;
    }
    return n;
  };
  return walk(path.join(APPS_DIR, name, 'site'));
}

async function list() {
  const people = new Map(store.listUsers().map((u) => [u.name, u.display_name || u.name]));
  const rows = apps.list();
  if (!rows.length) {
    console.log('No apps deployed yet. Deploy one with: npm run app -- deploy <name> <folder>');
    return;
  }
  const wide = Math.max(...rows.map((r) => r.name.length), 4);
  for (const a of rows) {
    const pieces = [
      a.name.padEnd(wide),
      apps.isPublished(a.name) ? 'published' : 'NOT PUBLISHED',
      a.visibility === 'public' ? 'public ' : 'private',
      `${(await siteFileCount(a.name)).toLocaleString()} file(s)`,
      `owner ${people.get(a.owner) || a.owner}`,
    ];
    if (a.publicAi) pieces.push('public AI');
    if (a.publicEmail) pieces.push('public email');
    if (apps.hasPrevious(a.name)) pieces.push('rollback ready');
    console.log(pieces.join('  |  '));
    if (a.title || a.description) console.log(`    ${a.title}${a.description ? ` — ${a.description}` : ''}`);
  }
}

async function main() {
  if (cmd === 'deploy') {
    const [name, folder] = rest.filter((a) => !a.startsWith('--'));
    if (!name || !folder) return fail('A name and a folder are required.');
    return deploy(name, folder, { owner: optionValue('owner'), isPublic: flag('public'), title: optionValue('title') });
  }
  if (cmd === 'list') return list();
  if (cmd === 'rollback') {
    const name = rest[0];
    if (!name) return fail('An app name is required.');
    await apps.rollback(name);
    store.audit(apps.get(name)?.owner ?? null, 'apps.rolled_back', { app: name, via: 'cli' });
    console.log(`The previous version of "${name}" is live again.`);
    return;
  }
  if (cmd === 'remove') {
    const name = rest[0];
    if (!name) return fail('An app name is required.');
    const app = apps.requireApp(name);
    store.audit(app.owner, 'apps.removed', { app: name, via: 'cli' });
    apps.removeApp(name);
    console.log(`Removed "${name}" (it belonged to ${app.owner}).`);
    return;
  }
  return fail(`Unknown command "${cmd ?? ''}".`);
}

await main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
