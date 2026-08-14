#!/usr/bin/env node
/**
 * reply-proxy.js — serves the dashboard and calls the Reply.io API for it.
 *
 * Run one command and everything else is automatic:
 *
 *     node reply-proxy.js
 *
 * then open http://127.0.0.1:8787
 *
 * The token is read from the REPLY_API_TOKEN environment variable, or from a
 * .env file sitting next to this script. It is never sent to the browser and
 * never written into the dashboard HTML.
 *
 * Why this process has to exist
 * -----------------------------
 * api.reply.io answers CORS preflight with 405, so a browser page can never
 * POST to it directly no matter what headers it sets. Something outside the
 * browser has to make the call. That same something is the right place to keep
 * the API token, since anything shipped to the browser is readable by whoever
 * holds the file.
 *
 * Security posture
 * ----------------
 * · Binds 127.0.0.1 — not reachable from your network.
 * · Proxies one allow-listed upstream route; it is not an open relay.
 * · Serves only the dashboard file, by exact name — no directory traversal.
 * · Never logs the token and redacts it from any upstream error body.
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';
const DASHBOARD = 'index.html';

/* ---------- token: environment first, then .env next to this file ---------- */
function loadToken() {
  if (process.env.REPLY_API_TOKEN) return process.env.REPLY_API_TOKEN.trim();
  const envFile = path.join(HERE, '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?REPLY_API_TOKEN\s*=\s*(.*)\s*$/.exec(line);
      if (m) return m[1].replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return null;
}

const TOKEN = loadToken();
if (!TOKEN) {
  console.error('\n  No API token found.\n');
  console.error('  Create a file called .env next to this script containing:\n');
  console.error("      REPLY_API_TOKEN=your-token-here\n");
  console.error('  (or export REPLY_API_TOKEN before running). Keep .env out of git.\n');
  process.exit(1);
}

/* Only these routes reach Reply.io. Add entries here rather than forwarding
   freely, so nothing unexpected can be relayed upstream with your token. */
const API_ROUTE = '/api/emails-overview';
const UPSTREAM_PATH = '/v3/reporting/emails/overview';

const redact = s => String(s).split(TOKEN).join('«redacted»');

function corsOrigin(origin) {
  if (!origin || origin === 'null') return 'null';
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return null;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function callReply(upstreamPath, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.reply.io',
      path: upstreamPath,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, r => {
      let out = '';
      r.on('data', c => out += c);
      r.on('end', () => resolve({ status: r.statusCode, body: out }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST);
  const pathname = decodeURIComponent(url.pathname);

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');

  /* ---------- the API route, same shape as api/emails-overview.js ---------- */
  if (pathname === API_ROUTE) {
    const origin = corsOrigin(req.headers.origin);
    if (!origin) return json(res, 403, { error: 'Origin not allowed' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'GET') return json(res, 405, { error: 'Use GET' });

    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const isIso = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(s);
    if (!isIso(from) || !isIso(to)) {
      return json(res, 400, { error: 'from and to must be ISO timestamps like 2026-08-01T00:00:00Z' });
    }

    const ts = new Date().toTimeString().slice(0, 8);
    try {
      const r = await callReply(UPSTREAM_PATH, JSON.stringify({ filters: { from, to } }));
      console.log(`${ts}  ${API_ROUTE} ${from.slice(0,10)}..${to.slice(0,10)} -> ${r.status}`);
      if (r.status < 200 || r.status >= 300) return json(res, 502, { error: `Upstream returned ${r.status}` });
      let parsed;
      try { parsed = JSON.parse(r.body); } catch { return json(res, 502, { error: 'Upstream returned malformed JSON' }); }
      return json(res, 200, Array.isArray(parsed) ? parsed[0] : parsed);
    } catch (err) {
      console.error(`${ts}  upstream error: ${redact(err.message)}`);
      return json(res, 502, { error: 'Could not reach the reporting API' });
    }
  }

  /* ---------- static: the dashboard, by exact name only ---------- */
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/' + DASHBOARD) {
      const file = path.join(HERE, DASHBOARD);
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end(DASHBOARD + ' not found next to reply-proxy.js');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (pathname === '/health') return json(res, 200, { ok: true, route: API_ROUTE });
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use — is the proxy already running?`);
    console.error(`  Use a different port with:  PORT=8788 node reply-proxy.js\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Dashboard  ->  http://${HOST}:${PORT}`);
  console.log(`  API route  ->  GET  http://${HOST}:${PORT}${API_ROUTE}`);
  console.log('  Token loaded from environment (never logged, never sent to the browser).');
  console.log('\n  Leave this running and open the URL above.\n');
});
