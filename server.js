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

const USERS_KEY      = 'webmemory:users';
const SESSION_PREFIX = 'webmemory:session:';
const SESSION_TTL    = 7 * 24 * 60 * 60; // 7 days

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

// ── auth helpers ──────────────────────────────────────────────────────────────

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const [key, ...val] = part.trim().split('=');
    if (key) cookies[key.trim()] = decodeURIComponent(val.join('='));
  });
  return cookies;
}

async function getSession(req) {
  const token = parseCookies(req).session;
  if (!token) return null;
  const userId = await redis.get(`${SESSION_PREFIX}${token}`);
  if (!userId) return null;
  return { token, userId };
}

async function requireAuth(req, res) {
  const session = await getSession(req);
  if (!session) { json(res, 401, { error: 'Not authenticated' }); return null; }
  return session;
}

function siteKey(userId) { return `webmemory:pages:${userId}`; }

// ── crawl helpers ─────────────────────────────────────────────────────────────

async function crawl(targetUrl) {
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

async function getSites(userId) {
  const all = await redis.hGetAll(siteKey(userId));
  return Object.values(all).map(v => JSON.parse(v));
}

async function watchSite(targetUrl, userId) {
  const content  = await crawl(targetUrl);
  const pageHash = hashContent(content);
  const record   = {
    url: targetUrl,
    hash: pageHash,
    preview: preview(content),
    last_checked: new Date().toISOString(),
    status: 'ok',
  };
  await redis.hSet(siteKey(userId), targetUrl, JSON.stringify(record));
  return record;
}

async function checkSite(targetUrl, userId) {
  const stored = await redis.hGet(siteKey(userId), targetUrl);
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
  await redis.hSet(siteKey(userId), targetUrl, JSON.stringify(record));
  return { changed, record };
}

async function unwatchSite(targetUrl, userId) {
  await redis.hDel(siteKey(userId), targetUrl);
}

// ── http helpers ──────────────────────────────────────────────────────────────

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
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

// ── server ────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const pathname = url.split('?')[0];

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (method === 'GET' && pathname === '/') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // ── auth routes ────────────────────────────────────────────────────────────

  if (pathname === '/api/auth/signup' && method === 'POST') {
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return json(res, 400, { error: 'Email and password required' });
      if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });

      const existing = await redis.hGet(USERS_KEY, email.toLowerCase());
      if (existing) return json(res, 409, { error: 'An account with this email already exists' });

      const salt         = crypto.randomBytes(16).toString('hex');
      const passwordHash = hashPassword(password, salt);
      const userId       = crypto.randomBytes(16).toString('hex');

      await redis.hSet(USERS_KEY, email.toLowerCase(), JSON.stringify({ id: userId, email, passwordHash, salt }));

      const token = crypto.randomBytes(32).toString('hex');
      await redis.setEx(`${SESSION_PREFIX}${token}`, SESSION_TTL, userId);

      json(res, 200, { ok: true, email }, {
        'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax`,
      });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    try {
      const { email, password } = await readBody(req);
      if (!email || !password) return json(res, 400, { error: 'Email and password required' });

      const userStr = await redis.hGet(USERS_KEY, email.toLowerCase());
      if (!userStr) return json(res, 401, { error: 'Invalid email or password' });

      const user         = JSON.parse(userStr);
      const passwordHash = hashPassword(password, user.salt);
      if (passwordHash !== user.passwordHash) return json(res, 401, { error: 'Invalid email or password' });

      const token = crypto.randomBytes(32).toString('hex');
      await redis.setEx(`${SESSION_PREFIX}${token}`, SESSION_TTL, user.id);

      json(res, 200, { ok: true, email: user.email }, {
        'Set-Cookie': `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; SameSite=Lax`,
      });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    const cookies = parseCookies(req);
    if (cookies.session) await redis.del(`${SESSION_PREFIX}${cookies.session}`);
    json(res, 200, { ok: true }, {
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax',
    });
    return;
  }

  if (pathname === '/api/auth/me' && method === 'GET') {
    const session = await getSession(req);
    if (!session) return json(res, 401, { error: 'Not authenticated' });
    const userStr = await redis.hGetAll(USERS_KEY);
    const user = Object.values(userStr).map(v => JSON.parse(v)).find(u => u.id === session.userId);
    json(res, 200, { email: user?.email || '' });
    return;
  }

  // ── protected data routes ──────────────────────────────────────────────────

  if (pathname === '/api/sites' && method === 'GET') {
    const session = await requireAuth(req, res);
    if (!session) return;
    try { json(res, 200, await getSites(session.userId)); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/watch' && method === 'POST') {
    const session = await requireAuth(req, res);
    if (!session) return;
    try {
      const { url: targetUrl } = await readBody(req);
      if (!targetUrl) return json(res, 400, { error: 'url required' });
      json(res, 200, await watchSite(targetUrl, session.userId));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/check' && method === 'POST') {
    const session = await requireAuth(req, res);
    if (!session) return;
    try {
      const { url: targetUrl } = await readBody(req);
      if (!targetUrl) return json(res, 400, { error: 'url required' });
      json(res, 200, await checkSite(targetUrl, session.userId));
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (pathname === '/api/unwatch' && method === 'DELETE') {
    const session = await requireAuth(req, res);
    if (!session) return;
    try {
      const { url: targetUrl } = await readBody(req);
      if (!targetUrl) return json(res, 400, { error: 'url required' });
      await unwatchSite(targetUrl, session.userId);
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(3000, () => {
  console.log('CompeteIQ running → http://localhost:3000');
});
