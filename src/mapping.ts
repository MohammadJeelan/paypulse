/** Column mapping for real UPI / payment transaction logs. */
export type TxnField =
  | 'id' | 'ts' | 'psp' | 'payerBank' | 'payeeBank'
  | 'vpa' | 'device' | 'amount' | 'status' | 'code' | 'latency';

export interface FieldDef {
  key: TxnField;
  label: string;
  required?: boolean;
  synonyms: string[];
}

export const TXN_FIELDS: FieldDef[] = [
  { key: 'ts', label: 'Timestamp', required: true,
    synonyms: ['ts', 'timestamp', 'time', 'created_at', 'created at', 'txn_time', 'transaction time', 'date'] },
  { key: 'payerBank', label: 'Payer bank', required: true,
    synonyms: ['payerbank', 'payer_bank', 'payer bank', 'remitter bank', 'from bank', 'bank', 'issuer'] },
  { key: 'latency', label: 'Latency (ms)', required: true,
    synonyms: ['latency', 'latency_ms', 'latency ms', 'response_time', 'rtt', 'duration', 'elapsed_ms'] },
  { key: 'id', label: 'Txn ID',
    synonyms: ['id', 'txn_id', 'txn id', 'transaction_id', 'rrn', 'utr', 'reference'] },
  { key: 'psp', label: 'App / PSP',
    synonyms: ['psp', 'app', 'channel', 'source app', 'upi app'] },
  { key: 'payeeBank', label: 'Payee bank',
    synonyms: ['payeebank', 'payee_bank', 'payee bank', 'beneficiary bank', 'to bank', 'acquirer'] },
  { key: 'vpa', label: 'Payer VPA',
    synonyms: ['vpa', 'payer_vpa', 'payer vpa', 'upi id', 'virtual address'] },
  { key: 'device', label: 'Device ID',
    synonyms: ['device', 'device_id', 'device id', 'deviceid'] },
  { key: 'amount', label: 'Amount',
    synonyms: ['amount', 'amt', 'value', 'txn_amount'] },
  { key: 'status', label: 'Status',
    synonyms: ['status', 'result', 'outcome', 'txn_status'] },
  { key: 'code', label: 'Response code',
    synonyms: ['code', 'resp_code', 'response_code', 'npci_code', 'error_code'] },
];

export type Mapping = Partial<Record<TxnField, string>>;
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export function autoDetect(headers: string[]): Mapping {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const used = new Set<string>();
  const m: Mapping = {};
  for (const f of TXN_FIELDS) {
    for (const syn of f.synonyms) {
      const h = byNorm.get(norm(syn));
      if (h && !used.has(h)) { m[f.key] = h; used.add(h); break; }
    }
  }
  return m;
}

export function mappingProblems(m: Mapping): string[] {
  const p: string[] = [];
  for (const f of TXN_FIELDS) if (f.required && !m[f.key]) p.push(`Map a column for ${f.label}.`);
  return p;
}

const KEY = 'pp.mappings.v1';
export function headerSig(headers: string[]) { return headers.map(norm).sort().join('|'); }
export function loadSavedMapping(headers: string[]): Mapping | null {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Mapping>;
    return all[headerSig(headers)] ?? null;
  } catch { return null; }
}
export function saveMapping(headers: string[], m: Mapping) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, Mapping>;
    all[headerSig(headers)] = m;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* ignore */ }
}
