import type { Mapping, TxnField } from './mapping';
import { autoDetect } from './mapping';
import type { Txn } from './sim';

export const BUCKET = 5000; // 5s buckets
export const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
export type BankStat = { bank: string; n: number; ok: number; sr: number; p50: number; p95: number; fails: Record<string, number> };
export function bankStats(txns: Txn[], banks: string[]): BankStat[] {
  return banks.map((bank) => {
    const t = txns.filter((x) => x.payerBank === bank);
    const ok = t.filter((x) => x.status === 'SUCCESS').length;
    const fails: Record<string, number> = {};
    t.forEach((x) => { if (x.status !== 'SUCCESS') fails[x.code] = (fails[x.code] || 0) + 1; });
    const lat = t.map((x) => x.latency);
    return { bank, n: t.length, ok, sr: t.length ? ok / t.length : 1, p50: pct(lat, 50), p95: pct(lat, 95), fails };
  });
}
export type Bucket = { t: number; n: number; sr: number; p95: number };
export function buckets(txns: Txn[], bank: string | null, end: number, count: number): Bucket[] {
  const start = Math.floor(end / BUCKET) * BUCKET - (count - 1) * BUCKET;
  const arr: { t: number; lat: number[]; ok: number; n: number }[] = Array.from({ length: count }, (_, i) => ({ t: start + i * BUCKET, lat: [], ok: 0, n: 0 }));
  for (const x of txns) {
    if (bank && x.payerBank !== bank) continue;
    const i = Math.floor((x.ts - start) / BUCKET); if (i < 0 || i >= count) continue;
    arr[i].n++; arr[i].lat.push(x.latency); if (x.status === 'SUCCESS') arr[i].ok++;
  }
  return arr.map((b) => ({ t: b.t, n: b.n, sr: b.n ? b.ok / b.n : NaN, p95: pct(b.lat, 95) }));
}
/** z-score of the last complete bucket against the previous `win` buckets */
export function zscore(series: number[], win = 24): number {
  const vals = series.filter((v) => !Number.isNaN(v));
  if (vals.length < 8) return 0;
  const last = vals[vals.length - 1]; const hist = vals.slice(-win - 1, -1);
  const mean = hist.reduce((s, v) => s + v, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((s, v) => s + (v - mean) ** 2, 0) / hist.length) || 1e-6;
  return (last - mean) / sd;
}
export type Finding = { key: string; kind: 'velocity' | 'auth-burst'; subject: string; count: number; bank: string; first: number; last: number };
export function securityScan(txns: Txn[], now: number, velocityN: number, authN: number): Finding[] {
  const recent = txns.filter((x) => now - x.ts <= 60000);
  const byVpa = new Map<string, Txn[]>(); const byDev = new Map<string, Txn[]>();
  for (const x of recent) {
    byVpa.set(x.vpa, [...(byVpa.get(x.vpa) || []), x]);
    if (x.code === 'ZM') byDev.set(x.device, [...(byDev.get(x.device) || []), x]);
  }
  const out: Finding[] = [];
  byVpa.forEach((v, k) => { if (v.length >= velocityN) out.push({ key: 'vel:' + k, kind: 'velocity', subject: k, count: v.length, bank: v[0].payerBank, first: v[0].ts, last: v[v.length - 1].ts }); });
  byDev.forEach((v, k) => { if (v.length >= authN) out.push({ key: 'auth:' + k, kind: 'auth-burst', subject: k, count: v.length, bank: v[0].payerBank, first: v[0].ts, last: v[v.length - 1].ts }); });
  return out.sort((a, b) => b.count - a.count);
}
const COLS = ['id', 'ts', 'psp', 'payerBank', 'payeeBank', 'vpa', 'device', 'amount', 'status', 'code', 'latency'] as const;
export function toCSV(t: Txn[]) {
  return [COLS.join(','), ...t.map((x) => COLS.map((c) => (c === 'ts' ? new Date(x.ts).toISOString() : String(x[c]))).join(','))].join('\n');
}

export function readCsvRows(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((s) => s.trim());
  const rows = lines.slice(1).filter(Boolean).map((l) => {
    const cells = l.split(',').map((v) => v.trim());
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  });
  return { headers, rows };
}

export function buildTxns(rows: Record<string, string>[], map: Mapping): Txn[] {
  const get = (r: Record<string, string>, k: TxnField) => (map[k] ? (r[map[k]!] ?? '').trim() : '');
  const out: Txn[] = [];
  rows.forEach((r, i) => {
    const tsRaw = get(r, 'ts');
    const ts = /^\d+$/.test(tsRaw) ? Number(tsRaw) : Date.parse(tsRaw);
    const latency = Number(get(r, 'latency'));
    const bank = get(r, 'payerBank');
    if (!Number.isFinite(ts) || !Number.isFinite(latency) || !bank) return;
    const statusRaw = (get(r, 'status') || 'SUCCESS').toUpperCase();
    const status: Txn['status'] =
      statusRaw.includes('TIMEOUT') || statusRaw === 'TO' ? 'TIMEOUT'
        : statusRaw.includes('FAIL') || statusRaw === 'DECLINED' || statusRaw === 'N' ? 'FAILED'
          : 'SUCCESS';
    out.push({
      id: get(r, 'id') || `IMP${i + 1}`,
      ts, psp: get(r, 'psp') || '—', payerBank: bank, payeeBank: get(r, 'payeeBank') || '—',
      vpa: get(r, 'vpa') || '—', device: get(r, 'device') || '—',
      amount: Number(get(r, 'amount') || 0) || 0,
      status, code: get(r, 'code') || (status === 'SUCCESS' ? '00' : 'U30'),
      latency,
      stages: { psp: Math.round(latency * 0.14), payer: Math.round(latency * 0.45), npci: Math.round(latency * 0.18), payee: Math.round(latency * 0.23) },
    });
  });
  if (!out.length) throw new Error('No valid rows after mapping (need timestamp, payer bank, latency)');
  return out.sort((a, b) => a.ts - b.ts);
}

/** Auto-detect columns for CSV/JSON (used by round-trip export and simple imports). */
export function parseLogs(text: string, name: string): Txn[] {
  if (name.endsWith('.json') || text.trim().startsWith('[')) {
    const rows = JSON.parse(text) as Record<string, unknown>[];
    if (!Array.isArray(rows) || !rows.length) throw new Error('No rows found');
    const headers = Object.keys(rows[0]);
    const strRows = rows.map((r) => Object.fromEntries(headers.map((h) => [h, String(r[h] ?? '')])));
    return buildTxns(strRows, autoDetect(headers));
  }
  const { headers, rows } = readCsvRows(text);
  if (!headers.length) throw new Error('No rows found');
  return buildTxns(rows, autoDetect(headers));
}

export type IncidentReportAlert = {
  id: string; title: string; detail: string; severity: string; bank: string;
  opened: number; lastSeen: number; state: string;
};

export function incidentReportHtml(alerts: IncidentReportAlert[], meta: { source: string; generatedAt: number }) {
  const rows = alerts.map((a) => `<tr class="${a.severity}">
    <td>${esc(a.id)}</td><td>${esc(a.severity)}</td><td>${esc(a.bank)}</td>
    <td>${esc(a.title)}</td><td>${esc(a.detail)}</td>
    <td>${new Date(a.opened).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
    <td>${esc(a.state)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"/><title>PayPulse incident report</title>
<style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#16201b}
h1{font-size:20px;margin:0 0 4px} .meta{color:#555;margin-bottom:16px}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#f3f0e8} tr.critical td:nth-child(2){color:#c2361f;font-weight:700}
@media print{button{display:none}}
</style></head><body>
<h1>PayPulse incident report</h1>
<div class="meta">${alerts.length} alerts · ${esc(meta.source)} · ${new Date(meta.generatedAt).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'})} IST
<button onclick="window.print()" style="margin-left:12px">Print</button></div>
<table><thead><tr><th>ID</th><th>Severity</th><th>Bank</th><th>Title</th><th>Detail</th><th>Opened</th><th>State</th></tr></thead>
<tbody>${rows || '<tr><td colspan="7">No alerts</td></tr>'}</tbody></table>
<p style="margin-top:16px;color:#666;font-size:12px">Generated offline in the browser. Not affiliated with any bank or NPCI.</p>
</body></html>`;
}
function esc(s: string) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
