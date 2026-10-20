export type Txn = {
  id: string; ts: number; psp: string; payerBank: string; payeeBank: string;
  vpa: string; device: string; amount: number; status: 'SUCCESS' | 'FAILED' | 'TIMEOUT';
  code: string; latency: number; stages: { psp: number; payer: number; npci: number; payee: number };
};
export const BANKS = ['SBI', 'HDFC', 'ICICI', 'Axis', 'Kotak', 'PNB', 'BoB', 'Canara'];
export const PSPS = ['PhonePe', 'Google Pay', 'Paytm', 'BHIM', 'CRED'];
export const CODES: Record<string, string> = {
  '00': 'Approved', U30: 'Debit failed at remitter bank', U68: 'Debit timeout', BT: 'Bank timeout (ACQ)',
  ZM: 'Invalid UPI PIN', Z9: 'Insufficient funds', U16: 'Risk threshold exceeded', U69: 'Collect request expired', XH: 'Account blocked/frozen',
};
export type IncidentKind = 'latency' | 'outage' | 'auth-burst' | 'velocity';
export type Injected = { id: string; kind: IncidentKind; bank?: string; vpa?: string; start: number; end: number };
export const INCIDENT_LABEL: Record<IncidentKind, string> = {
  latency: 'Latency degradation', outage: 'Partial outage (timeouts)', 'auth-burst': 'Failed-PIN burst', velocity: 'Velocity spike from one VPA',
};
const BASE_LAT: Record<string, number> = { SBI: 420, HDFC: 260, ICICI: 240, Axis: 300, Kotak: 230, PNB: 520, BoB: 470, Canara: 450 };
const WEIGHT = [30, 18, 16, 10, 8, 7, 6, 5];
const NAMES = ['ravi', 'priya', 'arun', 'meena', 'karthik', 'divya', 'sanjay', 'anitha', 'vijay', 'lakshmi', 'rahul', 'sneha', 'imran', 'fathima', 'suresh', 'deepa'];
const HANDLES = ['okaxis', 'oksbi', 'ybl', 'paytm', 'okhdfcbank', 'okicici', 'ibl', 'axl'];
let seq = 0;
const r = Math.random;
const pickW = <T,>(a: T[], w: number[]) => { let x = r() * w.reduce((s, v) => s + v, 0); for (let i = 0; i < a.length; i++) { x -= w[i]; if (x <= 0) return a[i]; } return a[a.length - 1]; };
const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
const logn = (m: number, s = 0.45) => m * Math.exp(s * Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()));
export const randomVpa = () => `${pick(NAMES)}${Math.floor(r() * 900 + 100)}@${pick(HANDLES)}`;

export function makeTxn(ts: number, active: Injected[], forced?: Partial<Txn>): Txn {
  const payerBank = forced?.payerBank ?? pickW(BANKS, WEIGHT);
  const payeeBank = pickW(BANKS, WEIGHT);
  let lat = logn(BASE_LAT[payerBank]);
  let status: Txn['status'] = 'SUCCESS', code = '00';
  const roll = r();
  if (roll < 0.012) { status = 'FAILED'; code = 'Z9'; } else if (roll < 0.02) { status = 'FAILED'; code = 'ZM'; }
  else if (roll < 0.026) { status = 'FAILED'; code = 'U30'; } else if (roll < 0.03) { status = 'TIMEOUT'; code = 'BT'; lat = 30000 + r() * 2000; }
  for (const inc of active) {
    if (inc.bank && inc.bank !== payerBank) continue;
    if (inc.kind === 'latency') lat *= 3.5 + r() * 2;
    if (inc.kind === 'outage' && r() < 0.45) { status = 'TIMEOUT'; code = pick(['U68', 'BT']); lat = 30000 + r() * 5000; }
  }
  const amount = Math.round(r() < 0.7 ? logn(240, 0.9) : logn(2400, 1));
  const split = [0.12 + r() * 0.05, 0.45, 0.18, 0];
  split[3] = 1 - split[0] - split[1] - split[2];
  const t: Txn = {
    id: `${Math.floor(ts).toString(36).toUpperCase()}${(++seq).toString(36).toUpperCase().padStart(4, '0')}`,
    ts: Math.floor(ts), psp: pickW(PSPS, [46, 36, 10, 4, 4]), payerBank, payeeBank, vpa: randomVpa(),
    device: 'DV-' + Math.floor(r() * 1e6).toString(16).toUpperCase(), amount: Math.max(1, amount), status, code,
    latency: Math.round(lat), stages: { psp: 0, payer: 0, npci: 0, payee: 0 },
  };
  Object.assign(t, forced);
  t.stages = { psp: Math.round(t.latency * split[0]), payer: Math.round(t.latency * split[1]), npci: Math.round(t.latency * split[2]), payee: Math.round(t.latency * split[3]) };
  return t;
}

/** Generates the transactions for one tick of `ms` milliseconds ending at `now`. */
export function tick(now: number, ms: number, active: Injected[]): Txn[] {
  const hour = new Date(now).getHours();
  const diurnal = 0.6 + 0.4 * Math.sin(((hour - 6) / 24) * Math.PI * 2) ** 2;
  const n = Math.round((ms / 1000) * 14 * diurnal * (0.8 + r() * 0.4));
  const out: Txn[] = [];
  for (let i = 0; i < n; i++) out.push(makeTxn(now - ms + r() * ms, active));
  for (const inc of active) {
    if (inc.kind === 'auth-burst') {
      const k = 1 + Math.floor(r() * 3);
      for (let i = 0; i < k; i++) out.push(makeTxn(now - r() * ms, [], { vpa: inc.vpa, device: 'DV-7F3A21', payerBank: inc.bank, status: 'FAILED', code: 'ZM' }));
    }
    if (inc.kind === 'velocity') {
      const k = 2 + Math.floor(r() * 4);
      for (let i = 0; i < k; i++) out.push(makeTxn(now - r() * ms, [], { vpa: inc.vpa, payerBank: inc.bank, amount: 1999 + Math.floor(r() * 3) * 1000 }));
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}
