/**
 * Server settings editable in Admin → Server, AI and Email. Stored as JSON in
 * the config table. Secrets (API keys, the SMTP password) never go to the
 * browser unmasked.
 */
import * as db from './db.js';

export const DEFAULTS = {
  private_url: '',
  public_url: '',
  /** Where the pristine HeyPuter/everything git clone lives, relative to cad-home. */
  everythingDir: '../upstream',
  'ai.providers': {},
  'ai.models': [],
  'ai.prices': {},
  smtp: null,
  'mail.from': '',
  'limits.public_ai_per_hour': 30,
  'limits.public_email_per_hour': 5,
  'functions.timeout_ms': 30000,
  'hosting.enabled': false,
  'hosting.quota_bytes': 104857600,
};

const listeners = new Set();

export function get(key, fallback = DEFAULTS[key]) {
  const row = db.get('SELECT value FROM config WHERE key = ?', key);
  if (!row) return structuredClone(fallback);
  try {
    return JSON.parse(row.value);
  } catch {
    return structuredClone(fallback);
  }
}

export function set(key, value) {
  if (value === undefined || value === null) db.run('DELETE FROM config WHERE key = ?', key);
  else db.run('INSERT INTO config(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  for (const fn of listeners) fn(key);
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

/** The tailnet address of the private listener, for example https://pc.tailnet.ts.net */
export function privateUrl() {
  return trimUrl(process.env.CAD_PRIVATE_URL || get('private_url'));
}

/** The Funnel address of the public listener, for example https://pc.tailnet.ts.net:8443 */
export function publicUrl() {
  return trimUrl(process.env.CAD_PUBLIC_URL || get('public_url'));
}

export const MASK = '••••';

/** "sk-abc…wxyz" → "••••wxyz". Empty stays empty. */
export function mask(secret) {
  const s = String(secret || '');
  if (!s) return '';
  return MASK + (s.length > 8 ? s.slice(-4) : '');
}

/** A masked value sent back unchanged from the browser means "keep the stored secret". */
export function isMasked(value) {
  return typeof value === 'string' && value.startsWith(MASK);
}
