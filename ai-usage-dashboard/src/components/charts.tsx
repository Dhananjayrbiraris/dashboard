import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell, ComposedChart,
} from 'recharts';
import type { DailyPoint } from '../../shared';
import { fmtUsd, fmtCompact } from '../../shared';

const OA_COLOR = '#10a37f';   // OpenAI brand-ish green
const OR_COLOR = '#8b5cf6';   // OpenRouter violet
const COMBINED = '#6366f1';

function shortDate(d: string) { return d.slice(5); }

const tooltipStyle = {
  backgroundColor: 'var(--tooltip-bg, #fff)',
  border: '1px solid #cbd5e1',
  borderRadius: 8,
  fontSize: 12,
};

export function CostAreaChart({ data }: { data: DailyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gOA" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={OA_COLOR} stopOpacity={0.35} /><stop offset="100%" stopColor={OA_COLOR} stopOpacity={0.02} /></linearGradient>
          <linearGradient id="gOR" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={OR_COLOR} stopOpacity={0.35} /><stop offset="100%" stopColor={OR_COLOR} stopOpacity={0.02} /></linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b822" />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={30} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis tickFormatter={(v: number) => fmtUsd(v, 2)} tick={{ fontSize: 11 }} width={70} stroke="#94a3b8" />
        <Tooltip labelFormatter={(l) => `UTC ${l}`} formatter={(v: any, n: any) => [fmtUsd(Number(v)), n]} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="openaiCost" name="OpenAI cost" stackId="c" stroke={OA_COLOR} fill="url(#gOA)" strokeWidth={2} />
        <Area type="monotone" dataKey="openrouterCost" name="OpenRouter cost" stackId="c" stroke={OR_COLOR} fill="url(#gOR)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function TokensChart({ data }: { data: DailyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b822" />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={30} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis tickFormatter={(v: number) => fmtCompact(v)} tick={{ fontSize: 11 }} width={56} stroke="#94a3b8" />
        <Tooltip labelFormatter={(l) => `UTC ${l}`} formatter={(v: any, n: any) => [Number(v).toLocaleString(), n]} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area type="monotone" dataKey="inputTokens" name="Input tokens" stackId="t" stroke="#0ea5e9" fill="#0ea5e933" strokeWidth={2} />
        <Area type="monotone" dataKey="outputTokens" name="Output tokens" stackId="t" stroke="#f59e0b" fill="#f59e0b33" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function RequestsChart({ data }: { data: DailyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b822" />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={30} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis tick={{ fontSize: 11 }} width={48} stroke="#94a3b8" />
        <Tooltip labelFormatter={(l) => `UTC ${l}`} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="successRequests" name="Successful" stackId="r" fill="#22c55e" radius={[0, 0, 0, 0]} />
        <Bar dataKey="failedRequests" name="Failed" stackId="r" fill="#ef4444" radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function BudgetBurnChart({ data, limit }: { data: DailyPoint[]; limit: number }) {
  let acc = 0;
  const rows = data.map((d) => { acc += d.combinedCost; return { date: d.date, cumulative: Number(acc.toFixed(6)), limit }; });
  return (
    <ResponsiveContainer width="100%" height={220}>
      <ComposedChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b822" />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={30} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis tickFormatter={(v: number) => fmtUsd(v, 2)} tick={{ fontSize: 11 }} width={70} stroke="#94a3b8" />
        <Tooltip formatter={(v: any) => fmtUsd(Number(v))} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="limit" name="Budget limit" stroke="#ef4444" strokeDasharray="6 4" dot={false} strokeWidth={2} />
        <Area type="monotone" dataKey="cumulative" name="Cumulative spend" stroke={COMBINED} fill="#6366f133" strokeWidth={2} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ModelCostBarChart({ models }: { models: { name: string; cost: number; provider: string }[] }) {
  const top = [...models].sort((a, b) => b.cost - a.cost).slice(0, 10);
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, top.length * 34)}>
      <BarChart data={top} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b822" horizontal={false} />
        <XAxis type="number" tickFormatter={(v: number) => fmtUsd(v, 2)} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis type="category" dataKey="name" width={190} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <Tooltip formatter={(v: any) => fmtUsd(Number(v))} contentStyle={tooltipStyle} />
        <Bar dataKey="cost" name="Cost" fill={COMBINED} radius={[0, 4, 4, 0]}>
          {top.map((m, i) => <Cell key={i} fill={m.provider === 'openai' ? OA_COLOR : OR_COLOR} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ProviderPie({ openaiCost, openrouterCost }: { openaiCost: number; openrouterCost: number }) {
  const data = [
    { name: 'OpenAI', value: Number(openaiCost.toFixed(6)), color: OA_COLOR },
    { name: 'OpenRouter', value: Number(openrouterCost.toFixed(6)), color: OR_COLOR },
  ].filter((d) => d.value > 0);
  if (!data.length) return <div className="py-8 text-center text-xs text-slate-400">No cost data in range</div>;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <PieChart>
        <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={2}>
          {data.map((d, i) => <Cell key={i} fill={d.color} />)}
        </Pie>
        <Tooltip formatter={(v: any) => fmtUsd(Number(v))} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function ForecastChart({ data, projectedDaily }: { data: DailyPoint[]; projectedDaily: number }) {
  const rows = data.map((d) => ({ date: d.date, actual: Number(d.combinedCost.toFixed(6)), projected: null as number | null }));
  const last = rows[rows.length - 1];
  if (last && projectedDaily > 0) last.projected = Number(projectedDaily.toFixed(6));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#94a3b822" />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={30} tick={{ fontSize: 11 }} stroke="#94a3b8" />
        <YAxis tickFormatter={(v: number) => fmtUsd(v, 2)} tick={{ fontSize: 11 }} width={70} stroke="#94a3b8" />
        <Tooltip formatter={(v: any) => fmtUsd(Number(v))} contentStyle={tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line type="monotone" dataKey="actual" name="Daily actual cost" stroke={COMBINED} strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="projected" name="Projected pace (est.)" stroke="#f59e0b" strokeWidth={2} strokeDasharray="5 5" dot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
