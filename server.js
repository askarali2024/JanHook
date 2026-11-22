'use strict';

/**
 * JanHook — lightweight, self-hosted webhook & HTTP request inspector.
 *
 *   ALL  /h/:slug      capture any HTTP request (raw body preserved)
 *   GET  /api/events   Server-Sent Events stream (live push to the UI)
 *   ...  /api/*        endpoint & request management, replay
 *
 * Configuration (environment variables):
 *   PORT                  port to listen on            (default 8001)
 *   DATA_DIR              JSON storage directory       (default ./data)
 *   MAX_REQUESTS_PER_BIN  retained requests per endpoint (default 100)
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const Store = require('./lib/store');

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

const PORT = intFromEnv('PORT', 8001);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_REQUESTS_PER_BIN = intFromEnv('MAX_REQUESTS_PER_BIN', 100);

const store = new Store(DATA_DIR, MAX_REQUESTS_PER_BIN);

const app = express();
app.disable('x-powered-by');

// --------------------------------------------------------------------------
// SSE hub — live updates for every open tab
// --------------------------------------------------------------------------

const sseClients = new Set();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const client of sseClients) {
    try {
      sseWrite(client, event, data);
    } catch {
      sseClients.delete(client);
    }
  }
}

app.get('/api/events', (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  sseClients.add(res);
  sseWrite(res, 'hello', { clients: sseClients.size, ts: Date.now() });

  // Keepalive comment frame — survives proxy idle timeouts.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

// --------------------------------------------------------------------------
// Management API
// --------------------------------------------------------------------------

app.use('/api', express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

app.get('/api/endpoints', (req, res) => {
  res.json({ endpoints: store.listEndpoints() });
});

app.post('/api/endpoints', (req, res) => {
  const { name } = req.body || {};
  const endpoint = store.createEndpoint(name);
  broadcast('endpoint-created', { endpoint });
  res.status(201).json({ endpoint });
});

app.patch('/api/endpoints/:slug', (req, res) => {
  const endpoint = store.updateEndpoint(req.params.slug, req.body || {});
  if (!endpoint) return res.status(404).json({ error: 'Endpoint not found' });
  broadcast('endpoint-updated', { endpoint });
  res.json({ endpoint });
});

app.delete('/api/endpoints/:slug', (req, res) => {
  if (!store.deleteEndpoint(req.params.slug)) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  broadcast('endpoint-deleted', { slug: req.params.slug });
  res.status(204).end();
});

app.get('/api/endpoints/:slug/requests', (req, res) => {
  if (!store.getEndpoint(req.params.slug)) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  res.json({ requests: store.getRequests(req.params.slug) });
});

app.delete('/api/endpoints/:slug/requests', (req, res) => {
  if (!store.getEndpoint(req.params.slug)) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  store.clearRequests(req.params.slug);
  broadcast('requests-cleared', { slug: req.params.slug });
  res.status(204).end();
});

app.delete('/api/requests/:slug/:id', (req, res) => {
  if (!store.getEndpoint(req.params.slug)) {
    return res.status(404).json({ error: 'Endpoint not found' });
  }
  if (!store.deleteRequest(req.params.slug, req.params.id)) {
    return res.status(404).json({ error: 'Request not found' });
  }
  broadcast('request-deleted', { slug: req.params.slug, id: req.params.id });
  res.status(204).end();
});

// --------------------------------------------------------------------------
// Replay — forward a captured request to a new target
// --------------------------------------------------------------------------

// Headers that must not be copied verbatim onto a new connection.
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
]);

app.post('/api/replay', async (req, res) => {
  const { slug, id, target } = req.body || {};

  const captured = store.findRequest(slug, id);
  if (!captured) return res.status(404).json({ error: 'Captured request not found' });

  let base;
  try {
    base = new URL(target);
  } catch {
    return res.status(400).json({ error: 'Invalid target URL' });
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    return res.status(400).json({ error: 'Target URL must be http:// or https://' });
  }

  // The captured path + query are appended to the target base, so you can
  // replay into another JanHook endpoint (http://localhost:8001/h/<slug>)
  // or a staging service (https://staging.example.com/api).
  const original = new URL(captured.url, 'http://janhook.internal');
  const basePath = base.pathname.replace(/\/+$/, '');
  const finalUrl = new URL(base.origin + basePath + original.pathname + original.search);

  const headers = {};
  for (const [key, value] of Object.entries(captured.headers || {})) {
    if (!HOP_BY_HOP.has(key)) {
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }
  }

  let body;
  if (typeof captured.rawBody === 'string') body = captured.rawBody;
  else if (captured.rawB64) body = Buffer.from(captured.rawB64, 'base64');
  if (captured.method === 'GET' || captured.method === 'HEAD') body = undefined;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(finalUrl, {
      method: captured.method,
      headers,
      body: body || undefined,
      redirect: 'manual',
      signal: controller.signal,
    });

    const text = await upstream.text();
    const MAX_DISPLAY = 100000; // 100 KB shown in the UI
    res.json({
      ok: true,
      finalUrl: finalUrl.toString(),
      status: upstream.status,
      statusText: upstream.statusText,
      headers: Object.fromEntries([...upstream.headers]),
      body: text.length > MAX_DISPLAY ? text.slice(0, MAX_DISPLAY) : text,
      truncated: text.length > MAX_DISPLAY,
    });
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'timed out after 15s' : err.message;
    res.status(502).json({ error: `Replay failed: ${reason}` });
  } finally {
    clearTimeout(timeout);
  }
});

// --------------------------------------------------------------------------
// Webhook capture — ALL /h/:slug
// --------------------------------------------------------------------------

// Content types we treat as displayable text (everything else is stored as
// base64 bytes and flagged as binary).
const TEXTUAL_CONTENT = [
  /^text\//i,
  /json/i,
  /x-www-form-urlencoded/i,
  /xml/i,
  /yaml/i,
  /javascript/i,
  /graphql/i,
];

/**
 * Parse a raw textual body. The raw string is ALWAYS preserved alongside the
 * parsed form — that's what makes signature headers (Stripe `stripe-signature`,
 * GitHub `x-hub-signature-256`, …) verifiable from the captured request.
 */
function parseBody(raw, contentType) {
  const ct = (contentType || '').toLowerCase();

  if (/json/.test(ct)) {
    try {
      return { type: 'json', data: JSON.parse(raw) };
    } catch {
      return { type: 'text', data: raw };
    }
  }

  if (/x-www-form-urlencoded/.test(ct)) {
    const pairs = [...new URLSearchParams(raw).entries()].map(([key, value]) => ({ key, value }));
    const data = {};
    for (const p of pairs) data[p.key] = p.value;
    return { type: 'form', data, pairs };
  }

  // Opportunistic JSON: plenty of senders post JSON with a missing or sloppy
  // Content-Type.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return { type: 'json', data: JSON.parse(raw) };
    } catch {
      /* fall through to plain text */
    }
  }
  return { type: 'text', data: raw };
}

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  let ip = req.socket.remoteAddress || 'unknown';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  return ip;
}

function captureRequest(req, res) {
  const slug = req.params.slug;

  // Webhooks are usually server-to-server, but browser-based senders
  // appreciate permissive CORS.
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Max-Age': '86400',
    'X-JanHook-Endpoint': slug,
  });
  if (req.method === 'OPTIONS') return res.status(204).end();

  const endpoint = store.getEndpoint(slug);
  if (!endpoint) {
    return res.status(404).json({
      error: `Unknown JanHook endpoint "/h/${slug}". Create it in the JanHook UI first.`,
    });
  }

  // express.raw() gives us the untouched bytes — essential for HMAC checks.
  const rawBuffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const contentType = req.headers['content-type'] || '';
  const isTextual = contentType === '' || TEXTUAL_CONTENT.some((re) => re.test(contentType));

  let rawBody = null;
  let rawB64 = null;
  let body;
  if (rawBuffer.length === 0) {
    body = { type: 'empty', data: null };
  } else if (isTextual) {
    rawBody = rawBuffer.toString('utf8');
    body = parseBody(rawBody, contentType);
  } else {
    rawB64 = rawBuffer.toString('base64');
    body = { type: 'binary', data: null };
  }

  const parsedUrl = new URL(req.originalUrl, 'http://janhook.internal');
  const captured = {
    id: crypto.randomBytes(9).toString('base64url'),
    slug,
    method: req.method,
    url: req.originalUrl,
    path: parsedUrl.pathname,
    query: [...parsedUrl.searchParams.entries()].map(([key, value]) => ({ key, value })),
    headers: req.headers,
    contentType,
    sourceIp: clientIp(req),
    size: rawBuffer.length,
    rawBody,
    rawB64,
    body,
    receivedAt: new Date().toISOString(),
  };

  store.addRequest(slug, captured);
  broadcast('request', { slug, request: captured });

  // Respond with the endpoint's configured status + JSON body.
  const response = endpoint.response || {};
  const status = Number.parseInt(response.status, 10);
  const responseBody = typeof response.body === 'string' ? response.body : '{"ok":true}';
  res
    .status(Number.isFinite(status) ? status : 200)
    .type('application/json')
    .send(responseBody);
}

const hookRouter = express.Router();
hookRouter.use(express.raw({ type: '*/*', limit: '10mb' }));
hookRouter.all('/:slug', captureRequest);
hookRouter.all('/:slug/*', captureRequest);
app.use('/h', hookRouter);

// --------------------------------------------------------------------------
// Static SPA
// --------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------------------------------
// Fallthrough + errors
// --------------------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[janhook] error:', err.message);
  const status = err.status && err.status >= 400 ? err.status : 500;
  res.status(status).json({ error: err.message || 'Internal error' });
});

// --------------------------------------------------------------------------
// Boot & graceful shutdown
// --------------------------------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ⚡ JanHook is listening');
  console.log(`     UI         http://localhost:${PORT}`);
  console.log(`     Webhooks   http://localhost:${PORT}/h/<slug>`);
  console.log(`     Data dir   ${path.resolve(DATA_DIR)}`);
  console.log(`     Retention  ${MAX_REQUESTS_PER_BIN} requests per endpoint`);
  console.log('');
});

function shutdown(signal) {
  console.log(`[janhook] ${signal} received — flushing data…`);
  store.flushAllSync();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
