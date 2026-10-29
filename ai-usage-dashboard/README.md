# ⚡ AI API Usage & Cost Monitoring Dashboard

Track, monitor and analyze **API usage, token consumption, rate limits and costs** across **OpenAI** and **OpenRouter** in one place.

Built with React + TypeScript + Vite + Tailwind + Recharts on the frontend and an Express + SQLite (better-sqlite3) backend. Single `git`-cloneable app, runs locally with two commands.

## Quick start

```bash
cd ai-usage-dashboard
npm install
cp .env.example .env        # optional — see Configuration
npm run dev                 # server :8787 + web :5173 (Vite proxies /api)
```

Open http://localhost:5173 — first visit asks you to create the admin account (or set `ADMIN_USERNAME/ADMIN_PASSWORD` in `.env`).

**No API keys yet?** Settings → *Demo mode* → “Enable demo data” generates 90 days of **clearly labeled synthetic** usage (`cost_source=demo`) so every page is explorable. Demo rows are tagged, never mixed with real data, and removed when you disable demo mode. The dashboard never fabricates figures that look real.

Production build:

```bash
npm run build && npm start   # Express serves dist/ + API on :8787
```

## What is integrated (official APIs only)

### OpenAI
| Metric | Endpoint | Notes |
|---|---|---|
| Tokens & requests by model/day | `/v1/organization/usage/completions`, `/chatgpt`, `/embeddings`, `/images` | UTC day buckets, paginated, grouped by model; supports project filter |
| Actual billed costs | `/v1/organization/costs` | Authoritative USD figures, merged into same rows as usage (no double counting) |
| Projects | `/v1/organization/projects` | Project-level breakdown where used |
| Balance / rate limits | — | **Not exposed** via public API → shown as *Unavailable*, never invented. Rate-limit headers exist only on inference calls. |

> ⚠️ OpenAI's Usage/Costs endpoints require an **admin API key** (personal/user keys get 403). The Settings connection test detects this and tells you exactly what's missing.

### OpenRouter
| Metric | Endpoint | Notes |
|---|---|---|
| Key spend, hard limit, rate limit, free tier | `/api/v1/key` | Distinguishes provider-imposed caps from your budgets |
| Purchased credits & remaining balance | `/api/v1/credits` | Labeled *purchased credits*, not billed cost |
| Per-request activity (model, tokens, USD cost) | `/api/v1/activity` | Timestamps are day-bucketed by the provider — noted in UI |
| Model pricing catalog | `/api/v1/models` (public) | Cached for the cost calculator; labeled *cached list prices* |

Upstream routed-provider per request is **not** exposed by the Activity API — the logs table shows the column and marks it unavailable rather than guessing.

## Data model & accuracy

* Normalized `usage_daily(provider, date, model, …)` with `UNIQUE(provider,date,model,source_id)` → re-syncing upserts, never duplicates.
* Every cost carries a basis: `provider_reported` (actual) / `estimated` (tokens × cached price) / `demo`. UI badges show which is which; totals report the split. Actuals always win over estimates for the same row — no double counting.
* `request_logs` (per-generation), `model_prices` cache, `sync_runs` audit trail, `alerts` with dedupe keys, encrypted `settings`, hashed sessions.
* All storage/buckets in UTC; incremental sync re-fetches last-synced-day ±2 to catch late provider updates; configurable backfill; scheduler respects a ≥5-minute interval.
* Sync failures/partial results are surfaced per provider (last status, message, run history) and raise alerts.

## Budgets & alerts

Daily/weekly/monthly budgets, combined or per provider, progress bars with 50/75/90/100% markers, spending-spike detection, low-credit warnings (<$5 remaining OpenRouter credits), sync-error alerts, optional **webhook** notification (email field is informational only in this build). Budgets are **monitoring thresholds — they do not block API spending**; provider-side hard limits are shown separately on the Providers page.

## Security

* Provider keys stored **server-side only**, AES-256-GCM encrypted at rest (`MASTER_KEY` env or auto-generated `data/.master.key`, mode 0600). Browser receives masked hints only.
* Key rotation/disconnect from Settings; env-var alternative supported.
* Session auth: scrypt-hashed passwords, random tokens stored as SHA-256 hashes, httpOnly SameSite=Lax cookies (add `COOKIE_SECURE=1` behind HTTPS). All private endpoints require auth; login/API rate-limited; JSON body size capped.
* No prompt/response content, credentials or headers are ever stored or logged. Use HTTPS in production (any reverse proxy); deploy anywhere Node runs (Fly.io/Railway/VPS — persist `./data`).

## Tests & verification

```bash
npm test          # vitest: analytics core (totals, no-double-count rule, windows, forecast…)
node tests/e2e.mjs  # end-to-end against the running server: auth, demo data, overview math, CSV, security checks
```

## Architecture

```
shared.ts              provider-independent types + pure analytics (used by both sides)
server/index.ts        Express API, auth, scheduler, alert engine, CSV export
server/openai.ts       OpenAI Usage/Costs/Projects clients + normalization + upsert
server/openrouter.ts   OpenRouter Key/Credits/Activity/Models clients + rollups
server/db.ts           SQLite schema (WAL) — portable to Postgres/Prisma
server/crypto.ts       AES-256-GCM secret storage, session hashing
src/                   React SPA: Overview · Providers · Models · Usage Logs ·
                       Budgets & Alerts · Cost Analysis · Settings
```

## Known limitations (honesty section)

* OpenAI per-request logs don't exist publicly → request counts come from daily aggregates instead.
* OpenRouter activity timestamps are day-granular; recent hours may lag until next sync.
* Forecasts/estimates use trailing averages and cached list prices — labeled everywhere, not billing truth.
* SMTP email alerts not implemented; webhook delivery is fire-and-forget.
