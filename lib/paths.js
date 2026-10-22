/**
 * Where everything lives. DATA_DIR is cad-home/data unless CAD_DATA_DIR is set.
 *
 *   data/cad.db         accounts, sessions, settings, shares, logs (SQLite)
 *   data/files/<user>/  each person's drive; drawings go in Drawings/
 *   data/apps/<name>/   hosted web apps (site/ and functions/)
 *   data/history/       safety snapshots of live drawings
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.CAD_DATA_DIR || path.join(ROOT, 'data'));
export const APP_DIR = path.join(ROOT, 'app', 'dist');
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const APPS_DIR = path.join(DATA_DIR, 'apps');
export const HISTORY_DIR = path.join(DATA_DIR, 'history');
export const HUB_DIR = path.join(DATA_DIR, 'hub');
export const DB_FILE = path.join(DATA_DIR, 'cad.db');
export const PANEL_DIR = path.join(ROOT, 'panel');
export const SDK_DIR = path.join(ROOT, 'sdk');
export const TOKENS_CSS = path.join(ROOT, 'app', 'src', 'styles', 'tokens.css');
