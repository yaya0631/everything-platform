#!/usr/bin/env node
/**
 * Manage who can sign in to your CAD server. Changes apply immediately,
 * even while the server is running.
 *
 *   npm run user -- add <name> [--admin] [--email x]  create an account (the first one is an admin)
 *   npm run user -- passwd <name>                     change a password (signs them out everywhere)
 *   npm run user -- remove <name> [--delete-files]    remove an account (drawings are kept unless --delete-files)
 *   npm run user -- admin <name> [--off]              make someone an admin, or stop them being one
 *   npm run user -- host <name> [--off]               allow someone to host web apps and functions
 *   npm run user -- email <name> <address>            set the email address for invites and resets
 *   npm run user -- list                              show all accounts
 */
import * as store from './lib/store.js';
import './lib/history.js';

const [cmd, rawName, ...rest] = process.argv.slice(2);
const name = store.normalizeName(rawName);
const flags = rest.filter((a) => a.startsWith('--'));
const optionValue = (flag) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};
const USAGE = `Usage:
  npm run user -- add <name> [--admin] [--email you@example.com]
  npm run user -- passwd <name>
  npm run user -- remove <name> [--delete-files]
  npm run user -- admin <name> [--off]
  npm run user -- host <name> [--off]
  npm run user -- email <name> <address>
  npm run user -- list`;

function needAccount() {
  needName();
  if (!store.getAccount(name)) throw new Error(`There is no account called "${name}".`);
}

// Piped input (for scripts) is read once up front; a terminal gets a hidden prompt.
let piped = null;
async function ask(question) {
  if (!process.stdin.isTTY) {
    if (!piped) {
      let text = '';
      for await (const c of process.stdin) text += c;
      piped = text.split(/\r?\n/);
    }
    return piped.shift() ?? '';
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword() {
  for (;;) {
    const a = await ask(`Password (at least ${store.MIN_PASSWORD} characters): `);
    if (a.length < store.MIN_PASSWORD) {
      console.log('That password is too short.');
      if (!process.stdin.isTTY) process.exit(1);
      continue;
    }
    const b = await ask('Type it again: ');
    if (a === b) return a;
    console.log('The passwords did not match.');
    if (!process.stdin.isTTY) process.exit(1);
  }
}

function needName() {
  if (!store.validName(name)) {
    console.error(rawName ? `"${rawName}" is not a valid username. ${store.NAME_RULES}` : 'Give a username, for example: npm run user -- add alex');
    process.exit(1);
  }
}

try {
  if (cmd === 'add') {
    needName();
    if (store.getAccount(name)) throw new Error(`"${name}" already has an account.`);
    const email = optionValue('--email');
    if (email && !store.validEmail(email)) throw new Error(`"${email}" is not a valid email address.`);
    const { admin } = store.addUser(name, await newPassword(), { admin: flags.includes('--admin'), email });
    console.log(`Added "${name}". They can now sign in from the CAD app.`);
    if (admin) console.log(`"${name}" is an admin and can open the admin panel from the account menu.`);
  } else if (cmd === 'passwd') {
    needAccount();
    store.setPassword(name, await newPassword());
    console.log(`Changed the password for "${name}" and signed them out on every device.`);
  } else if (cmd === 'remove') {
    needName();
    const deleteFiles = flags.includes('--delete-files');
    store.removeUser(name, { deleteFiles });
    console.log(deleteFiles ? `Removed "${name}" and deleted their drawings.` : `Removed "${name}". Their drawings are still in ${store.userRoot(name)}.`);
  } else if (cmd === 'admin') {
    needAccount();
    const off = flags.includes('--off');
    store.updateUser(name, { isAdmin: !off });
    store.audit('cli', off ? 'user.admin_off' : 'user.admin_on', { user: name });
    console.log(off ? `"${name}" is no longer an admin.` : `"${name}" is now an admin.`);
  } else if (cmd === 'host') {
    needAccount();
    const off = flags.includes('--off');
    store.updateUser(name, { canHostApps: !off });
    store.audit('cli', off ? 'user.host_off' : 'user.host_on', { user: name });
    console.log(off ? `"${name}" can no longer host apps.` : `"${name}" can now host web apps and functions. Functions run code on this PC, so only allow people you trust.`);
  } else if (cmd === 'email') {
    needAccount();
    const address = rest.find((a) => !a.startsWith('--')) ?? '';
    store.updateUser(name, { email: address });
    console.log(address ? `Set the email for "${name}" to ${address}.` : `Removed the email address for "${name}".`);
  } else if (cmd === 'list') {
    const users = store.listUsers();
    if (!users.length) console.log('No accounts yet. Add one with: npm run user -- add <name>');
    for (const u of users) {
      const tags = [u.is_admin && 'admin', u.can_host_apps && 'hosts apps', u.disabled && 'disabled', !u.hash && 'invited'].filter(Boolean).join(', ');
      console.log(`${u.name.padEnd(34)} added ${u.created?.slice(0, 10) ?? ''}${u.email ? `  ${u.email}` : ''}${tags ? `  (${tags})` : ''}`);
    }
  } else {
    console.log(USAGE);
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
