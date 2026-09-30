import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { ghostPlanExample } from '../dist/examples/schema-examples.js';
import { authorizeLocalRun, assertLocalRunAllowed, applyLocalBrowserBoundary, localOrigin, resetLocalTarget } from '../dist/local-boundary.js';
const listen = async server => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; };
const close = async server => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };

test('local authorization binds the plan, target, reset, zero budget and strict caps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ghost-local-gate-'));
  try {
    await mkdir(join(root, '.ghost/plan'), { recursive: true });
    const path = join(root, '.ghost/plan/ghost-invasion-plan.json');
    let plan = structuredClone(ghostPlanExample);
    plan.personas[0].role = { name: 'visitor', authStrategy: 'none', stateRef: null };
    plan.swarm.apiTier.enabled = false;
    await writeFile(path, JSON.stringify(plan));
    const authInput = { projectRoot: root, resetPath: '/reset', confirmDisposable: true, maxSessions: 2, maxWorkers: 1 };
    const gate = (changes = {}) => assertLocalRunAllowed({ projectRoot: root, loadedPlan: plan, effectivePlan: plan, baseUrl: plan.target.baseUrl, sessions: 2, workers: 1, reproductionBudget: 0, budgetUsd: 0, env: {}, ...changes });
    await assert.rejects(gate(), /authorize-local/);
    await assert.rejects(authorizeLocalRun({ ...authInput, confirmDisposable: false }), /explicit confirmation/);
    await assert.rejects(authorizeLocalRun({ ...authInput, resetPath: '//example.com/reset' }), /outside/);
    await assert.rejects(authorizeLocalRun({ ...authInput, maxSessions: 21 }), /caps/);
    for (const value of ['https://127.0.0.1:42', 'http://localhost:42', 'http://user@127.0.0.1:42', 'http://192.168.0.1']) assert.throws(() => localOrigin(value), /127.0.0.1/);
    await authorizeLocalRun(authInput);
    plan = JSON.parse(await readFile(path, 'utf8'));
    const allowed = await gate();
    assert.equal(allowed.authorization.boundary, 'browser-origin');
    assert.equal(allowed.verdict.egress.proven, false);
    for (const [changes, pattern] of [
      [{ loadedPlan: { ...plan, seed: 99 } }, /approved plan/],
      [{ baseUrl: 'http://127.0.0.1:5174' }, /target differs/],
      [{ budgetUsd: 0.01 }, /budget 0/], [{ budgetUsd: undefined }, /budget 0/],
      [{ sessions: 3 }, /limit/], [{ workers: 2 }, /limit/], [{ sessions: NaN }, /limit/],
      [{ reproductionBudget: 1 }, /reproduction/], [{ runReset: false }, /resets on/],
      [{ effectivePlan: { ...plan, mode: 'payments' } }, /quick mode/],
      [{ effectivePlan: { ...plan, pack: 'changed' } }, /approved pack/],
      [{ effectivePlan: { ...plan, swarm: { ...plan.swarm, apiTier: { ...plan.swarm.apiTier, enabled: true } } } }, /API volume/],
      [{ effectivePlan: { ...plan, personas: [{ ...plan.personas[0], role: { name: 'admin', authStrategy: 'seeded-storage-state', stateRef: 'secret.json' } }] } }, /stored authentication/],
      [{ effectivePlan: { ...plan, journeys: [{ ...plan.journeys[0], steps: [{ type: 'goto', url: 'http://example.com' }] }] } }, /outside/],
      [{ effectivePlan: { ...plan, journeys: [{ ...plan.journeys[0], steps: [{ type: 'upload', files: ['/private/file'] }] }] } }, /uploads/],
      [{ env: { STRIPE_SECRET_KEY: 'sk_live_fixture_value_only' } }, /credentials/],
    ]) await assert.rejects(gate(changes), pattern);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Chromium denies cross-origin HTTP, redirects and WebSockets; same-origin works and service workers stay blocked', async () => {
  let outsideHttp = 0; let outsideWs = 0; let workerRequests = 0; let resets = 0;
  const sink = http.createServer((req, res) => { outsideHttp++; res.writeHead(200, { 'Access-Control-Allow-Origin': '*' }); res.end('outside'); });
  sink.on('upgrade', (req, socket) => { outsideWs++; socket.destroy(); });
  const sinkUrl = await listen(sink);
  const app = http.createServer((req, res) => {
    if (req.url === '/redirect' || req.url === '/reset-redirect') { res.writeHead(302, { location: sinkUrl + '/escaped' }); res.end(); return; }
    if (req.url === '/reset') resets++;
    if (req.url === '/sw.js') workerRequests++;
    res.writeHead(200, { 'content-type': req.url === '/sw.js' ? 'application/javascript' : 'text/html' });
    res.end(req.url === '/' ? '<!doctype html><h1>Authorized fixture</h1>' : 'ok');
  });
  const origin = await listen(app);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const blocked = [];
    await applyLocalBrowserBoundary(context, origin, url => blocked.push(url));
    const page = await context.newPage();
    await page.goto(origin);
    assert.equal(await page.locator('h1').textContent(), 'Authorized fixture');
    assert.equal(await page.evaluate(() => fetch('/ok').then(r => r.text())), 'ok');
    assert.equal(await page.evaluate(url => fetch(url).then(() => 'escaped', () => 'blocked'), sinkUrl + '/direct'), 'blocked');
    assert.equal(await page.evaluate(() => fetch('/redirect').then(() => 'escaped', () => 'blocked')), 'blocked');
    const navigationPage = await context.newPage();
    await assert.rejects(navigationPage.goto(sinkUrl + '/navigation'));
    await navigationPage.close();
    const ws = await page.evaluate(url => new Promise(resolve => { const socket = new WebSocket(url); socket.onopen = () => resolve('escaped'); socket.onclose = () => resolve('blocked'); socket.onerror = () => resolve('blocked'); }), sinkUrl.replace('http:', 'ws:') + '/socket');
    assert.equal(ws, 'blocked');
    await page.evaluate(() => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
    assert.equal(context.serviceWorkers().length, 0);
    await resetLocalTarget({ origin, resetPath: '/reset' });
    await assert.rejects(resetLocalTarget({ origin, resetPath: '/reset-redirect' }));
    assert.equal(resets, 1);
    assert.equal(outsideHttp, 0);
    assert.equal(outsideWs, 0);
    assert.equal(workerRequests, 0);
    assert(blocked.length >= 4);
    console.log(JSON.stringify({ boundary: "browser-origin", outsideHttp, outsideWs, workerRequests, resets, blockedRequests: blocked.length }));
  } finally {
    await browser?.close();
    await close(app); await close(sink);
    await assert.rejects(fetch(origin)); await assert.rejects(fetch(sinkUrl));
  }
});
