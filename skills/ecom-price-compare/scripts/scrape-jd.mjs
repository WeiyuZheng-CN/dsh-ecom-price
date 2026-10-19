#!/usr/bin/env node
/**
 * scrape-jd.mjs - price check the procurement list on JD.
 *
 * JD's search page is server-rendered, so one request per item gives name +
 * price + shop, no detail-page round trip (and no price masking like Taobao).
 *
 *   node scrape-jd.mjs --only 1,3      # smoke test
 *   node scrape-jd.mjs                 # all pending
 *   node scrape-jd.mjs --limit 10
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ITEMS = () => resolveArg(opt('items', 'items.json'));
const OUT = () => resolveArg(opt('out', 'jd-results.json'));
const JD_EXTRACTOR = join(HERE, 'jd-extract.js');
const resolveArg = (p) => (isAbsolute(p) ? p : join(HERE, p));
const BASE = 'http://127.0.0.1:9222';
const CALL_TIMEOUT = 40000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ONLY = opt('only', '').split(',').filter(Boolean).map(Number);
const LIMIT = Number(opt('limit', 0));
const TOP = Number(opt('top', 5));
const PAUSE = Number(opt('pause', 0)); // ms between items, overrides the default jitter
const BATCH = Number(opt('batch', 0)); // items per batch
const BATCH_PAUSE = Number(opt('batchpause', 0)) * 1000; // ms to rest between batches

async function api(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => this._frame(ev.data);
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    const c = new Cdp(ws);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws failed'));
    });
    return c;
  }
  _frame(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      return;
    }
    for (const fn of this.handlers.get(m.method) ?? []) fn(m.params);
  }
  send(method, params = {}, timeout = CALL_TIMEOUT) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
  }
  once(method, timeout = CALL_TIMEOUT) {
    return new Promise((resolve) => {
      let timer;
      const fn = (p) => {
        clearTimeout(timer);
        this.handlers.set(method, (this.handlers.get(method) ?? []).filter((f) => f !== fn));
        resolve(p);
      };
      this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]);
      timer = setTimeout(() => resolve(null), timeout);
      timer.unref?.();
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`page JS: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async navigate(url, timeout = 40000) {
    const loaded = this.once('Page.loadEventFired', timeout);
    const nav = await this.send('Page.navigate', { url });
    if (nav?.errorText) throw new Error(`nav: ${nav.errorText}`);
    await loaded;
    await sleep(800);
  }
}

async function main() {
  const jdExpr = readFileSync(JD_EXTRACTOR, 'utf8');
  const items = JSON.parse(readFileSync(ITEMS(), 'utf8'));
  let results = existsSync(OUT()) ? JSON.parse(readFileSync(OUT(), 'utf8')) : {};
  const done = new Set(Object.entries(results).filter(([, v]) => v.status === 'ok').map(([k]) => Number(k)));

  let queue = items.filter((it) => !done.has(it.id));
  if (ONLY.length) queue = queue.filter((it) => ONLY.includes(it.id));
  if (LIMIT) queue = queue.slice(0, LIMIT);
  console.log(`queue: ${queue.length}; already ok: ${done.size}/${items.length}`);

  const targets = (await api('/json/list')).filter((t) => t.type === 'page' && /^https?:/.test(t.url));
  if (!targets.length) throw new Error('no web tab');
  const cdp = await Cdp.connect(targets[0].webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  for (const [i, it] of queue.entries()) {
    const tag = `[${i + 1}/${queue.length}] #${it.id} ${it.name}`;
    const rec = { id: it.id, name: it.name, spec: it.spec, qty: it.qty, refPrice: it.refPrice, query: it.jdQuery, checkedAt: new Date().toISOString() };
    try {
      await cdp.navigate(it.jdUrl, 45000);
      await sleep(900);
      let r = await cdp.evaluate(`(${jdExpr})(${TOP})`);
      // JD sometimes has no results for the list's long-tail query. Retry once with a
      // looser keyword (first two tokens, punctuation stripped) before giving up.
      if (!r.items.length && !r.blocked && !r.loginWall) {
        const loose = String(it.name || '')
          .replace(/[（）()/、+]/g, ' ')
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .join(' ');
        if (loose && loose !== it.jdQuery) {
          const alt = 'https://search.jd.com/Search?keyword=' + encodeURIComponent(loose) + '&enc=utf-8';
          await cdp.navigate(alt, 45000);
          await sleep(900);
          const r2 = await cdp.evaluate(`(${jdExpr})(${TOP})`);
          if (r2.items.length) {
            r = r2;
            rec.fallbackQuery = loose;
          }
        }
      }
      rec.cards = r.cards;
      rec.items = r.items;
      rec.head = r.head;
      rec.status = r.blocked ? 'blocked' : r.loginWall ? 'login' : r.items.length ? 'ok' : 'empty';
      console.log(`${tag} -> ${rec.status} n=${r.items.length} p0=${r.items[0]?.price ?? '-'} ${(r.items[0]?.name ?? '').slice(0, 22)}`);
    } catch (e) {
      rec.status = 'error';
      rec.error = String(e.message ?? e).slice(0, 140);
      console.log(`${tag} -> error ${rec.error}`);
    }
    results[it.id] = rec;
    writeFileSync(OUT(), JSON.stringify(results, null, 1), 'utf8');
    await sleep(2200 + Math.random() * 1800);
  }

  const stats = Object.values(results).reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  console.log('done:', JSON.stringify(stats));
  await new Promise((r) => {
    const t = setTimeout(r, 400);
    cdp.ws.addEventListener('close', () => {
      clearTimeout(t);
      r();
    });
    cdp.ws.close();
  });
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exitCode = 1;
});
