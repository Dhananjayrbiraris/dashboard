// AI Usage Dashboard — backend server.
// Security model:
//  * Provider API keys are stored ONLY server-side (AES-256-GCM encrypted at rest).
//  * All /api/* endpoints except /api/health, /api/setup-status and /api/login
//    require a session token (httpOnly cookie) — single-user auth now, table
//    ready for multi-user later.
//  * Responses NEVER include raw keys; only masked hints.
//  * Login is rate-limited; body size limited; provider fetches run server-side only.
import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { getDb, settingGet, settingSet, settingDel, getSyncState, setSyncState, logSyncRun } from './db.js';
import { encrypt, decrypt, maskKey, hashToken, randomToken } from './crypto.js';
import { openaiApiKey, syncOpenAI, testOpenAIKey, upsertUsage } from './openai.js';
import type { NormalizedUsage } from './openai.js';
import { orKey, getKeyInfo, getCredits, syncOpenRouterActivity, rollupActivityToDaily, refreshModelPrices, testOpenRouterKey } from './openrouter.js';
import { generateDemoData, clearDemoData, demoEnabled } from './demo.js';
import {
  computeTotals, buildSeries, aggregateByModel, evaluateBudget, forecastMonthEnd,
  periodWindow, addDaysIso, utcToday, daysBetween, fmtUsd,
} from '../shared.js';
import type { BudgetDef, RawUsageRow, Provider } from '../shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');
process.env.DATA_DIR = DATA_DIR;
const PORT = Number(process.env.PORT ?? 8787);
const AUTH_DISABLED = process.env.AUTH_DISABLED === '1'; // documented dev escape hatch only

getDb(path.join(DATA_DIR, 'dashboard.db'));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// ---------- simple in-memory rate limiter ----------
const buckets = new Map<string, { count: number; reset: number }>();
function rateLimit(limit: number, windowMs: number) {
  return (req: any, res: any, next: any) => {
    const ip = req.ip ?? 'unknown';
    const key = `${ip}:${req.path}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count++;
    if (b.count > limit) return res.status(429).json({ error: 'Too many requests, slow down.' });
    next();
  };
}
app.use('/api', rateLimit(300, 60_000));

// ---------- auth ----------
function createSession(res: any, userId: number) {
  const token = randomToken();
  const db = getDb();
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?,?,?)')
    .run(hashToken(token), new Date().toISOString(), new Date(Date.now() + 30 * 86400_000).toISOString());
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 30 * 86400_000,
  });
  return userId;
}

function currentUser(req: any): any | null {
  if (AUTH_DISABLED) return { id: 0, username: '(auth disabled)' };
  const token = req.cookies?.session;
  if (!token) return null;
  const db = getDb();
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(token)) as any;
  if (!s || Date.parse(s.expires_at) < Date.now()) return null;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(1) as any;
  return u ?? null;
}

function requireAuth(req: any, res: any, next: any) {
  if (currentUser(req)) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

function hashPassword(pw: string, salt: string) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}

function ensureDefaultAdmin() {
  const db = getDb();
  const n = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
  if (n === 0) {
    const pw = process.env.ADMIN_PASSWORD || '';
    if (!pw) return false; // no bootstrap password provided → setup mode
    const salt = crypto.randomBytes(16).toString('hex');
    db.prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?,?,?,?)')
      .run(process.env.ADMIN_USERNAME || 'admin', hashPassword(pw, salt), salt, new Date().toISOString());
  }
  return true;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/setup-status', (_req, res) => {
  const db = getDb();
  const hasUser = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c > 0;
  res.json({ needsSetup: !hasUser, authDisabled: AUTH_DISABLED });
});

app.post('/api/setup', rateLimit(5, 60_000), (req, res) => {
  const db = getDb();
  if ((db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c > 0) {
    return res.status(400).json({ error: 'Account already exists' });
  }
  const { username, password } = req.body ?? {};
  if (!username || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Choose a username and a password of at least 8 characters' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (username, password_hash, salt, created_at) VALUES (?,?,?,?)')
    .run(String(username).slice(0, 40), hashPassword(password, salt), salt, new Date().toISOString());
  const u = db.prepare('SELECT * FROM users WHERE id=1').get();
  createSession(res, (u as any).id);
  res.json({ ok: true });
});

app.post('/api/login', rateLimit(10, 60_000), (req, res) => {
  const db = getDb();
  const { username, password } = req.body ?? {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username ?? '')) as any;
  if (!u || typeof password !== 'string') return res.status(401).json({ error: 'Invalid credentials' });
  const h = hashPassword(password, u.salt);
  if (!crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  createSession(res, u.id);
  res.json({ ok: true, username: u.username });
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const u = currentUser(req);
  res.json(u ? { authenticated: true, username: u.username } : { authenticated: false });
});

// Every data endpoint requires auth:
app.use('/api', (req, res, next) => {
  if (['/health', '/setup-status', '/login', '/setup', '/logout'].includes(req.path)) return next();
  return requireAuth(req, res, next);
});

// ---------- helpers ----------
function queryRows(start: string, end: string, provider?: string, model?: string, projectId?: string): RawUsageRow[] {
  let sql = `SELECT provider,date,model,requests,success_requests,failed_requests,input_tokens,output_tokens,cost_usd,estimated_cost_usd,cost_source
             FROM usage_daily WHERE date>=? AND date<=?`;
  const args: any[] = [start, end];
  if (provider && provider !== 'all') { sql += ' AND provider=?'; args.push(provider); }
  if (model && model !== 'all') { sql += ' AND model LIKE ?'; args.push(`%${model}%`); }
  return getDb().prepare(sql).all(...args) as RawUsageRow[];
}

function lastSeenByModel(): Map<string, string> {
  const rows = getDb().prepare(`SELECT provider, model, MAX(date) AS d FROM usage_daily GROUP BY provider, model`).all() as any[];
  return new Map(rows.map((r) => [`${r.provider}|${r.model}`, r.d]));
}

function getBudgets(): BudgetDef[] {
  const raw = settingGet('budgets');
  if (!raw) {
    const defaults: BudgetDef[] = [
      { id: 'b-month-combined', name: 'Monthly combined budget', scope: 'combined', period: 'monthly', limitUsd: 100, enabled: true },
      { id: 'b-day-combined', name: 'Daily combined budget', scope: 'combined', period: 'daily', limitUsd: 10, enabled: true },
      { id: 'b-week-combined', name: 'Weekly combined budget', scope: 'combined', period: 'weekly', limitUsd: 50, enabled: true },
    ];
    settingSet('budgets', JSON.stringify(defaults));
    return defaults;
  }
  try { return JSON.parse(raw); } catch { return []; }
}

function spendForScope(scope: 'combined' | Provider, start: string, end: string): number {
  const rows = queryRows(start, end, scope === 'combined' ? undefined : scope);
  return computeTotals(rows).costUsd;
}

// ---------- alert engine ----------
function raiseAlert(provider: string, kind: string, message: string, dedupeKey: string) {
  getDb().prepare(`INSERT OR IGNORE INTO alerts (created_at, provider, kind, message, dedupe_key) VALUES (?,?,?,?,?)`)
    .run(new Date().toISOString(), provider, kind, message, dedupeKey);
}

async function dispatchWebhook(payload: object) {
  const url = settingGet('alerts.webhook_url') || process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try { await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
  catch { /* webhook failures must not break sync */ }
}

function checkBudgetAlerts() {
  const today = utcToday();
  for (const b of getBudgets().filter((x) => x.enabled)) {
    const { start, end } = periodWindow(b.period);
    const spent = spendForScope(b.scope, start, end);
    const pct = b.limitUsd > 0 ? (spent / b.limitUsd) * 100 : 0;
    for (const t of [50, 75, 90, 100]) {
      if (pct >= t) {
        const week = today.slice(0, 7); // one alert per threshold per budget per ISO-week
        raiseAlert(b.scope, `budget_${t}`,
          `Budget "${b.name}" is at ${pct.toFixed(0)}% (${fmtUsd(spent)} of ${fmtUsd(b.limitUsd)})`,
          `budget:${b.id}:${t}:${week}`);
      }
    }
    // spending acceleration warning: today's pace vs 7-day average
    if (b.period === 'monthly' && pct >= 25) {
      const hist = buildSeries(queryRows(addDaysIso(today, -8), addDaysIso(today, -1)), addDaysIso(today, -8), addDaysIso(today, -1));
      const avg = hist.reduce((s, h) => s + h.combinedCost, 0) / Math.max(hist.filter((h) => h.combinedCost > 0).length, 1);
      const dayStart = spendForScope(b.scope, today, today);
      if (avg > 0 && dayStart > avg * 2.5) {
        raiseAlert(b.scope, 'spike', `Spending spike: today ${fmtUsd(dayStart)} vs 7-day daily average ${fmtUsd(avg)}`, `spike:${b.id}:${today}`);
      }
    }
  }
  const alerts = getDb().prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50').all() as any[];
  for (const a of alerts.filter((x) => !x.acknowledged && ['budget_90', 'budget_100', 'low_credits', 'sync_error', 'spike'].includes(x.kind))) {
    void dispatchWebhook({ source: 'ai-usage-dashboard', ...a });
  }
}

// ---------- sync ----------
let syncing = false;
async function runSync(opts: { backfillDays?: number } = {}) {
  if (syncing) return { skipped: true, message: 'Sync already in progress' };
  syncing = true;
  const started = new Date().toISOString();
  const results: any = { openai: null, openrouter: null, warnings: [] as string[] };
  try {
    const oa = openaiApiKey(DATA_DIR);
    if (oa.key) {
      const st = getSyncState('openai');
      const backfill = opts.backfillDays ?? Number(settingGet('openai.backfill_days') ?? 90);
      const start = st.lastSuccessAt ? addDaysIso(st.lastSuccessAt.slice(0, 10), -2) : addDaysIso(utcToday(), -backfill);
      const end = utcToday();
      try {
        const proj = settingGet('openai.project_id') ?? null;
        const r = await syncOpenAI(start, end, proj);
        results.openai = { rows: r.rows, warnings: r.warnings };
        const status = r.warnings.length ? 'partial' : 'success';
        setSyncState('openai', {
          lastSuccessAt: status === 'success' ? started : st.lastSuccessAt,
          lastAttemptAt: started, lastStatus: status, lastMessage: r.warnings.join(' | ') || null,
        });
        logSyncRun('openai', started, status, r.warnings.join(' | ') || `${r.rows} rows`, r.rows);
        if (status === 'partial') raiseAlert('openai', 'sync_error', `OpenAI sync partial: ${r.warnings[0]}`, `syncao:${utcToday()}`);
      } catch (e: any) {
        results.openai = { error: e.message };
        setSyncState('openai', { ...st, lastAttemptAt: started, lastStatus: 'error', lastMessage: e.message });
        logSyncRun('openai', started, 'error', e.message, 0);
        raiseAlert('openai', 'sync_error', `OpenAI sync failed: ${e.message}`, `syncao-err:${started.slice(0, 13)}`);
      }
    }

    if (orKey()) {
      const st = getSyncState('openrouter');
      try {
        const act = await syncOpenRouterActivity();
        const rows = rollupActivityToDaily();
        await refreshModelPrices().catch(() => 0);
        results.openrouter = { logs: act.logs, rows, warnings: act.warnings };
        const status = act.warnings.length ? 'partial' : 'success';
        setSyncState('openrouter', {
          lastSuccessAt: status === 'success' ? started : st.lastSuccessAt,
          lastAttemptAt: started, lastStatus: status, lastMessage: act.warnings.join(' | ') || null,
        });
        logSyncRun('openrouter', started, status, act.warnings.join(' | ') || `${rows} aggregates, ${act.logs} log rows`, rows);
        // low credits alert (< $5 remaining, when data available)
        try {
          const cr = await getCredits();
          if (cr.remaining != null && cr.remaining < 5) {
            raiseAlert('openrouter', 'low_credits', `OpenRouter credits low: $${cr.remaining.toFixed(2)} remaining`, `credits:${utcToday()}`);
          }
        } catch { /* ignore */ }
      } catch (e: any) {
        results.openrouter = { error: e.message };
        setSyncState('openrouter', { ...st, lastAttemptAt: started, lastStatus: 'error', lastMessage: e.message });
        logSyncRun('openrouter', started, 'error', e.message, 0);
        raiseAlert('openrouter', 'sync_error', `OpenRouter sync failed: ${e.message}`, `syncor-err:${started.slice(0, 13)}`);
      }
    }
    checkBudgetAlerts();
    return results;
  } finally {
    syncing = false;
  }
}

// Scheduler: interval minutes configurable via settings/env (min 5 to respect APIs).
let syncTimer: NodeJS.Timeout | null = null;
function applySchedule() {
  if (syncTimer) clearInterval(syncTimer);
  const mins = Math.max(5, Number(settingGet('sync.interval_minutes') ?? process.env.SYNC_INTERVAL_MINUTES ?? 60));
  syncTimer = setInterval(() => { void runSync(); }, mins * 60_000);
  syncTimer.unref?.();
}

// ---------- API endpoints ----------
app.get('/api/overview', (req, res) => {
  const end = String(req.query.end ?? utcToday());
  let start = String(req.query.start ?? '');
  const preset = String(req.query.range ?? '30d');
  if (!start || start === 'auto') {
    const presetDays = preset === '7d' ? 7 : preset === '90d' ? 90 : preset === '365d' ? 365 : preset === 'mtd' ? Number(utcToday().slice(8, 10)) : 30;
    start = addDaysIso(end, -(presetDays - 1));
  }
  const days = Math.max(daysBetween(start, end) + 1, 1);
  const provider = String(req.query.provider ?? 'all');
  const model = String(req.query.model ?? 'all');
  const cur = queryRows(start, end, provider, model);
  const prevEnd = addDaysIso(start, -1);
  const prevStart = addDaysIso(prevEnd, -(days - 1));
  const prev = queryRows(prevStart, prevEnd, provider, model);
  const totals = computeTotals(cur);
  const prevTotals = computeTotals(prev);
  const series = buildSeries(queryRows(start, end, provider), start, end);
  const pct = (a: number, b: number) => (!b ? (a ? null : 0) : ((a - b) / b) * 100);
  const dayOf = (iso: string) => queryRows(iso, iso, provider, model);
  const deltas = {
    daily: relChange(totals, computeTotals(dayOf(addDaysIso(end, -1)))),
    weekly: relChange(totals, computeTotals(queryRows(addDaysIso(end, -6), end, provider, model))),
    monthly: relChange(totals, computeTotals(queryRows(addDaysIso(end, -29), end, provider, model))),
  };
  function relChange(a: any, b: any) {
    return { costPct: pct(a.costUsd, b.costUsd), tokensPct: pct(a.totalTokens, b.totalTokens), requestsPct: pct(a.requests, b.requests) };
  }
  const budgets = getBudgets().map((b) => {
    const { start: bs, end: be } = periodWindow(b.period);
    return evaluateBudget(b, spendForScope(b.scope, bs, be), buildSeries(queryRows(addDaysIso(be, -60), be), addDaysIso(be, -60), be));
  });
  const fc = forecastMonthEnd(series.map((s) => ({ date: s.date, cost: s.combinedCost })));
  const alerts = getDb().prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 20').all();
  res.json({
    range: { start, end, days },
    totals, prevTotals, deltas, series,
    providers: { openai: computeTotals(queryRows(start, end, 'openai')), openrouter: computeTotals(queryRows(start, end, 'openrouter')) },
    budgets, alerts, forecast: fc,
    demoMode: demoEnabled(),
    generatedAt: new Date().toISOString(),
  });
});

app.get('/api/models', (req, res) => {
  const end = String(req.query.end ?? utcToday());
  const start = String(req.query.start ?? addDaysIso(end, -29));
  const rows = queryRows(start, end, String(req.query.provider ?? 'all'), String(req.query.model ?? 'all'));
  res.json({ models: aggregateByModel(rows, lastSeenByModel()), start, end });
});

app.get('/api/logs', (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize ?? 50)));
  const conds: string[] = []; const args: any[] = [];
  if (req.query.provider && req.query.provider !== 'all') { conds.push('provider=?'); args.push(req.query.provider); }
  if (req.query.model) { conds.push('model LIKE ?'); args.push(`%${req.query.model}%`); }
  if (req.query.status && req.query.status !== 'all') { conds.push('status=?'); args.push(req.query.status); }
  if (req.query.start) { conds.push('timestamp>=?'); args.push(`${req.query.start}T00:00:00Z`); }
  if (req.query.end) { conds.push('timestamp<=?'); args.push(`${req.query.end}T23:59:59Z`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const db = getDb();
  const total = (db.prepare(`SELECT COUNT(*) c FROM request_logs ${where}`).get(...args) as any).c;
  const items = db.prepare(`SELECT * FROM request_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  res.json({ items, total, page, pageSize });
});

app.get('/api/logs/export.csv', (req, res) => {
  const rows = getDb().prepare('SELECT * FROM request_logs ORDER BY timestamp DESC LIMIT 10000').all() as any[];
  const cols = ['timestamp', 'provider', 'model', 'upstream_provider', 'request_id', 'input_tokens', 'output_tokens', 'total_tokens', 'cost_usd', 'native_currency', 'native_amount', 'latency_ms', 'status', 'error_message', 'origin'];
  const esc = (v: any) => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="api-request-logs.csv"');
  res.send(csv);
});

app.get('/api/providers/status', async (_req, res) => {
  const out: any = { demoMode: demoEnabled(), openai: null, openrouter: null };
  const oa = openaiApiKey(DATA_DIR);
  out.openai = {
    connected: !!oa.key, authMode: oa.source ?? 'none',
    keyHint: oa.key ? maskKey(oa.key) : null,
    lastSync: getSyncState('openai'),
    balance: { amountUsd: null, label: 'Unavailable via public API', basis: 'unavailable', note: 'OpenAI does not expose account balance through the public API. Use the platform billing page or Cost API figures shown here.' },
    rateLimits: (() => {
      try {
        const hdr = (globalThis as any).__openaiRateHeaders;
        return hdr ? Object.entries(hdr).map(([label, value]) => ({ label, value: String(value) })) : null;
      } catch { return null; }
    })(),
    dataAvailability: [
      'Actual billed costs: /v1/organization/costs (requires admin/org key)',
      'Tokens & requests by model/day: /v1/organization/usage/completions|embeddings|images',
      'Projects: /v1/organization/projects',
      'Per-request logs: NOT available from OpenAI public API',
      'Rate limits: exposed via response headers on inference calls only; not stored here',
    ],
  };
  if (orKey()) {
    try {
      const ki = await getKeyInfo();
      const cr = await getCredits().catch(() => null);
      out.openrouter = {
        connected: true, authMode: settingGet('openrouter.api_key_enc') ? 'settings' : 'env',
        keyHint: maskKey(orKey()!),
        lastSync: getSyncState('openrouter'),
        balance: cr?.remaining != null
          ? { amountUsd: cr.remaining, label: 'Remaining purchased credits', basis: 'purchased_credits', note: cr.note }
          : { amountUsd: null, label: 'Credits unavailable', basis: 'unavailable' },
        rateLimits: [
          ki.rateLimitRequestsPerMinute ? { label: 'Key rate limit', value: `${ki.rateLimitRequestsPerMinute} req/min` } : null,
          ki.limit != null ? { label: 'Hard credit limit on key (provider-imposed)', value: `$${ki.limit}` } : null,
          ki.unlimited ? { label: 'Key spending', value: 'Unlimited (no per-key cap)' } : null,
          ki.isFreeTier ? { label: 'Tier', value: 'Free tier' } : null,
        ].filter(Boolean),
        keyUsageUsd: ki.usage, keyLabel: ki.label,
        dataAvailability: [
          'Actual spend per request: /api/v1/activity (USD "usage" field)',
          'Key spend & limits: /api/v1/key',
          'Purchased credits & lifetime usage: /api/v1/credits',
          'Model pricing catalog: /api/v1/models (public)',
          'Upstream routed provider per request: not exposed by activity feed',
        ],
      };
    } catch (e: any) {
      out.openrouter = { connected: true, error: e.message, lastSync: getSyncState('openrouter') };
    }
  } else {
    out.openrouter = { connected: false, authMode: 'none', keyHint: null, lastSync: getSyncState('openrouter'),
      dataAvailability: ['Connect an OpenRouter key to enable Key/Credits/Activity endpoints.'] };
  }
  res.json(out);
});

app.get('/api/prices', (req, res) => {
  const search = String(req.query.q ?? '');
  const rows = getDb().prepare(
    `SELECT provider, model_id, name, context_length, input_per_musd, output_per_musd, currency, fetched_at
     FROM model_prices WHERE model_id LIKE ? OR name LIKE ? ORDER BY provider, model_id LIMIT 500`
  ).all(`%${search}%`, `%${search}%`);
  res.json({ prices: rows, cached: true, note: 'Cached from OpenRouter public /models catalog. Prices are list prices, not your billed amounts.' });
});

app.post('/api/cost-calc', (req, res) => {
  const { model, inputTokens = 0, outputTokens = 0, provider = 'openrouter' } = req.body ?? {};
  const row = getDb().prepare('SELECT * FROM model_prices WHERE provider=? AND model_id=?').get(provider, model) as any;
  if (!row) return res.status(404).json({ error: `No cached price for ${provider}/${model}. Sync OpenRouter first.` });
  const cost = (inputTokens * (row.input_per_musd ?? 0) + outputTokens * (row.output_per_musd ?? 0)) / 1e6;
  res.json({ model, provider, inputTokens, outputTokens, inputPerM: row.input_per_musd, outputPerM: row.output_per_musd, estimatedCostUsd: cost, basis: 'estimated', note: 'Estimated from cached list pricing; actual billed cost may differ (batch/discounted pricing).' });
});

app.get('/api/sync/runs', (_req, res) => {
  res.json(getDb().prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 30').all());
});

app.post('/api/sync', async (req, res) => {
  const r = await runSync({ backfillDays: Number((req.body ?? {}).backfillDays ?? 0) || undefined });
  res.json(r);
});

// ---------- settings ----------
app.get('/api/settings', (_req, res) => {
  const db = getDb();
  const all = db.prepare('SELECT key,value FROM settings').all() as any[];
  const out: Record<string, any> = {};
  for (const r of all) {
    if (r.key.endsWith('.api_key_enc')) continue; // never expose secrets or their existence beyond hint
    out[r.key] = r.value;
  }
  out['openai.key_set'] = !!settingGet('openai.api_key_enc') || !!process.env.OPENAI_API_KEY;
  out['openrouter.key_set'] = !!settingGet('openrouter.api_key_enc') || !!process.env.OPENROUTER_API_KEY;
  res.json(out);
});

app.put('/api/settings', (req, res) => {
  const body = req.body ?? {};
  const allowed = ['currency', 'timezone', 'sync.interval_minutes', 'alerts.email', 'alerts.webhook_url_enabled', 'retention.days', 'openai.biz_member', 'openai.project_id'];
  for (const k of allowed) {
    if (body[k] !== undefined) settingSet(k, String(body[k]));
  }
  if (body['alerts.webhook_url'] !== undefined) {
    const v = String(body['alerts.webhook_url']);
    if (v) settingSet('alerts.webhook_url', v); else settingDel('alerts.webhook_url');
  }
  applySchedule();
  res.json({ ok: true });
});

app.put('/api/settings/budgets', (req, res) => {
  const budgets = (req.body ?? {}).budgets;
  if (!Array.isArray(budgets)) return res.status(400).json({ error: 'budgets must be an array' });
  const clean: BudgetDef[] = budgets.map((b: any, i: number) => ({
    id: String(b.id ?? `b-${i}-${Date.now()}`),
    name: String(b.name ?? 'Budget').slice(0, 80),
    scope: ['combined', 'openai', 'openrouter'].includes(b.scope) ? b.scope : 'combined',
    period: ['daily', 'weekly', 'monthly'].includes(b.period) ? b.period : 'monthly',
    limitUsd: Math.max(0, Number(b.limitUsd) || 0),
    enabled: !!b.enabled,
  }));
  settingSet('budgets', JSON.stringify(clean));
  res.json({ ok: true, budgets: clean });
});

// Secure credential update / rotation / disconnection.
app.post('/api/credentials/:provider', (req, res) => {
  const p = req.params.provider;
  if (p !== 'openai' && p !== 'openrouter') return res.status(400).json({ error: 'Unknown provider' });
  const { action, key } = req.body ?? {};
  const encKey = `${p}.api_key_enc`;
  if (action === 'set') {
    if (typeof key !== 'string' || key.length < 8) return res.status(400).json({ error: 'Provide a valid API key' });
    settingSet(encKey, encrypt(key.trim(), DATA_DIR));
    res.json({ ok: true, keyHint: maskKey(key.trim()) });
  } else if (action === 'delete') {
    settingDel(encKey);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'action must be set|delete' });
  }
});

app.post('/api/credentials/test', async (req, res) => {
  const { provider, key } = req.body ?? {};
  // If key omitted, test the stored one (server-side decrypt; never returned).
  let plain = typeof key === 'string' ? key.trim() : '';
  if (!plain) {
    const enc = settingGet(`${provider}.api_key_enc`);
    plain = enc ? decrypt(enc, DATA_DIR) : (provider === 'openai' ? (process.env.OPENAI_API_KEY ?? '') : (process.env.OPENROUTER_API_KEY ?? ''));
  }
  if (!plain) return res.status(400).json({ error: 'No key supplied or stored' });
  if (provider === 'openai') res.json(await testOpenAIKey(plain));
  else if (provider === 'openrouter') res.json(await testOpenRouterKey(plain));
  else res.status(400).json({ error: 'Unknown provider' });
});

app.post('/api/demo', (req, res) => {
  const enable = !!(req.body ?? {}).enable;
  if (enable) {
    const n = generateDemoData(Number((req.body ?? {}).days ?? 90));
    res.json({ ok: true, rows: n, note: 'DEMO MODE: synthetic data for UI evaluation. Not real usage.' });
  } else {
    clearDemoData();
    res.json({ ok: true, note: 'Demo data removed.' });
  }
});

app.get('/api/alerts', (_req, res) => res.json(getDb().prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 100').all()));
app.post('/api/alerts/:id/ack', (req, res) => {
  getDb().prepare('UPDATE alerts SET acknowledged=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/data', (req, res) => {
  // Data export/retention control: wipe stored usage (keys & budgets kept).
  if (req.query.confirm !== 'DELETE') return res.status(400).json({ error: 'Pass ?confirm=DELETE' });
  const db = getDb();
  db.prepare('DELETE FROM usage_daily').run();
  db.prepare('DELETE FROM request_logs').run();
  db.prepare('DELETE FROM alerts').run();
  res.json({ ok: true });
});

app.get('/api/export/usage.csv', (req, res) => {
  const rows = queryRows(String(req.query.start ?? '2000-01-01'), String(req.query.end ?? utcToday())) as any[];
  const cols = ['provider', 'date', 'model', 'requests', 'success_requests', 'failed_requests', 'input_tokens', 'output_tokens', 'cost_usd', 'estimated_cost_usd', 'cost_source'];
  const esc = (v: any) => v == null ? '' : `"${String(v).replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="usage-export.csv"');
  res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
});

// ---------- static frontend (production build) ----------
const dist = path.resolve(__dirname, '..', 'dist');
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

ensureDefaultAdmin();
applySchedule();
if (process.env.STARTUP_SYNC === '1') setTimeout(() => void runSync(), 1500);

app.listen(PORT, () => {
  console.log(`[server] AI Usage Dashboard API on http://localhost:${PORT}`);
  if (AUTH_DISABLED) console.warn('[server] WARNING: AUTH_DISABLED=1 — all API endpoints are open. Development only!');
});
