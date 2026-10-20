import { chromium } from 'playwright-core';
import fs from 'fs';
const BASE = process.env.BASE || 'http://127.0.0.1:4174';
fs.mkdirSync('shots', { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
const ok = (m) => console.log('OK  ' + m); const fail = (m) => { console.log('FAIL ' + m); process.exitCode = 1; };
await p.goto(BASE + '/'); await p.waitForSelector('.kpis'); await p.waitForTimeout(2500);
const k = await p.locator('.kpis').innerText(); /\d+\.\d+%/.test(k) ? ok('KPIs ' + k.replace(/\s+/g, ' ').slice(0, 90)) : fail('kpis');
(await p.locator('table.banks tbody tr').count()) === 8 ? ok('8 bank rows') : fail('bank rows');
await p.screenshot({ path: 'shots/01-overview.png' });
// inject outage via keyboard on Data tab
await p.keyboard.press('5'); await p.selectOption('select[aria-label="Incident type"]', 'outage'); await p.selectOption('select[aria-label="Bank"]', 'HDFC');
await p.getByRole('button', { name: /^Inject/ }).click(); await p.waitForSelector('.banner'); ok('outage injected');
await p.selectOption('select[aria-label="Incident type"]', 'auth-burst'); await p.selectOption('select[aria-label="Bank"]', 'SBI'); await p.keyboard.press('i');
await p.screenshot({ path: 'shots/05-data.png' });
await p.waitForTimeout(12000);
await p.keyboard.press('3'); await p.waitForSelector('.timeline li', { timeout: 20000 });
const n = await p.locator('.timeline li').count(); ok(`${n} alerts: ` + (await p.locator('.timeline li strong').first().innerText()));
await p.getByRole('button', { name: 'Acknowledge' }).first().click();
await p.screenshot({ path: 'shots/03-incidents.png' });
await p.keyboard.press('4'); await p.waitForTimeout(500);
(await p.locator('.security table tbody tr').count()) ? ok('security finding shown') : fail('no security finding');
await p.screenshot({ path: 'shots/04-security.png' });
await p.keyboard.press('1'); await p.locator('table.banks tbody tr', { hasText: 'HDFC' }).click(); await p.waitForTimeout(1200);
await p.screenshot({ path: 'shots/02-overview-hdfc-drill.png' });
await p.keyboard.press('2'); await p.selectOption('select[aria-label="Status filter"]', 'TIMEOUT');
await p.locator('table.stream tbody tr').first().click(); await p.waitForSelector('.drawer'); ok('drawer ' + (await p.locator('.drawer h2').innerText()));
await p.screenshot({ path: 'shots/06-txn-drilldown.png' }); await p.keyboard.press('Escape');
// export + reimport round trip
await p.keyboard.press('5');
const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: /Export CSV/ }).click()]);
await dl.saveAs('/tmp/pp-export.csv'); ok('exported ' + fs.readFileSync('/tmp/pp-export.csv', 'utf8').split('\n').length + ' lines');
await p.setInputFiles('input[type=file]', '/tmp/pp-export.csv'); await p.waitForSelector('text=Imported:'); ok('re-imported CSV');
fs.writeFileSync('/tmp/bad.csv', 'foo,bar\n1,2'); await p.keyboard.press('5'); await p.setInputFiles('input[type=file]', '/tmp/bad.csv');
await p.waitForSelector('text=Map columns', { timeout: 8000 });
await p.getByRole('button', { name: /Analyse offline/i }).click();
await p.waitForSelector('.error'); ok('bad import error: ' + (await p.locator('.error').innerText()));
await p.reload(); await p.waitForSelector('nav'); await p.keyboard.press('3'); await p.waitForTimeout(300); (await p.locator('.timeline li').count()) >= n ? ok('alerts persisted after reload') : fail('persist');
// column mapping flow with alternate headers
await p.keyboard.press('5');
fs.writeFileSync('/tmp/pp-alt.csv', [
  'transaction_time,remitter bank,response_time,upi id,result,resp_code,amt',
  '2026-10-20T10:00:00+05:30,HDFC,420,ravi@oksbi,SUCCESS,00,199',
  '2026-10-20T10:00:01+05:30,SBI,3800,priya@ybl,FAILED,U30,499',
  '2026-10-20T10:00:02+05:30,HDFC,410,arun@okaxis,SUCCESS,00,99',
].join('\n'));
await p.setInputFiles('input[type=file]', '/tmp/pp-alt.csv');
const mapper = p.locator('text=Map columns');
try {
  await mapper.waitFor({ timeout: 4000 });
  ok('column mapper shown');
  await p.getByRole('button', { name: /Analyse offline/i }).click();
} catch {
  ok('auto-mapped (no mapper needed)');
}
await p.waitForSelector('text=Imported:', { timeout: 10000 });
ok('mapped import applied');
await p.keyboard.press('5');
await p.getByRole('button', { name: /Download \/ print report/i }).click();
ok('incident report button clicked');
await p.screenshot({ path: 'shots/08-own-data.png', fullPage: true });

const m = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true }); await m.goto(BASE + '/'); await m.waitForTimeout(2000); await m.screenshot({ path: 'shots/07-mobile.png', fullPage: true });
errs.length ? fail('console errors: ' + errs.join(' | ')) : ok('no console errors');
await b.close();
