Here's the full file:

```markdown
---
name: web-memory
description: Watch any URL for changes over time. Uses Apify to fetch live page content and Redis (or local JSON file) to store content hashes. Detects what changed between checks.
version: 1.0.0
metadata:
  openclaw:
    emoji: "🧠"
    requires:
      env:
        - APIFY_API_TOKEN
    optional:
      - REDIS_URL
---

## Purpose
Give OpenClaw persistent memory of web pages. Watch a URL and only alert the user when something actually changed since last check.

## Storage

Uses Redis if `REDIS_URL` is available and working. Falls back to local JSON file at `workspace/memory/web-memory.json` if Redis is unavailable.

## Environment Variables

- `APIFY_API_TOKEN` — **required**. Apify API token used to authenticate all crawler requests.
- `REDIS_URL` — **optional**. If set and reachable, used for persistent storage. Falls back to local JSON file.

Never hardcode API keys or connection strings. Always read them from the environment at runtime.

## Commands

### Watch a URL
Trigger: "watch [url]", "monitor [url]", "track [url]"

Steps:
1. Call Apify Website Content Crawler to fetch the URL content.
   Read `$APIFY_API_TOKEN` from the environment and substitute it into the request:
   ```
   POST https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token=$APIFY_API_TOKEN&timeout=60
   Body: {"startUrls":[{"url":"TARGET_URL"}],"maxCrawlPages":1,"crawlerType":"cheerio","outputFormats":["markdown"]}
   ```
2. Extract the `text` field from the first result item (plain text, no markdown).
3. Compute a SHA-256 hash of the text content in Node.js using `crypto.createHash('sha256').update(text).digest('hex')`.
4. Store the record:
   - If Redis available: `redis-cli -u $REDIS_URL HSET webmemory:pages "URL" '{"hash":"HASH","preview":"FIRST_300_CHARS","last_checked":"ISO_TIMESTAMP","url":"URL"}'`
   - If Redis unavailable: Write to `workspace/memory/web-memory.json` using Node.js
5. Reply: "Now watching [url]. I'll alert you when anything changes."

### Check a URL for changes
Trigger: "check [url]", "anything changed on [url]", "has [url] changed"

Steps:
1. Fetch current content from Apify (same call as Watch, using `$APIFY_API_TOKEN` from env).
2. Hash the new content.
3. Get stored record from Redis (`$REDIS_URL`) or local JSON file.
4. Compare old hash to new hash:
   - If SAME: Reply "No changes on [url] since [last_checked]."
   - If DIFFERENT: Update storage with new hash and timestamp. Summarize what changed between the old preview and new content. Reply with a plain English summary.

### List watched pages
Trigger: "what am I watching", "list watched pages", "show monitored urls"

Steps:
1. Get all records from Redis (`$REDIS_URL`) or local JSON file.
2. Format and return each URL with its `last_checked` timestamp.

### Stop watching
Trigger: "stop watching [url]", "unwatch [url]"

Steps:
1. Delete record from Redis (`$REDIS_URL`) or local JSON file.
2. Confirm deletion.

## Rules
- Always limit Apify crawl to `maxCrawlPages: 1`
- **Never hardcode API keys or URLs** — always read `$APIFY_API_TOKEN` and `$REDIS_URL` from the environment
- Never expose API key values in responses or logs
- Store only first 300 chars as preview
- If Apify returns empty, tell user the page may be blocked
```
