/**
 * Local raw-socket bridge for browser hub apps.
 *
 * This is deliberately limited to loopback and RFC1918/link-local addresses:
 * it gives local apps the socket contract they need without turning CAD Home
 * into an arbitrary outbound proxy.
 */
import net from 'node:net';
import tls from 'node:tls';
import { WebSocketServer } from 'ws';
import * as db from './db.js';
import * as store from './store.js';
import { requestOrigin } from './http.js';

const MAX_FRAME = 256 * 1024;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

function allowedHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === 'ip6-localhost') return true;
  const ip = net.isIP(value);
  if (ip === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || a === 127 || (a === 169 && b === 254);
  }
  if (ip === 6) return value === '::1' || value.startsWith('fe80:') || value.startsWith('fc') || value.startsWith('fd');
  return value.endsWith('.local');
}

function appAllowed(req, app, registry) {
  const token = registry.sessionToken(req);
  const session = token ? store.sessionInfo(token) : null;
  if (!session || !app || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(app)) return false;
  const row = db.get('SELECT enabled, access, users FROM hub_apps WHERE name = ?', app);
  if (!row || !row.enabled) return false;
  if (row.access !== 'users') return true;
  try { return JSON.parse(row.users || '[]').includes(session.user); } catch { return false; }
}

function send(ws, value) {
  if (ws.readyState === 1) ws.send(JSON.stringify(value));
}

function closeQuietly(socket) {
  try { socket?.destroy?.(); } catch { /* already closed */ }
}

export function register(registry) {
  registry.upgradeMounts.private.push(['/api/hub/net', (req, socket, head, url) => {
    const origin = req.headers.origin;
    if (origin && origin !== requestOrigin(req)) return socket.destroy();
    const app = url.searchParams.get('app');
    const host = url.searchParams.get('host');
    const port = Number(url.searchParams.get('port'));
    const secure = url.searchParams.get('tls') === '1';
    if (!appAllowed(req, app, registry) || !allowedHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const transport = secure
        ? tls.connect({ host, port, servername: host === 'localhost' ? undefined : host })
        : net.connect({ host, port });
      let ended = false;
      const finish = (hadError = false) => {
        if (ended) return;
        ended = true;
        send(ws, { type: 'close', hadError: !!hadError });
        try { ws.close(); } catch { /* ignore */ }
        closeQuietly(transport);
      };
      transport.once(secure ? 'secureConnect' : 'connect', () => send(ws, { type: 'open' }));
      transport.on('data', (chunk) => send(ws, { type: 'data', data: Buffer.from(chunk).toString('base64') }));
      transport.on('error', (err) => send(ws, { type: 'error', code: err.code || 'socket_error', message: err.message }));
      transport.on('close', (hadError) => finish(hadError));
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'write' && typeof msg.data === 'string') {
            const bytes = Buffer.from(msg.data, 'base64');
            if (bytes.length > MAX_FRAME) return finish(true);
            transport.write(bytes);
          } else if (msg.type === 'close') finish(false);
        } catch { finish(true); }
      });
      ws.on('close', () => finish(false));
      ws.on('error', () => finish(true));
    });
  }]);
}
