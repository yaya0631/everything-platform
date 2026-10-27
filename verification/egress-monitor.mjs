// Egress monitor v2: async netstat polling for non-local ESTABLISHED connections.
import { exec } from 'node:child_process';
import fs from 'node:fs';
const OUT = process.argv[2] || 'egress-log.csv';
const NAME_FILTER = process.argv[3] || ''; // only log rows whose process name matches (empty = all)
const LOCAL = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1|fe80:|\[::)/i;
const seen = new Set();
if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, 'time,pid,remote_ip,remote_port,source\n');
let busy = false;
function log(row) { if (!seen.has(row)) { seen.add(row); fs.appendFileSync(OUT, row + '\n'); } }
setInterval(() => {
  if (busy) return; busy = true;
  exec('netstat -ano', { timeout: 12_000, maxBuffer: 1 << 24 }, (err, out) => {
    busy = false;
    if (err) { log(`${new Date().toISOString()},POLLERR,${err.message.slice(0, 60)},,netstat`); return; }
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+(\[[^\]]+\]|[\d.]+):(\d+)\s+(\S+)/);
      if (!m) continue;
      const [, lport, rip, rport, state] = m;
      if (state !== 'ESTABLISHED' && state !== 'SYN_SENT') continue;
      const ip = rip.replace(/^\[|\]$/g, '');
      if (LOCAL.test(ip)) continue;
      log(`${new Date().toISOString()},,${ip},${rport},netstat`);
    }
  });
}, 3000);
console.log('egress monitor v2 ->', OUT);
