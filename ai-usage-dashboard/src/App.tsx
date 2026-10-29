import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Plug, Cpu, ScrollText, Wallet, Settings as SettingsIcon, Sun, Moon, RefreshCw, LogOut, TrendingUp } from 'lucide-react';
import { FilterProvider, useFiltersQs, useTheme, useApi } from './ui';
import { OverviewPage } from './components/overview';
import { ProvidersPage, ModelsPage } from './components/pages';
import { LogsPage } from './components/logs';
import { BudgetsPage } from './components/budgets';
import { CostPage } from './components/cost';
import { SettingsPage } from './components/settings';
import { login, setup, logout, me, setupStatus, runSync } from './api';

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/providers', label: 'Providers', icon: Plug },
  { to: '/models', label: 'Models', icon: Cpu },
  { to: '/logs', label: 'Usage Logs', icon: ScrollText },
  { to: '/budgets', label: 'Budgets & Alerts', icon: Wallet },
  { to: '/cost', label: 'Cost Analysis', icon: TrendingUp },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

function GlobalFilters() {
  const { f, setF } = useFiltersQs2();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select className="input" value={f.provider} onChange={(e) => setF({ provider: e.target.value })}>
        <option value="all">All providers</option><option value="openai">OpenAI</option><option value="openrouter">OpenRouter</option>
      </select>
      <select className="input" value={f.range} onChange={(e) => setF({ range: e.target.value, start: '' })}>
        <option value="7d">Last 7 days</option><option value="30d">Last 30 days</option>
        <option value="90d">Last 90 days</option><option value="365d">Last 12 months</option><option value="mtd">Month to date</option>
        <option value="custom">Custom…</option>
      </select>
      {f.range === 'custom' && (<>
        <input type="date" className="input" value={f.start} max={f.end} onChange={(e) => setF({ start: e.target.value })} />
        <span className="text-xs">→</span>
        <input type="date" className="input" value={f.end} min={f.start} onChange={(e) => setF({ end: e.target.value })} />
      </>)}
    </div>
  );
}
// helper to access filter context + querystring builder together
import { useContext, createContext } from 'react';
import { FilterCtx } from './ui';
function useFiltersQs2() { return useContext(FilterCtx); }

function Shell({ children }: { children: React.ReactNode }) {
  const { dark, toggle } = useTheme();
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();
  async function sync() {
    setSyncing(true); setMsg(null);
    try { await runSync(); setMsg('Sync started — data refreshes automatically.'); setTimeout(() => location.reload(), 1200); }
    catch (e: any) { setMsg(`Sync failed: ${e.message}`); }
    finally { setSyncing(false); }
  }
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-slate-200 bg-white p-3 md:flex dark:border-slate-800 dark:bg-slate-900">
        <div className="mb-4 px-2 text-lg font-bold tracking-tight">⚡ AI Cost Monitor</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end as any}
            className={({ isActive }) => `mb-1 flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
            <n.icon size={16} /> {n.label}
          </NavLink>
        ))}
        <div className="mt-auto space-y-2 px-1 text-[11px] text-slate-400">
          <button className="btn w-full justify-center !py-1 text-xs" onClick={() => logout().then(() => nav('/login'))}><LogOut size={13} /> Sign out</button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white/90 px-3 py-2 backdrop-blur dark:border-slate-800 dark:bg-slate-900/90">
          <nav className="flex gap-1 overflow-x-auto md:hidden">{NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end as any} className={({ isActive }) => `whitespace-nowrap rounded px-2 py-1 text-xs ${isActive ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-500'}`}>{n.label}</NavLink>))}
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <GlobalFilters />
            <button className="btn !py-1.5" title="Manual refresh (re-sync providers)" onClick={sync} disabled={syncing}><RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /></button>
            <button className="btn !py-1.5" onClick={toggle}>{dark ? <Sun size={14} /> : <Moon size={14} />}</button>
          </div>
          {msg && <div className="w-full text-xs text-slate-500">{msg}</div>}
        </header>
        <main className="flex-1 p-3 md:p-5">{children}</main>
      </div>
    </div>
  );
}

function AuthPage() {
  const [mode, setMode] = useState<'login' | 'setup'>('login');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  useEffect(() => { setupStatus().then((s) => { if (s.needsSetup) setMode('setup'); if (s.authDisabled) nav('/'); }); }, [nav]);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    try { (mode === 'setup' ? setup(username, password) : login(username, password)); await new Promise((r) => setTimeout(r, 300)); nav('/'); }
    catch (e: any) { setErr(e.message); }
  }
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3">
        <h1 className="text-lg font-bold">⚡ AI Cost Monitor</h1>
        <p className="text-xs text-slate-500">{mode === 'setup' ? 'First run: create your dashboard admin account.' : 'Sign in to your dashboard.'}</p>
        <div><label className="label">Username</label><input className="input w-full" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></div>
        <div><label className="label">Password</label><input className="input w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} /></div>
        {mode === 'setup' && <p className="text-[11px] text-slate-400">Use at least 8 characters. Credentials are stored hashed (scrypt) server-side.</p>}
        {err && <div className="rounded bg-red-50 p-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300">{err}</div>}
        <button className="btn-primary w-full justify-center">{mode === 'setup' ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  );
}

export default function App() {
  const [checked, setChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  useEffect(() => { me().then((r) => { setAuthed(!!r.authenticated); setChecked(true); }).catch(() => setChecked(true)); }, []);
  if (!checked) return <div className="p-10 text-center text-sm text-slate-400">Loading…</div>;
  return (
    <BrowserRouter>
      {!authed ? (
        <Routes><Route path="/login" element={<AuthPage />} /><Route path="*" element={<Navigate to="/login" replace />} /></Routes>
      ) : (
        <FilterProvider>
          <Shell>
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/providers" element={<ProvidersPage />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/logs" element={<LogsPage />} />
              <Route path="/budgets" element={<BudgetsPage />} />
              <Route path="/cost" element={<CostPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Shell>
        </FilterProvider>
      )}
    </BrowserRouter>
  );
}
