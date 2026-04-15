import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createClient } from 'redis';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const REDIS_HOST  = process.env.REDIS_HOST || 'redis-17145.c239.us-east-1-2.ec2.cloud.redislabs.com';
const REDIS_PORT  = parseInt(process.env.REDIS_PORT || '17145');
const REDIS_PASS  = process.env.REDIS_PASS;
const REDIS_KEY   = 'webmemory:pages';

const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: false,
    reconnectStrategy: retries => Math.min(retries * 100, 3000),
  },
  password: REDIS_PASS,
  username: 'default',
});
redis.on('error', err => console.error('Redis error:', err));
await redis.connect();
console.log('Redis connected');

// ── helpers ──────────────────────────────────────────────────────────────────

async function crawl(targetUrl) {
  // Try cheerio first (fast, low memory). Falls back to playwright:chrome for JS-heavy SPAs.
  // memory=512 per run keeps parallel checks within Apify free-tier limits (8192MB total).
  const crawlers = [
    { type: 'cheerio',           timeout: 60,  memory: 1024 },
    { type: 'playwright:chrome', timeout: 120, memory: 1024 },
  ];
  for (const { type: crawlerType, timeout, memory } of crawlers) {
    const url = `https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=${timeout}&memory=${memory}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url: targetUrl }],
        maxCrawlPages: 1,
        crawlerType,
        outputFormats: ['markdown'],
      }),
      signal: AbortSignal.timeout((timeout + 30) * 1000),
    });
    const items = await res.json();
    console.log(`[${crawlerType}] ${targetUrl} → HTTP ${res.status}, items: ${Array.isArray(items) ? items.length : JSON.stringify(items)}`);
    if (items?.length) return items[0].markdown || items[0].text || '';
  }

  throw new Error('Apify returned no results.');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function preview(content) {
  return content.slice(0, 300).replace(/\n+/g, ' ').trim();
}

// ── route handlers ────────────────────────────────────────────────────────────

async function getSites() {
  const all = await redis.hGetAll(REDIS_KEY);
  return Object.values(all).map(v => JSON.parse(v));
}

async function watchSite(targetUrl) {
  const content  = await crawl(targetUrl);
  const pageHash = hashContent(content);
  const record   = {
    url: targetUrl,
    hash: pageHash,
    preview: preview(content),
    last_checked: new Date().toISOString(),
    status: 'ok',
  };
  await redis.hSet(REDIS_KEY, targetUrl, JSON.stringify(record));
  return record;
}

async function checkSite(targetUrl) {
  const stored = await redis.hGet(REDIS_KEY, targetUrl);
  if (!stored) throw new Error(`Not watching ${targetUrl}`);

  const { hash: oldHash, preview: oldPreview } = JSON.parse(stored);
  const content    = await crawl(targetUrl);
  const newHash    = hashContent(content);
  const newPreview = preview(content);
  const changed    = newHash !== oldHash;

  const record = {
    url: targetUrl,
    hash: newHash,
    preview: newPreview,
    last_checked: new Date().toISOString(),
    status: changed ? 'changed' : 'ok',
    ...(changed && { old_preview: oldPreview }),
  };
  await redis.hSet(REDIS_KEY, targetUrl, JSON.stringify(record));
  return { changed, record };
}

async function unwatchSite(targetUrl) {
  await redis.hDel(REDIS_KEY, targetUrl);
}

// ── http server ───────────────────────────────────────────────────────────────

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const pathname = url.split('?')[0];

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  // Serve index.html
  if (method === 'GET' && pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // API routes
  if (pathname === '/api/sites' && method === 'GET') {
    try { json(res, 200, await getSites()); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/watch' && method === 'POST') {
    try {
      const { url: targetUrl } = await readBody(req);
      if (!targetUrl) return json(res, 400, { error: 'url required' });
      const record = await watchSite(targetUrl);
      json(res, 200, record);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/check' && method === 'POST') {
    try {
      const { url: targetUrl } = await readBody(req);
      if (!targetUrl) return json(res, 400, { error: 'url required' });
      const result = await checkSite(targetUrl);
      json(res, 200, result);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/unwatch' && method === 'DELETE') {
    try {
      const { url: targetUrl } = await readBody(req);
      if (!targetUrl) return json(res, 400, { error: 'url required' });
      await unwatchSite(targetUrl);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(3000, () => {
  console.log('CompeteIQ running → http://localhost:3000');
});
