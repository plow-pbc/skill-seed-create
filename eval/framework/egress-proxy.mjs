#!/usr/bin/env node
// Egress logging + target denylist proxy (Chunk 4, §7). The capture/install
// containers run NETWORK-ON (Global Constraint: no net-off) but route ALL traffic
// through this proxy, which:
//   (1) LOGS every egress to <egress.log> — npm package fetches (registry mode, with
//       the package PATH) and every CONNECT host:port (https tunnels: git, etc.).
//   (2) ENFORCES the active target DENYLIST for published targets: 404 the target
//       npm package(s) and 403 the target repo host(s) — while ALLOWING deps.
//
// Two roles in one server (npm points `registry` here; git/https use it as HTTPS_PROXY):
//   - registry mode  : an origin request (req.url starts with "/") → forward to the
//                       upstream npm registry; deny by package name (path segment 1).
//   - forward proxy  : CONNECT host:port → tunnel; deny by host. (Also absolute-URI GET.)
//
// Usage: egress-proxy.mjs --port <p> --log <egress.log> [--deny-package <name> ...]
//        [--deny-host <host> ...] [--upstream <https-registry>]
// Prints "PROXY-READY <port>" once listening. SIGTERM to stop. Pure Node, no deps.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createWriteStream } from 'node:fs';

const args = process.argv.slice(2);
function multi(flag) { const out = []; for (let i = 0; i < args.length; i++) if (args[i] === flag) out.push(args[i + 1]); return out; }
function one(flag, def) { const i = args.indexOf(flag); return i === -1 ? def : args[i + 1]; }

const PORT = Number(one('--port', '8899'));
const LOG = one('--log', '/tmp/egress.log');
const DENY_PACKAGES = new Set(multi('--deny-package'));
const DENY_HOSTS = new Set(multi('--deny-host'));
const UPSTREAM = one('--upstream', 'https://registry.npmjs.org');
const up = new URL(UPSTREAM);

const logStream = createWriteStream(LOG, { flags: 'a' });
function logEgress(rec) { logStream.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); }

const server = http.createServer((req, res) => {
  // Absolute-URI (plain-http forward proxy) vs origin path (npm registry mode).
  // If HTTP_PROXY is set, npm sends the http registry request as an absolute-URI to
  // US (the proxy) — detect that self-reference (port === our PORT) and treat it as a
  // registry request rather than forwarding to ourselves (which would loop → 502).
  if (/^https?:\/\//i.test(req.url)) {
    const u = new URL(req.url);
    if (Number(u.port) === PORT) { req.url = u.pathname + u.search; /* fall through to registry mode */ }
    else {
    const denied = DENY_HOSTS.has(u.hostname);
    logEgress({ kind: 'http', method: req.method, host: u.hostname, path: u.pathname, action: denied ? 'DENY' : 'ALLOW' });
    if (denied) { res.writeHead(403); return res.end('egress-proxy: target host denied\n'); }
    const lib = u.protocol === 'https:' ? https : http;
    const fwd = lib.request(u, { method: req.method, headers: req.headers }, (up2) => { res.writeHead(up2.statusCode, up2.headers); up2.pipe(res); });
    fwd.on('error', () => { res.writeHead(502); res.end('bad gateway\n'); });
    return req.pipe(fwd);
    }
  }
  // Registry mode: req.url = "/<pkg>" or "/<pkg>/-/<tarball>" or "/@scope/pkg".
  const seg = req.url.split('/').filter(Boolean);
  const pkg = seg[0] && seg[0].startsWith('@') ? `${seg[0]}/${seg[1] || ''}` : (seg[0] || '');
  const pkgName = decodeURIComponent(pkg);
  const denied = DENY_PACKAGES.has(pkgName);
  logEgress({ kind: 'npm', package: pkgName, path: req.url, action: denied ? 'DENY' : 'ALLOW' });
  if (denied) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'Not found (target denied by eval leakage denylist)' })); }
  const fwdHeaders = { ...req.headers, host: up.hostname };
  delete fwdHeaders['proxy-connection'];
  const fwd = https.request({ hostname: up.hostname, port: 443, path: req.url, method: req.method, headers: fwdHeaders, servername: up.hostname }, (up2) => {
    res.writeHead(up2.statusCode, up2.headers); up2.pipe(res);
  });
  fwd.on('error', (e) => { logEgress({ kind: 'npm-upstream-error', package: pkgName, error: String(e.message) }); if (!res.headersSent) res.writeHead(502); res.end('bad gateway: ' + e.message + '\n'); });
  req.pipe(fwd);
});

// HTTPS forward proxy: CONNECT host:port (git/https deps + any https egress).
server.on('connect', (req, clientSocket, head) => {
  const [host, portRaw] = req.url.split(':');
  const port = Number(portRaw) || 443;
  // CLOSE THE TARBALL BYPASS: a blind HTTPS CONNECT to the npm registry host would tunnel
  // `registry.npmjs.org/<target>/-/<tarball>.tgz` past the package denylist (we can't see
  // the path inside TLS). All legit npm traffic uses the VISIBLE http registry path
  // (npm_config_registry points here), so a direct tunnel to the registry host is denied —
  // forcing every package fetch through the logged, denylist-checked registry mode.
  if (host === up.hostname) {
    logEgress({ kind: 'connect', host, port, action: 'DENY', reason: 'registry-tunnel (use the visible http registry path)' });
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\negress-proxy: direct registry tunnel denied — use the http registry\r\n');
    return clientSocket.end();
  }
  const denied = DENY_HOSTS.has(host);
  logEgress({ kind: 'connect', host, port, action: denied ? 'DENY' : 'ALLOW' });
  if (denied) { clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\negress-proxy: target host denied\r\n'); return clientSocket.end(); }
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head); upstream.pipe(clientSocket); clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.end());
  clientSocket.on('error', () => upstream.end());
});

server.listen(PORT, () => { console.log(`PROXY-READY ${PORT}`); });
process.on('SIGTERM', () => { logStream.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500); });
