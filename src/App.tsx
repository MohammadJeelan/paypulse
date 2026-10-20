import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BANKS, CODES, INCIDENT_LABEL, randomVpa, tick, type IncidentKind, type Injected, type Txn } from './sim';
import { BUCKET, bankStats, buckets, buildTxns, incidentReportHtml, parseLogs, readCsvRows, securityScan, toCSV, zscore, type Bucket } from './analytics';
import { TXN_FIELDS, autoDetect, loadSavedMapping, mappingProblems, saveMapping, type Mapping } from './mapping';

type Alert = { id: string; key: string; title: string; detail: string; severity: 'critical' | 'warning'; bank: string; opened: number; lastSeen: number; state: 'open' | 'acked' | 'resolved'; note?: string };
type Settings = { zLimit: number; velocityN: number; authN: number; speed: number; srFloor: number; p95Ceil: number };
const TABS = ['Overview', 'Stream', 'Incidents', 'Security', 'Data'] as const;
type Tab = (typeof TABS)[number];
const KEEP_MS = 10 * 60 * 1000;
const load = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; } };
const fmtT = (t: number) => new Date(t).toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
const ms = (v: number) => (v >= 10000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);
const pctf = (v: number) => (Number.isNaN(v) ? '—' : `${(v * 100).toFixed(2)}%`);
const inr = (v: number) => '₹' + v.toLocaleString('en-IN');
function download(name: string, body: string, type: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([body], { type })); a.download = name; a.click(); URL.revokeObjectURL(a.href); }

function Spark({ data, field, w = 160, h = 34, warnBelow }: { data: Bucket[]; field: 'sr' | 'p95' | 'n'; w?: number; h?: number; warnBelow?: number }) {
  const vals = data.map((d) => d[field]).filter((v) => !Number.isNaN(v));
  if (vals.length < 2) return <svg width={w} height={h} className="spark" aria-hidden />;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const pts = data.map((d, i) => (Number.isNaN(d[field]) ? null : `${(i / (data.length - 1)) * w},${h - 3 - ((d[field] - lo) / span) * (h - 6)}`)).filter(Boolean).join(' ');
  const last = vals[vals.length - 1];
  const bad = warnBelow !== undefined && last < warnBelow;
  return <svg width={w} height={h} className={'spark' + (bad ? ' bad' : '')} aria-hidden><polyline points={pts} fill="none" strokeWidth="1.6" /></svg>;
}

function BigChart({ data }: { data: Bucket[] }) {
  const W = 720, H = 190, P = 28;
  const maxN = Math.max(1, ...data.map((d) => d.n));
  const srs = data.map((d) => d.sr).filter((v) => !Number.isNaN(v));
  const lo = Math.min(0.9, ...srs);
  const y = (v: number) => H - P - ((v - lo) / (1 - lo)) * (H - 2 * P);
  const bw = (W - P - 60) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="bigchart" role="img" aria-label="Volume and success rate, last 3 minutes">
      {data.map((d, i) => <rect key={i} x={P + i * bw + 1} y={H - P - (d.n / maxN) * (H - 2 * P) * 0.55} width={bw - 2} height={(d.n / maxN) * (H - 2 * P) * 0.55} className="vol" />)}
      {[1, (1 + lo) / 2, lo].map((v) => <g key={v}><line x1={P} x2={W - 60} y1={y(v)} y2={y(v)} className="grid" /><text x={W - 56} y={y(v) + 4} className="axis">{(v * 100).toFixed(1)}%</text></g>)}
      <polyline className="srline" fill="none" points={data.map((d, i) => (Number.isNaN(d.sr) ? '' : `${P + i * bw + bw / 2},${y(d.sr)}`)).join(' ')} />
      <text x={P} y={H - 8} className="axis">{data[0] && fmtT(data[0].t)}</text>
      <text x={W - 60} y={H - 8} textAnchor="end" className="axis">{data.length && fmtT(data[data.length - 1].t)}</text>
    </svg>
  );
}

function Mark() {
  return <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden><rect x="1" y="1" width="24" height="24" rx="6" fill="var(--ink)" /><path d="M4 14h4l2-6 3 11 2.5-8 1.5 3H22" stroke="var(--signal)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => (TABS.find((t) => '#' + t.toLowerCase() === location.hash) ?? 'Overview'));
  const [txns, setTxns] = useState<Txn[]>([]);
  const [now, setNow] = useState(Date.now());
  const [running, setRunning] = useState(true);
  const [source, setSource] = useState<'live' | 'import'>('live');
  const [importName, setImportName] = useState('');
  const [injected, setInjected] = useState<Injected[]>(() => load('pp.injected', []));
  const [alerts, setAlerts] = useState<Alert[]>(() => load('pp.alerts', []));
  const [settings, setSettings] = useState<Settings>(() => load('pp.settings', { zLimit: 3, velocityN: 8, authN: 4, speed: 1, srFloor: 0.95, p95Ceil: 3000 }));
  const [pendingImport, setPendingImport] = useState<{ headers: string[]; rows: Record<string, string>[]; name: string; mapping: Mapping } | null>(null);
  const [selBank, setSelBank] = useState<string | null>(null);
  const [selTxn, setSelTxn] = useState<Txn | null>(null);
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('all');
  const [toast, setToast] = useState('');
  const [err, setErr] = useState('');
  const [injKind, setInjKind] = useState<IncidentKind>('latency');
  const [injBank, setInjBank] = useState('HDFC');
  const [injMin, setInjMin] = useState(2);
  const injRef = useRef(injected); injRef.current = injected;
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => localStorage.setItem('pp.alerts', JSON.stringify(alerts.slice(0, 200))), [alerts]);
  useEffect(() => localStorage.setItem('pp.settings', JSON.stringify(settings)), [settings]);
  useEffect(() => localStorage.setItem('pp.injected', JSON.stringify(injected.slice(0, 50))), [injected]);
  useEffect(() => { history.replaceState(null, '', '#' + tab.toLowerCase()); }, [tab]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 2600); return () => clearTimeout(t); }, [toast]);

  // backfill 3 minutes so baselines exist on first paint
  useEffect(() => {
    const t0 = Date.now(); const out: Txn[] = [];
    for (let t = t0 - 180000; t < t0; t += 1000) out.push(...tick(t, 1000, []));
    setTxns(out); setNow(t0);
  }, []);

  useEffect(() => {
    if (!running || source !== 'live') return;
    const iv = setInterval(() => {
      const t = Date.now();
      setNow(t);
      const active = injRef.current.filter((i) => i.start <= t && i.end > t);
      const fresh = tick(t, 1000 * settings.speed, active);
      setTxns((prev) => { const next = prev.concat(fresh); const cut = t - KEEP_MS; let k = 0; while (k < next.length && next[k].ts < cut) k++; return k ? next.slice(k) : next; });
    }, 1000);
    return () => clearInterval(iv);
  }, [running, source, settings.speed]);

  const window5 = useMemo(() => txns.filter((x) => now - x.ts <= 5 * 60000), [txns, now]);
  const stats = useMemo(() => bankStats(window5, BANKS).filter((s) => s.n > 0 || source === 'live'), [window5, source]);
  const series = useMemo(() => Object.fromEntries(BANKS.map((b) => [b, buckets(txns, b, now - BUCKET, 36)])), [txns, now]);
  const overall = useMemo(() => buckets(txns, selBank, now - BUCKET, 36), [txns, now, selBank]);
  const findings = useMemo(() => securityScan(txns, now, settings.velocityN, settings.authN), [txns, now, settings.velocityN, settings.authN]);
  const tot = window5.length, okN = window5.filter((x) => x.status === 'SUCCESS').length;
  const p95all = useMemo(() => { const a = window5.map((x) => x.latency).sort((x, y) => x - y); return a[Math.floor(a.length * 0.95)] ?? 0; }, [window5]);
  const tps = useMemo(() => txns.filter((x) => now - x.ts <= 10000).length / 10, [txns, now]);

  // anomaly + security → alerts
  useEffect(() => {
    const raise: Omit<Alert, 'id' | 'opened' | 'lastSeen' | 'state'>[] = [];
    for (const b of BANKS) {
      const s = series[b]; if (!s) continue;
      const last = s[s.length - 1];
      const zs = zscore(s.map((x) => x.sr)), zl = zscore(s.map((x) => x.p95));
      if (last.n >= 5 && zs < -settings.zLimit && last.sr < settings.srFloor) raise.push({ key: `sr:${b}`, bank: b, severity: last.sr < 0.8 ? 'critical' : 'warning', title: `${b}: success rate dropped to ${pctf(last.sr)}`, detail: `z = ${zs.toFixed(1)} vs. trailing 2-min baseline · floor ${pctf(settings.srFloor)}` });
      if (last.n >= 3 && zl > settings.zLimit) raise.push({ key: `lat:${b}`, bank: b, severity: last.p95 > settings.p95Ceil ? 'critical' : 'warning', title: `${b}: p95 latency spiked to ${ms(last.p95)}`, detail: `z = ${zl.toFixed(1)} vs. trailing 2-min baseline · ceiling ${ms(settings.p95Ceil)}` });
    }
    for (const f of findings) raise.push({ key: f.key, bank: f.bank, severity: 'critical', title: f.kind === 'velocity' ? `Velocity: ${f.subject} made ${f.count} payments in 60s` : `Failed-PIN burst: ${f.count} ZM declines from ${f.subject}`, detail: f.kind === 'velocity' ? `Threshold ${settings.velocityN}/min · payer bank ${f.bank}` : `Threshold ${settings.authN}/min · possible PIN guessing` });
    if (!raise.length) return;
    setAlerts((prev) => {
      let next = prev, changed = false;
      for (const r of raise) {
        const i = next.findIndex((a) => a.key === r.key && a.state !== 'resolved');
        if (i >= 0) { if (now - next[i].lastSeen > 4000) { next = next.map((a, j) => (j === i ? { ...a, lastSeen: now, title: r.title, detail: r.detail } : a)); changed = true; } }
        else { next = [{ ...r, id: `AL-${now.toString(36).toUpperCase().slice(-5)}${next.length}`, opened: now, lastSeen: now, state: 'open' }, ...next]; changed = true; }
      }
      return changed ? next : prev;
    });
  }, [series, findings, now, settings.zLimit, settings.velocityN, settings.authN]);

  const openAlerts = alerts.filter((a) => a.state === 'open').length;
  const inject = useCallback(() => {
    const t = Date.now();
    const inc: Injected = { id: 'INC' + t.toString(36).toUpperCase().slice(-4), kind: injKind, bank: injBank, vpa: injKind === 'auth-burst' || injKind === 'velocity' ? randomVpa() : undefined, start: t, end: t + injMin * 60000 };
    setInjected((p) => [inc, ...p]);
    if (source !== 'live') { setSource('live'); setTxns([]); }
    setRunning(true);
    setToast(`Injected: ${INCIDENT_LABEL[injKind]} on ${injBank} for ${injMin} min`);
  }, [injKind, injBank, injMin, source]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.key === 'Escape') { setSelTxn(null); (e.target as HTMLElement).blur?.(); return; }
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (/^[1-5]$/.test(e.key)) setTab(TABS[+e.key - 1]);
      else if (e.key === ' ') { e.preventDefault(); setRunning((r) => !r); }
      else if (e.key === '/') { e.preventDefault(); setTab('Stream'); setTimeout(() => searchRef.current?.focus(), 0); }
      else if (e.key === 'i') inject();
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [inject]);

  const streamRows = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const r: Txn[] = [];
    for (let i = txns.length - 1; i >= 0 && r.length < 200; i--) {
      const x = txns[i];
      if (statusF !== 'all' && x.status !== statusF) continue;
      if (selBank && x.payerBank !== selBank) continue;
      if (ql && !`${x.id} ${x.vpa} ${x.payerBank} ${x.psp} ${x.code} ${x.device}`.toLowerCase().includes(ql)) continue;
      r.push(x);
    }
    return r;
  }, [txns, q, statusF, selBank]);

  async function onImport(f: File) {
    setErr('');
    setPendingImport(null);
    try {
      const text = await f.text();
      if (f.name.endsWith('.json') || text.trim().startsWith('[')) {
        const rows = parseLogs(text, f.name);
        applyImport(rows, f.name);
        return;
      }
      const { headers, rows } = readCsvRows(text);
      if (!headers.length) throw new Error('No rows found');
      const mapping = loadSavedMapping(headers) || autoDetect(headers);
      if (mappingProblems(mapping).length === 0) {
        const built = buildTxns(rows, mapping);
        saveMapping(headers, mapping);
        applyImport(built, f.name);
        return;
      }
      setPendingImport({ headers, rows, name: f.name, mapping });
      setTab('Data');
    } catch (e) { setErr(`Couldn't import ${f.name}: ${(e as Error).message}`); }
  }
  function applyImport(rows: Txn[], name: string) {
    setSource('import'); setRunning(false); setImportName(name); setTxns(rows); setNow(rows[rows.length - 1].ts + BUCKET);
    setToast(`Imported ${rows.length.toLocaleString('en-IN')} transactions from ${name}`); setTab('Overview'); setPendingImport(null);
  }
  function confirmMappedImport() {
    if (!pendingImport) return;
    const problems = mappingProblems(pendingImport.mapping);
    if (problems.length) { setErr(problems.join(' ')); return; }
    try {
      const rows = buildTxns(pendingImport.rows, pendingImport.mapping);
      saveMapping(pendingImport.headers, pendingImport.mapping);
      applyImport(rows, pendingImport.name);
    } catch (e) { setErr((e as Error).message); }
  }
  function openIncidentReport() {
    const html = incidentReportHtml(alerts, {
      source: source === 'live' ? 'synthetic live feed' : `imported · ${importName}`,
      generatedAt: Date.now(),
    });
    const w = window.open('', '_blank');
    if (!w) { download(`paypulse-incidents-${Date.now()}.html`, html, 'text/html'); return; }
    w.document.write(html); w.document.close();
  }
  const setAlert = (id: string, state: Alert['state']) => setAlerts((p) => p.map((a) => (a.id === id ? { ...a, state } : a)));
  const activeInc = injected.filter((i) => i.start <= now && i.end > now);

  return (
    <div className="shell">
      <header className="top">
        <div className="brand"><Mark /><span>PayPulse</span><em>UPI journey observability</em></div>
        <nav role="tablist" aria-label="Sections">
          {TABS.map((t, i) => <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}{t === 'Incidents' && openAlerts > 0 && <b className="count">{openAlerts}</b>}<kbd>{i + 1}</kbd></button>)}
        </nav>
        <div className="live">
          {source === 'live' ? <button className={'pill ' + (running ? 'run' : 'pause')} onClick={() => setRunning((r) => !r)} title="Space">{running ? '● Live' : '❚❚ Paused'}</button>
            : <button className="pill pause" onClick={() => { setSource('live'); setTxns([]); setRunning(true); setNow(Date.now()); }}>Imported: {importName} · back to live</button>}
          <span className="clock">{fmtT(now)} IST</span>
        </div>
      </header>

      {activeInc.length > 0 && <div className="banner">Simulated incident running: {activeInc.map((i) => `${INCIDENT_LABEL[i.kind]} · ${i.bank} · ends ${fmtT(i.end)}`).join('  /  ')} <button onClick={() => setInjected((p) => p.map((i) => (i.end > now ? { ...i, end: now } : i)))}>Stop</button></div>}

      <main>
        {tab === 'Overview' && <section className="overview">
          <div className="kpis">
            <div><label>Success rate · 5m</label><strong className={okN / (tot || 1) < 0.95 ? 'bad' : ''}>{tot ? pctf(okN / tot) : '—'}</strong><small>{okN.toLocaleString('en-IN')} / {tot.toLocaleString('en-IN')} txns</small></div>
            <div><label>p95 latency · 5m</label><strong>{tot ? ms(p95all) : '—'}</strong><small>end-to-end, payer app → payee bank</small></div>
            <div><label>Throughput</label><strong>{tps.toFixed(1)}<i>/s</i></strong><small>{source === 'live' ? 'simulated live feed' : 'from imported log'}</small></div>
            <div><label>Open alerts</label><strong className={openAlerts ? 'bad' : ''}>{openAlerts}</strong><small><a href="#incidents" onClick={(e) => { e.preventDefault(); setTab('Incidents'); }}>review incidents →</a></small></div>
          </div>
          <div className="panel chartpanel">
            <div className="ph"><h2>{selBank ?? 'All banks'} · volume & success rate</h2><span className="muted">5-second buckets, last 3 minutes</span>{selBank && <button className="ghost" onClick={() => setSelBank(null)}>Clear filter ✕</button>}</div>
            {txns.length ? <BigChart data={overall} /> : <div className="empty">Waiting for the first transactions…</div>}
          </div>
          <div className="panel">
            <div className="ph"><h2>Payer banks</h2><span className="muted">Click a row to filter the chart and stream</span></div>
            <div className="tablewrap"><table className="banks">
              <thead><tr><th>Bank</th><th className="r">Txns</th><th className="r">Success</th><th>Trend</th><th className="r">p50</th><th className="r">p95</th><th>p95 trend</th><th>Top failure</th></tr></thead>
              <tbody>{stats.map((s) => {
                const top = Object.entries(s.fails).sort((a, b) => b[1] - a[1])[0];
                return <tr key={s.bank} tabIndex={0} className={selBank === s.bank ? 'sel' : ''} onClick={() => setSelBank(selBank === s.bank ? null : s.bank)} onKeyDown={(e) => e.key === 'Enter' && setSelBank(selBank === s.bank ? null : s.bank)}>
                  <td className="bk">{s.bank}</td><td className="r num">{s.n}</td><td className={'r num ' + (s.sr < 0.95 ? 'badt' : '')}>{pctf(s.sr)}</td>
                  <td><Spark data={series[s.bank]} field="sr" warnBelow={0.95} w={110} /></td><td className="r num">{ms(s.p50)}</td><td className="r num">{ms(s.p95)}</td>
                  <td><Spark data={series[s.bank]} field="p95" w={110} /></td><td className="muted">{top ? `${top[0]} · ${CODES[top[0]] ?? ''} (${top[1]})` : '—'}</td></tr>;
              })}</tbody></table></div>
          </div>
        </section>}

        {tab === 'Stream' && <section className="panel">
          <div className="ph wrap"><h2>Transaction stream</h2>
            <input ref={searchRef} className="search" placeholder="Search id, VPA, bank, code, device  ( / )" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search transactions" />
            <select value={statusF} onChange={(e) => setStatusF(e.target.value)} aria-label="Status filter"><option value="all">All statuses</option><option>SUCCESS</option><option>FAILED</option><option>TIMEOUT</option></select>
            <select value={selBank ?? ''} onChange={(e) => setSelBank(e.target.value || null)} aria-label="Bank filter"><option value="">All banks</option>{BANKS.map((b) => <option key={b}>{b}</option>)}</select>
            <span className="muted">newest 200 shown</span></div>
          {streamRows.length === 0 ? <div className="empty">No transactions match these filters. <button className="ghost" onClick={() => { setQ(''); setStatusF('all'); setSelBank(null); }}>Reset filters</button></div> :
            <div className="tablewrap"><table className="stream"><thead><tr><th>Time</th><th>Txn ID</th><th>App</th><th>Payer → Payee</th><th>VPA</th><th className="r">Amount</th><th className="r">Latency</th><th>Result</th></tr></thead>
              <tbody>{streamRows.map((x) => <tr key={x.id} tabIndex={0} onClick={() => setSelTxn(x)} onKeyDown={(e) => e.key === 'Enter' && setSelTxn(x)}>
                <td className="num">{fmtT(x.ts)}</td><td className="num">{x.id}</td><td>{x.psp}</td><td>{x.payerBank} → {x.payeeBank}</td><td className="num muted">{x.vpa}</td><td className="r num">{inr(x.amount)}</td><td className="r num">{ms(x.latency)}</td>
                <td><span className={'st ' + x.status.toLowerCase()}>{x.status === 'SUCCESS' ? 'OK' : x.code}</span></td></tr>)}</tbody></table></div>}
        </section>}

        {tab === 'Incidents' && <section className="incidents">
          <div className="panel">
            <div className="ph"><h2>Incident timeline</h2><span className="muted">{alerts.length} total · saved in this browser</span>
              {alerts.some((a) => a.state === 'resolved') && <button className="ghost" onClick={() => setAlerts((p) => p.filter((a) => a.state !== 'resolved'))}>Clear resolved</button>}</div>
            {alerts.length === 0 ? <div className="empty">No anomalies yet. The detector compares each bank's latest 5-second bucket against its trailing 2 minutes (|z| &gt; {settings.zLimit}).<br />Try <button className="link" onClick={() => setTab('Data')}>injecting an incident</button> or press <kbd>i</kbd>.</div> :
              <ol className="timeline">{alerts.map((a) => <li key={a.id} className={`${a.severity} ${a.state}`}>
                <div className="when num">{fmtT(a.opened)}<small>last seen {fmtT(a.lastSeen)}</small></div>
                <div className="what"><strong>{a.title}</strong><span>{a.detail}</span><span className="tag">{a.id} · {a.state}</span></div>
                <div className="acts">
                  <button className="ghost" onClick={() => { setSelBank(a.bank); setTab('Overview'); }}>Drill into {a.bank}</button>
                  {a.state === 'open' && <button onClick={() => setAlert(a.id, 'acked')}>Acknowledge</button>}
                  {a.state !== 'resolved' && <button onClick={() => setAlert(a.id, 'resolved')}>Resolve</button>}
                  {a.state === 'resolved' && <button className="ghost" onClick={() => setAlert(a.id, 'open')}>Reopen</button>}
                </div></li>)}</ol>}
          </div>
        </section>}

        {tab === 'Security' && <section className="security">
          <div className="panel rules">
            <h2>Detection rules</h2>
            <label>Velocity: flag a VPA with ≥ <input type="number" min={2} max={50} value={settings.velocityN} onChange={(e) => setSettings({ ...settings, velocityN: Math.max(2, +e.target.value || 2) })} /> payments in 60 s</label>
            <label>Failed-PIN burst: flag a device with ≥ <input type="number" min={2} max={50} value={settings.authN} onChange={(e) => setSettings({ ...settings, authN: Math.max(2, +e.target.value || 2) })} /> ZM declines in 60 s</label>
            <label>Anomaly sensitivity: |z| &gt; <input type="number" step={0.5} min={1.5} max={6} value={settings.zLimit} onChange={(e) => setSettings({ ...settings, zLimit: Math.min(6, Math.max(1.5, +e.target.value || 3)) })} /></label>
            <label>Success-rate floor: alert when SR &lt; <input type="number" step={0.01} min={0.5} max={0.99} value={settings.srFloor} onChange={(e) => setSettings({ ...settings, srFloor: Math.min(0.99, Math.max(0.5, +e.target.value || 0.95)) })} /></label>
            <label>p95 latency ceiling (ms): critical when above <input type="number" step={100} min={500} max={30000} value={settings.p95Ceil} onChange={(e) => setSettings({ ...settings, p95Ceil: Math.min(30000, Math.max(500, +e.target.value || 3000)) })} /></label>
            <p className="muted">Thresholds are saved in this browser and apply to both the synthetic feed and imported logs.</p>
          </div>
          <div className="panel">
            <div className="ph"><h2>Suspicious activity · last 60 s</h2></div>
            {findings.length === 0 ? <div className="empty">Nothing suspicious right now. Inject a “Failed-PIN burst” or “Velocity spike” from the Data tab to see this fire.</div> :
              <table className="stream"><thead><tr><th>Pattern</th><th>Subject</th><th>Bank</th><th className="r">Count</th><th>Window</th><th /></tr></thead>
                <tbody>{findings.map((f) => <tr key={f.key}><td><span className="st failed">{f.kind === 'velocity' ? 'VELOCITY' : 'PIN BURST'}</span></td><td className="num">{f.subject}</td><td>{f.bank}</td><td className="r num">{f.count}</td><td className="num muted">{fmtT(f.first)}–{fmtT(f.last)}</td>
                  <td><button className="ghost" onClick={() => { setQ(f.subject); setStatusF('all'); setSelBank(null); setTab('Stream'); }}>View txns</button></td></tr>)}</tbody></table>}
          </div>
        </section>}

        {tab === 'Data' && <section className="data">
          <div className="panel">
            <h2>Inject a simulated incident</h2>
            <p className="muted">Runs on the synthetic feed only. Watch the Overview and Incidents tabs react.</p>
            <div className="row">
              <select value={injKind} onChange={(e) => setInjKind(e.target.value as IncidentKind)} aria-label="Incident type">{Object.entries(INCIDENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <select value={injBank} onChange={(e) => setInjBank(e.target.value)} aria-label="Bank">{BANKS.map((b) => <option key={b}>{b}</option>)}</select>
              <select value={injMin} onChange={(e) => setInjMin(+e.target.value)} aria-label="Duration"><option value={1}>1 min</option><option value={2}>2 min</option><option value={5}>5 min</option></select>
              <button className="primary" onClick={inject}>Inject <kbd>i</kbd></button>
            </div>
            {injected.length > 0 && <ul className="history">{injected.slice(0, 6).map((i) => <li key={i.id}><span className="num">{fmtT(i.start)}</span> {INCIDENT_LABEL[i.kind]} · {i.bank}{i.vpa ? ` · ${i.vpa}` : ''} <span className="muted">{i.end > now ? 'running' : 'ended'}</span></li>)}</ul>}
          </div>
          <div className="panel">
            <h2>Use your own data</h2>
            <p className="muted">Default is the synthetic live feed. Import a real transaction CSV, map columns once, then run the same anomaly + security analysis offline. Files never leave this browser.</p>
            <div className="row">
              <button className="primary" onClick={() => fileRef.current?.click()}>Import CSV / JSON…</button>
              <input ref={fileRef} type="file" accept=".csv,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImport(f); e.target.value = ''; }} />
              <button disabled={!txns.length} onClick={() => download(`paypulse-${Date.now()}.csv`, toCSV(txns), 'text/csv')}>Export CSV ({txns.length.toLocaleString('en-IN')})</button>
              <button disabled={!txns.length} onClick={() => download(`paypulse-${Date.now()}.json`, JSON.stringify(txns), 'application/json')}>Export JSON</button>
            </div>
            {pendingImport && (
              <div className="mapper" style={{ marginTop: 14 }}>
                <h3>Map columns · {pendingImport.name}</h3>
                <p className="muted">{pendingImport.rows.length} rows · required: timestamp, payer bank, latency (ms)</p>
                <div className="mapper-grid">
                  {TXN_FIELDS.map((f) => (
                    <label key={f.key}>
                      <span>{f.label}{f.required ? ' *' : ''}</span>
                      <select
                        aria-label={`Map ${f.label}`}
                        value={pendingImport.mapping[f.key] || ''}
                        onChange={(e) => {
                          const mapping = { ...pendingImport.mapping };
                          if (!e.target.value) delete mapping[f.key]; else mapping[f.key] = e.target.value;
                          setPendingImport({ ...pendingImport, mapping });
                        }}
                      >
                        <option value="">— skip —</option>
                        {pendingImport.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <div className="row">
                  <button className="primary" onClick={confirmMappedImport}>Analyse offline</button>
                  <button className="ghost" onClick={() => setPendingImport(null)}>Cancel</button>
                </div>
              </div>
            )}
            {err && <p className="error" role="alert">{err}</p>}
            <h3>Incident report</h3>
            <div className="row">
              <button disabled={!alerts.length} onClick={openIncidentReport}>Download / print report</button>
              <button disabled={!alerts.length} onClick={() => download('paypulse-incidents.json', JSON.stringify(alerts, null, 1), 'application/json')}>Export incidents JSON</button>
            </div>
            <h3>Feed speed (synthetic only)</h3>
            <div className="row">{[1, 2, 4].map((s) => <button key={s} className={settings.speed === s ? 'primary' : ''} onClick={() => setSettings({ ...settings, speed: s })}>{s}× volume</button>)}
              <button className="ghost" onClick={() => { if (confirm('Clear saved alerts, incidents and settings?')) { localStorage.clear(); setAlerts([]); setInjected([]); setSettings({ zLimit: 3, velocityN: 8, authN: 4, speed: 1, srFloor: 0.95, p95Ceil: 3000 }); setPendingImport(null); } }}>Reset saved data</button></div>
          </div>
          <div className="panel keys"><h2>Keyboard</h2><dl><dt>1–5</dt><dd>switch section</dd><dt>Space</dt><dd>pause / resume feed</dd><dt>/</dt><dd>search stream</dd><dt>i</dt><dd>inject selected incident</dd><dt>Esc</dt><dd>close drawer</dd></dl></div>
        </section>}
      </main>

      {selTxn && <div className="scrim" onClick={() => setSelTxn(null)}>
        <aside className="drawer" role="dialog" aria-label={`Transaction ${selTxn.id}`} onClick={(e) => e.stopPropagation()}>
          <div className="ph"><h2 className="num">{selTxn.id}</h2><button className="ghost" onClick={() => setSelTxn(null)} aria-label="Close">✕</button></div>
          <p><span className={'st ' + selTxn.status.toLowerCase()}>{selTxn.status}</span> {selTxn.code} · {CODES[selTxn.code] ?? 'Unknown code'}</p>
          <dl className="facts"><dt>Time</dt><dd>{new Date(selTxn.ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</dd><dt>Amount</dt><dd>{inr(selTxn.amount)}</dd><dt>Payer VPA</dt><dd>{selTxn.vpa}</dd><dt>Device</dt><dd>{selTxn.device}</dd><dt>App</dt><dd>{selTxn.psp}</dd></dl>
          <h3>Journey · {ms(selTxn.latency)}</h3>
          <ol className="journey">{([['PSP app', 'psp', selTxn.psp], ['Remitter bank (debit)', 'payer', selTxn.payerBank], ['NPCI switch', 'npci', 'UPI'], ['Beneficiary bank (credit)', 'payee', selTxn.payeeBank]] as const).map(([l, k, who]) =>
            <li key={k}><span>{l}<small>{who}</small></span><div className="bar"><i style={{ width: `${(selTxn.stages[k] / selTxn.latency) * 100}%` }} /></div><b className="num">{ms(selTxn.stages[k])}</b></li>)}</ol>
          <div className="row"><button onClick={() => { setQ(selTxn.vpa); setSelTxn(null); }}>All txns from this VPA</button><button className="ghost" onClick={() => { navigator.clipboard?.writeText(JSON.stringify(selTxn, null, 1)); setToast('Copied transaction JSON'); }}>Copy JSON</button></div>
        </aside></div>}

      {toast && <div className="toast" role="status">{toast}</div>}
      <footer><span>Built by Mohammed Jeelan · <a href="https://github.com/MohammadJeelan" target="_blank" rel="noreferrer">github.com/MohammadJeelan</a></span><span>Synthetic by default · import your own logs · not affiliated with VuNet Systems, NPCI or any bank.</span></footer>
    </div>
  );
}
