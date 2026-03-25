# web-memory — OpenClaw Skill

An OpenClaw skill that gives your AI agent persistent memory of the web.
Watch any webpage and get alerted only when something actually changes.

## The Problem
OpenClaw has no memory of the web. Every run starts blind — the agent 
has no idea what it saw last time and cannot tell you what changed.

## The Solution
web-memory watches URLs over time. Apify fetches the live content 
reliably. Redis stores a hash of what the page looked like last time. 
The agent only alerts you when something genuinely changed.

## How It Works

- `watch https://competitor.com/pricing` — start monitoring
- `check https://competitor.com/pricing` — detect what changed
- `list watched pages` — see all monitored URLs
- `stop watching https://competitor.com/pricing` — remove a URL

## Sponsors

- **Apify** — Website Content Crawler fetches live page content reliably, handling JavaScript and anti-bot automatically
- **Redis** — stores content hashes across agent sessions, giving the agent true persistent memory

## Built At
OpenClaw Hack Day — March 25, 2026
AWS Builder Loft, San Francisco
