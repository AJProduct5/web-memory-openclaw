---
name: web-memory
description: Watch any URL for changes over time. Uses Apify to fetch live page content and Redis to store content hashes. Detects what changed between checks.
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
Uses Redis if REDIS_URL is available. Falls back to local JSON file at workspace/memory/web-memory.json if Redis is unavailable.

## Commands

### Watch a URL
Trigger: "watch [url]", "monitor [url]", "track [url]"

Steps:
1. Call Apify Website Content Crawler to fetch the URL content:
   POST https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items?token={APIFY_API_TOKEN}&timeout=60
   Body: {"startUrls":[{"url":"TARGET_URL"}],"maxCrawlPages":1,"crawlerType":"cheerio","outputFormats":["markdown"]}
2. Extract the text field from the first result item.
3. Create a SHA-256 hash: echo -n "CONTENT" | sha256sum
4. Store the record in Redis or local JSON fallback.
5. Reply: "Now watching [url]. I'll alert you when anything changes."

### Check a URL for changes
Trigger: "check [url]", "anything changed on [url]", "has [url] changed"

Steps:
1. Fetch current content from Apify (same call as Watch).
2. Hash the new content.
3. Get stored record from Redis or local JSON file.
4. Compare old hash to new hash:
   - If SAME: Reply "No changes on [url] since [last_checked]."
   - If DIFFERENT: Update storage, summarize what changed in plain English.

### List watched pages
Trigger: "what am I watching", "list watched pages", "show monitored urls"

Steps:
1. Read all records from Redis or local JSON file.
2. Return each URL with its last_checked timestamp and preview.

### Stop watching
Trigger: "stop watching [url]", "unwatch [url]"

Steps:
1. Delete the record from Redis or local JSON file.
2. Confirm to the user.

## Rules
- Always limit Apify crawl to maxCrawlPages: 1
- Never expose API keys in responses
- Store only first 300 chars as preview
- If Apify returns empty, tell user the page may be blocked
