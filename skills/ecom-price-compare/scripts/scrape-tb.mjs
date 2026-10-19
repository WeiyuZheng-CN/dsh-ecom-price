#!/usr/bin/env node
/**
 * scrape-tb.mjs - batch price check on Taobao.
 *
 * Taobao masks digits on search-list prices ("1?"), so the list is only used to
 * find and rank candidates; the real price is read from the chosen item page.
 *
 * Quality-first: among the list candidates, prefer a shop whose name contains
 * 旗舰店 / 官方 / 专营 / 专卖 / 自营, and only fall back to the top result.
 *
 *   node scrape-tb.mjs --items items-tb.json --out tb-results.json \
 *        --batch 6 --batchpause 90 --pause 3000
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'http://127.0.0.1:9222';
const CALL_TIMEOUT = 45000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ITEMS = opt('items', 'items-tb.json');
const OUT = opt('out', 'tb-results.json');
const ONLY = opt('only', '').split(',').filter(Boolean).map(Number);
const LIMIT = Number(opt('limit', 0));
const TOP = Number(opt('top', 8));
const PAUSE = Number(opt('pause', 3000));
const BATCH = Number(opt('batch', 6));
const BATCH_PAUSE = Number(opt('batchpause', 90)) * 1000;

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
  async navigate(url, timeout = 45000) {
    const loaded = this.once('Page.loadEventFired', timeout);
    const nav = await this.send('Page.navigate', { url });
    if (nav?.errorText) throw new Error(`nav: ${nav.errorText}`);
    await loaded;
    await sleep(900);
  }
}

const ITEM_EXPR = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const unit = document.querySelector('[class*="unit--"]');
  const box = unit?.parentElement ? norm(unit.parentElement.innerText) : '';
  const m = box.match(/￥\\s*([\\d.,]+)(?:\\s*[-~]\\s*([\\d.,]+))?/);
  const isShop = (h) => { const i = h.indexOf('://'); if (i < 0) return false; const r = h.slice(i + 3); return r.startsWith('shop') && r.indexOf('.taobao.com') > 0; };
  const sl = [...document.querySelectorAll('a[href*="taobao.com"]')].find((a) => isShop(a.href));
  const shop = sl ? norm(sl.innerText).replace(/\\s*[\\d.]+\\s*(88VIP|好评).*$/, '').trim().slice(0, 26) : null;
  const body = norm(document.body.innerText);
  return {
    title: document.title.replace(/-淘宝网$/, ''),
    price: m ? (m[2] ? m[1] + '-' + m[2] : m[1]) : null,
    priceRaw: box.slice(0, 24) || null,
    shop,
    blocked: /验证|滑块/.test(body.slice(0, 400)),
  };
})()`;

const GOOD_SHOP = /(旗舰店|官方|专营|专卖|自营)/;

/** Key tokens taken from the search query itself (that is the intent) plus spec numbers. */
function keyTokens(it) {
  const drop = /^(旗舰店|官方|大桶|可选|最好|套装|专用|款)$/;
  const raw = `${it.query || it.name} ${it.spec || ''}`.replace(/[（）()／/、，,。；;：:×~\-]/g, ' ');
  const words = raw.split(/\s+/).filter((t) => t.length >= 2 && !drop.test(t));
  const specs = raw.match(/\d+(?:\.\d+)?(?:L|ml|ML|kg|g|寸|目|m|卷|支|个|桶|瓶|片|张|只|把|条|块|套|号)/g) || [];
  return [...new Set([...words, ...specs])];
}

function relevance(title, tokens) {
  if (!tokens.length) return 0;
  const t = title || '';
  return tokens.filter((k) => t.includes(k)).length / tokens.length;
}

async function main() {
  const listSrc = readFileSync(join(HERE, 'extract-taobao.js'), 'utf8');
  const items = JSON.parse(readFileSync(join(HERE, ITEMS), 'utf8'));
  let results = existsSync(join(HERE, OUT)) ? JSON.parse(readFileSync(join(HERE, OUT), 'utf8')) : {};
  const done = new Set(Object.entries(results).filter(([, v]) => v.status === 'ok').map(([k]) => Number(k)));

  let queue = items.filter((it) => !done.has(it.id));
  if (ONLY.length) queue = queue.filter((it) => ONLY.includes(it.id));
  if (LIMIT) queue = queue.slice(0, LIMIT);
  console.log(`queue ${queue.length}; done ${done.size}/${items.length}; batch ${BATCH} pause ${BATCH_PAUSE / 1000}s`);

  const targets = (await api('/json/list')).filter((t) => t.type === 'page' && /^https?:/.test(t.url));
  if (!targets.length) throw new Error('no web tab');
  const cdp = await Cdp.connect(targets[0].webSocketDebuggerUrl);
  await cdp.send('Page.enable');

  let ok = 0;
  let blockedRun = 0;
  for (const [i, it] of queue.entries()) {
    if (i > 0 && i % BATCH === 0) {
      console.log(`--- rest ${BATCH_PAUSE / 1000}s after ${i} items ---`);
      await sleep(BATCH_PAUSE);
    }
    const tag = `[${i + 1}/${queue.length}] #${it.id} ${it.name}`;
    const rec = { id: it.id, name: it.name, spec: it.spec, qty: it.qty, refPrice: it.refPrice, query: it.query, checkedAt: new Date().toISOString() };
    try {
      await cdp.navigate(it.url, 50000);
      await sleep(900);
      const list = await cdp.evaluate(`(${listSrc})(${TOP})`);
      rec.listCount = list.count;
      rec.cands = list.items;
      if (list.isLoginWall) {
        rec.status = 'login-wall';
        console.log(`${tag} -> login wall`);
      } else if (!list.items.length) {
        rec.status = 'empty';
        console.log(`${tag} -> empty (list ${list.count})`);
      } else {
        const tks = keyTokens(it);
        // A candidate only qualifies if its full card text carries the item's must-have word.
        const must = it.must || '';
        const qualified = list.items.filter((c) => !must || (c.text || c.title || '').includes(must));
        const scored = qualified
          .map((c) => ({ c, rel: relevance(`${c.text || ''} ${c.title || ''}`, tks), good: GOOD_SHOP.test(c.shop || '') }))
          .sort((a, b) => b.rel - a.rel || Number(b.good) - Number(a.good));
        const best = scored[0];
        rec.tokens = tks;
        rec.must = must;
        rec.qualified = ok.length;
        rec.scored = scored.slice(0, 4).map((s) => ({ rel: Number(s.rel.toFixed(2)), good: s.good, t: (s.c.text || s.c.title || '').slice(0, 40), shop: s.c.shop }));
        if (!best) {
          rec.status = 'no-match';
          console.log(`${tag} -> no-match (0/${list.items.length} 含「${must}」)`);
        } else {
          const pick = best.c;
          rec.pickReason = `${best.good ? 'brand-shop' : 'plain-shop'}/rel${best.rel.toFixed(2)}`;
          await cdp.navigate(pick.link, 50000);
          await sleep(1200);
          const d = await cdp.evaluate(ITEM_EXPR);
          rec.detail = { ...d, link: pick.link, listTitle: pick.title, listShop: pick.shop };
          rec.status = d.blocked ? 'blocked' : d.price ? 'ok' : 'no-price';
          if (rec.status === 'ok') ok++;
          console.log(`${tag} -> ${rec.status} ¥${d.price ?? '-'} ${(d.shop ?? '-').slice(0, 14)} [${rec.pickReason}] ${(pick.text || pick.title).slice(0, 20)}`);
        }
      }
      if (rec.status === 'blocked') blockedRun++;
    } catch (e) {
      rec.status = 'error';
      rec.error = String(e.message ?? e).slice(0, 140);
      console.log(`${tag} -> error ${rec.error}`);
    }
    results[it.id] = rec;
    writeFileSync(join(HERE, OUT), JSON.stringify(results, null, 1), 'utf8');
    await sleep(PAUSE + Math.random() * 1200);
  }

  const stats = Object.values(results).reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  console.log('done:', JSON.stringify(stats), 'ok this run:', ok, 'blocked:', blockedRun);
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
