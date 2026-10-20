# PayPulse: UPI journey observability

**Problem.** When a UPI payment fails, the cause can sit in the PSP app, the remitter bank, the NPCI switch or the beneficiary bank. Ops teams need to see, per bank and in near-real time, whether success rate or latency is drifting, why it is failing, and whether a spike looks technical or fraudulent.

PayPulse is a **browser-only** console. It starts on a synthetic live feed so you can poke around with no setup, then lets a small payments team point it at their own transaction CSV and run the same analysis offline.

> Independent portfolio project. Not affiliated with VuNet Systems, NPCI or any bank.

## Real use cases

- **On-call dry run** — inject a latency or outage incident on HDFC, watch z-score alerts fire, acknowledge them, print an incident report for the postmortem folder.
- **Bring your own logs** — export a CSV from your PSP / switch / bank portal, map `timestamp → payer bank → latency`, analyse offline. Column mappings are remembered for that header set.
- **Fraud desk triage** — tune velocity and failed-PIN thresholds, jump from a finding into the matching stream rows.
- **Standup share** — download / print the incident report (HTML) without a backend.

## Features

- Synthetic live UPI stream (8 banks, 5 apps, NPCI-style codes) as the **default**
- Per-bank success %, p50/p95, sparklines, drill-down chart
- Anomaly detection (rolling z-score) with configurable sensitivity, success-rate floor and p95 ceiling — **persisted in localStorage**
- Incident timeline (ack / resolve / reopen) + **downloadable HTML report**
- Security: velocity and failed-PIN burst rules with editable thresholds
- **Use your own data** flow: CSV/JSON import with column mapping, then the same analysis offline
- CSV/JSON export of the current window
- Keyboard: `1–5` · `Space` · `/` · `i` · `Esc`

## Tech

React 19 + TypeScript + Vite · hand-drawn SVG charts · no backend · Playwright verify (`scripts/verify.mjs`)

## Run

```bash
npm install
npm run dev
# or
npm run build && npx vite preview
```

Built by Mohammed Jeelan · github.com/MohammadJeelan
