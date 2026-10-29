// SQLite persistence layer (better-sqlite3). Chosen over PostgreSQL for a
// zero-dependency single-user deployment; schema is provider-agnostic so it
// maps cleanly onto a Postgres/Prisma setup later. All timestamps are UTC ISO.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Provider = 'openai' | 'openrouter';

export interface UsageDailyRow {
  id: number;
  provider: Provider;
  date: string;            // YYYY-MM-DD (UTC)
  model: string;           // 'all' = provider aggregate
  requests: number;
  success_requests: number;
  failed_requests: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cached_input_tokens: number;
  audio_input_tokens: number;
  audio_output_tokens: number;
  image_count: number;
  second_count: number;
  cost_usd: number | null; // provider-reported actual cost (null = unavailable)
  estimated_cost_usd: number | null; // locally computed estimate
  cost_source: string;     // 'provider_reported' | 'estimated' | 'demo'
  source_id: string;       // dedupe key from provider payload
  synced_at: string;
}

let db: Database.Database | null = null;
let currentFile = '';

export function getDb(dbFile?: string): Database.Database {
  const file = dbFile ?? process.env.DATABASE_FILE ?? path.resolve(process.cwd(), 'data', 'dashboard.db');
  if (db && currentFile === file) return db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new Database(file);
  currentFile = file;
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(d: Database.Database) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- Normalized daily usage per provider+model. UNIQUE constraint prevents
  -- duplicate rows when the same period is re-synced (upsert on conflict).
  CREATE TABLE IF NOT EXISTS usage_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    date TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT 'all',
    requests INTEGER NOT NULL DEFAULT 0,
    success_requests INTEGER NOT NULL DEFAULT 0,
    failed_requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    audio_input_tokens INTEGER NOT NULL DEFAULT 0,
    audio_output_tokens INTEGER NOT NULL DEFAULT 0,
    image_count INTEGER NOT NULL DEFAULT 0,
    second_count INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    estimated_cost_usd REAL,
    cost_source TEXT NOT NULL DEFAULT 'provider_reported',
    source_id TEXT NOT NULL,
    synced_at TEXT NOT NULL,
    UNIQUE(provider, date, model, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_usage_date ON usage_daily(date);
  CREATE INDEX IF NOT EXISTS idx_usage_provider_date ON usage_daily(provider, date);
  CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_daily(provider, model, date);

  -- Request/generation level logs (OpenRouter activity feed; OpenAI does not
  -- expose per-request logs via its public Usage API — clearly labeled there).
  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    request_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    model TEXT,
    upstream_provider TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    native_currency TEXT,
    native_amount REAL,
    cost_usd REAL,
    latency_ms REAL,
    status TEXT,               -- 'success' | 'error' | 'unknown'
    origin TEXT,
    stream INTEGER,
    error_message TEXT,
    synced_at TEXT NOT NULL,
    UNIQUE(provider, request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model);

  -- Cached model catalog/pricing (public endpoint, no auth required).
  CREATE TABLE IF NOT EXISTS model_prices (
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT,
    context_length INTEGER,
    input_per_musd REAL,      -- USD per 1M prompt tokens
    output_per_musd REAL,     -- USD per 1M completion tokens
    pricing_source TEXT,      -- 'prompt'/'completion' unit label
    currency TEXT DEFAULT 'USD',
    raw_json TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (provider, model_id)
  );

  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',   -- running|success|partial|error
    message TEXT,
    rows_upserted INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    provider TEXT NOT NULL,          -- 'combined' allowed
    kind TEXT NOT NULL,              -- budget_50/budget_75/budget_90/budget_100/low_credits/sync_error/spike
    message TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    acknowledged INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `);
}

// ---------- settings helpers ----------
export function settingGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function settingSet(key: string, value: string) {
  getDb().prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
export function settingDel(key: string) {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// ---------- sync state ----------
export interface SyncState {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastStatus: 'never' | 'success' | 'partial' | 'error';
  lastMessage: string | null;
}
const SYNC_DEFAULT: SyncState = { lastSuccessAt: null, lastAttemptAt: null, lastStatus: 'never', lastMessage: null };

export function getSyncState(provider: string): SyncState {
  const raw = settingGet(`sync.${provider}`);
  if (!raw) return { ...SYNC_DEFAULT };
  try { return { ...SYNC_DEFAULT, ...JSON.parse(raw) }; } catch { return { ...SYNC_DEFAULT }; }
}
export function setSyncState(provider: string, s: SyncState) {
  settingSet(`sync.${provider}`, JSON.stringify(s));
}

export function logSyncRun(provider: string, startedAt: string, status: string, message: string, rows: number) {
  getDb().prepare(
    'INSERT INTO sync_runs (provider, started_at, finished_at, status, message, rows_upserted) VALUES (?,?,?,?,?,?)'
  ).run(provider, startedAt, new Date().toISOString(), status, message, rows);
}
