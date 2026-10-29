// Typed client for the dashboard backend. Keys NEVER appear in these types —
// the server only ever returns masked hints.
import type { OverviewData, ModelUsage, Provider, BudgetDef, AlertItem } from '../shared';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error ?? j.message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export interface LogsResponse { items: RequestLogRow[]; total: number; page: number; pageSize: number }
export interface RequestLogRow {
  id: number; provider: Provider; request_id: string; timestamp: string; model: string | null;
  upstream_provider: string | null; input_tokens: number | null; output_tokens: number | null;
  total_tokens: number | null; native_currency: string | null; native_amount: number | null;
  cost_usd: number | null; latency_ms: number | null; status: string; origin: string | null;
  stream: number | null; error_message: string | null; synced_at: string;
}
export interface PriceRow {
  provider: string; model_id: string; name: string | null; context_length: number | null;
  input_per_musd: number | null; output_per_musd: number | null; currency: string; fetched_at: string;
}
export interface SyncRun { id: number; provider: string; started_at: string; finished_at: string | null; status: string; message: string | null; rows_upserted: number }
export interface ProvidersStatus {
  demoMode: boolean;
  openai: any;
  openrouter: any;
}

export const getOverview = (q: string) => api<OverviewData>(`/overview?${q}`);
export const getModels = (q: string) => api<{ models: ModelUsage[]; start: string; end: string }>(`/models?${q}`);
export const getLogs = (q: string) => api<LogsResponse>(`/logs?${q}`);
export const getProvidersStatus = () => api<ProvidersStatus>('/providers/status');
export const getSettings = () => api<Record<string, string>>('/settings');
export const putSettings = (body: object) => api<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(body) });
export const putBudgets = (budgets: BudgetDef[]) => api<{ ok: boolean; budgets: BudgetDef[] }>('/settings/budgets', { method: 'PUT', body: JSON.stringify({ budgets }) });
export const runSync = (backfillDays?: number) => api<any>('/sync', { method: 'POST', body: JSON.stringify({ backfillDays }) });
export const getSyncRuns = () => api<SyncRun[]>('/sync/runs');
export const setCredential = (provider: string, action: 'set' | 'delete', key?: string) =>
  api<any>(`/credentials/${provider}`, { method: 'POST', body: JSON.stringify({ action, key }) });
export const testCredential = (provider: string, key?: string) =>
  api<{ ok: boolean; message: string; needsAdminHint?: boolean }>('/credentials/test', { method: 'POST', body: JSON.stringify({ provider, key }) });
export const toggleDemo = (enable: boolean, days = 90) => api<any>('/demo', { method: 'POST', body: JSON.stringify({ enable, days }) });
export const getAlerts = () => api<AlertItem[]>('/alerts');
export const ackAlert = (id: number) => api<{ ok: boolean }>(`/alerts/${id}/ack`, { method: 'POST' });
export const getPrices = (q: string) => api<{ prices: PriceRow[]; note: string }>(`/prices?q=${encodeURIComponent(q)}`);
export const costCalc = (body: object) => api<any>('/cost-calc', { method: 'POST', body: JSON.stringify(body) });
export const login = (username: string, password: string) => api<{ ok: boolean }>('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
export const setup = (username: string, password: string) => api<{ ok: boolean }>('/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
export const logout = () => api<{ ok: boolean }>('/logout', { method: 'POST' });
export const me = () => api<{ authenticated: boolean; username?: string }>('/me');
export const setupStatus = () => api<{ needsSetup: boolean; authDisabled: boolean }>('/setup-status');
