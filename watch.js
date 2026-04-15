import crypto from 'crypto';
import { createClient } from 'redis';

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const REDIS_HOST  = process.env.REDIS_HOST || 'redis-17145.c239.us-east-1-2.ec2.cloud.redislabs.com';
const REDIS_PORT  = parseInt(process.env.REDIS_PORT || '17145');
const REDIS_PASS  = process.env.REDIS_PASS;
const REDIS_KEY   = 'webmemory:pages';

const redis = createClient({
  socket: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    tls: false
  },
  password: REDIS_PASS,
  username: 'default'
});

redis.on('error', err => console.error('Redis error:', err));
await redis.connect();
console.log('Redis connected');

const [,, command, url] = process.argv;

async function crawl(targetUrl) {
  console.log(`Fetching ${targetUrl} via Apify...`);
  const res = await fetch(
    `https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=${APIFY_TOKEN}&timeout=60`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: [{ url: targetUrl }],
        maxCrawlPages: 1,
        crawlerType: 'cheerio',
        outputFormats: ['markdown'],
      }),
    }
  );
  const items = await res.json();
  if (!items?.length) throw new Error('Apify returned no results.');
  return items[0].markdown || items[0].text || '';
}

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function preview(content) {
  return content.slice(0, 300).replace(/\n+/g, ' ').trim();
}

async function watch(targetUrl) {
  const content  = await crawl(targetUrl);
  const pageHash = hash(content);
  const record   = JSON.stringify({
    url: targetUrl,
    hash: pageHash,
    preview: preview(content),
    last_checked: new Date().toISOString(),
  });
  await redis.hSet(REDIS_KEY, targetUrl, record);
  console.log(`Watching: ${targetUrl}`);
  console.log(`Hash: ${pageHash.slice(0, 12)}...`);
  console.log(`Preview: ${preview(content).slice(0, 80)}...`);
}

async function check(targetUrl) {
  const stored = await redis.hGet(REDIS_KEY, targetUrl);
  if (!stored) {
    console.log(`Not watching ${targetUrl} yet. Run: node watch.js watch ${targetUrl}`);
    return;
  }
  const { hash: oldHash, preview: oldPreview, last_checked } = JSON.parse(stored);
  const content    = await crawl(targetUrl);
  const newHash    = hash(content);
  const newPreview = preview(content);

  if (newHash === oldHash) {
    console.log(`No changes on ${targetUrl}`);
    console.log(`Last checked: ${last_checked}`);
    return;
  }

  await redis.hSet(REDIS_KEY, targetUrl, JSON.stringify({
    url: targetUrl,
    hash: newHash,
    preview: newPreview,
    last_checked: new Date().toISOString(),
  }));

  console.log(`CHANGE DETECTED on ${targetUrl}`);
  console.log(`Last checked: ${last_checked}`);
  console.log(`\nOLD: ${oldPreview.slice(0, 150)}`);
  console.log(`\nNEW: ${newPreview.slice(0, 150)}`);
}

async function list() {
  const all  = await redis.hGetAll(REDIS_KEY);
  const keys = Object.keys(all);
  if (!keys.length) {
    console.log('Not watching any pages yet.');
    return;
  }
  console.log(`Watching ${keys.length} page(s):\n`);
  for (const k of keys) {
    const { url, last_checked, preview: p } = JSON.parse(all[k]);
    console.log(`URL: ${url}`);
    console.log(`Last checked: ${last_checked}`);
    console.log(`Preview: ${p.slice(0, 80)}...`);
    console.log('---');
  }
}

async function unwatch(targetUrl) {
  await redis.hDel(REDIS_KEY, targetUrl);
  console.log(`Stopped watching ${targetUrl}`);
}

switch (command) {
  case 'watch':   await watch(url); break;
  case 'check':   await check(url); break;
  case 'list':    await list(); break;
  case 'unwatch': await unwatch(url); break;
  default:
    console.log('Usage: node watch.js <watch|check|list|unwatch> [url]');
}

await redis.disconnect();
