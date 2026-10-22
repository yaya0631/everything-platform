/**
 * "Export my hub app data" — a ZIP (STORE method, no dependencies) of folder
 * data files plus KV entries as data.json, streamed to the person's browser.
 * Amounts never leave this deployment (no external call).
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import * as hubKv from './hub-kv.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

class ZipWriter {
  constructor() {
    this.parts = [];
    this.central = [];
    this.offset = 0;
  }

  /** name uses forward slashes; data is a Uint8Array. */
  add(name, data, mtime = Date.now()) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const dosTime = dosStamp(mtime);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(dosTime.dosTime, 10);
    local.writeUInt16LE(dosTime.dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed
    local.writeUInt32LE(data.length, 22); // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    this.parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dosTime.dosTime, 12);
    cd.writeUInt16LE(dosTime.dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(this.offset, 42);
    nameBuf.copy(cd, 46);
    this.central.push(cd);
    this.offset += local.length + nameBuf.length + data.length;
  }

  finish() {
    const central = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, central, end]);
  }
}

function dosStamp(ms) {
  const d = new Date(ms);
  return {
    dosDate: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

/**
 * Everything this person keeps in hub apps:
 *   <app>/…        the files
 *   data.json      the KV pairs, per app
 * Returns a Buffer (hub data is bounded by the quota; a streaming variant
 * comes with the heavy tiers if someone's data gets past ~100 MB).
 */
export async function exportUserHubData(user, dirs, sizeCap = 200 * 1024 * 1024) {
  const zip = new ZipWriter();
  const kvRows = hubKv.dumpUser(user);

  let total = 0;
  const walk = async (dir, prefix, app) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const name = `${prefix}${e.name}${e.isDirectory() ? '/' : ''}`;
      if (e.isDirectory()) {
        zip.add(name, Buffer.alloc(0), e.mtimeMs);
        await walk(full, name, app);
      } else {
        const st = await fsp.stat(full);
        total += st.size;
        if (total > sizeCap) throw new Error('export_too_large');
        zip.add(name, Buffer.from(await fsp.readFile(full)), st.mtimeMs);
      }
    }
  };

  for (const dir of dirs) {
    if (!fs.existsSync(dir.path)) continue;
    await walk(dir.path, `${dir.label}/${dir.app ? `${dir.app}/` : ''}`, dir.app === undefined ? null : dir.app);
  }

  zip.add('data.json', Buffer.from(JSON.stringify({ kv: kvRows, exportedAt: Date.now() }, null, 2), 'utf8'));
  return zip.finish();
}
