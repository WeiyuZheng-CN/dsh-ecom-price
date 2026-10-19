#!/usr/bin/env node
/**
 * sku.mjs — 点选 SKU 再读价：给「必须眼见为实」的场合用（京东、或想确认某个选项的现价）。
 *
 *   node sku.mjs plan.json out.json [--only key1,key2]
 *
 * plan.json = [
 *   { "key": "maly",
 *     "url": "https://detail.tmall.com/item.htm?id=...",
 *     "picks": [ { "label": "钛白500ml", "tokens": [["【500ml罐装】"], ["钛白"]] } ] }
 * ]
 *
 * tokens 是**按组依次点**：每个内层数组是一次点击，里面的字符串必须同时出现在
 * 同一个选项上（「【500ml罐装】」和「钛白」分属两个属性组，所以要两段）。
 *
 * 与 audit.mjs 的区别：audit 读页面内嵌数据（快、能拿全表）；
 * 本脚本模拟真人点选（慢），但能验证「选了之后页面显示的价格」，且京东只有这条路。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HOST = process.env.CDP_HOST ?? '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9222';
const BASE = `http://${HOST}:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = 'GET') {
  const res = await fetch(BASE + path, { method });
  const body = await res.text();
  return body ? JSON.parse(body) : null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    ws.onclose = () => {
      for (const [, p] of this.pending) p.reject(new Error('socket closed'));
      this.pending.clear();
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws fail'));
    });
    return cdp;
  }

  send(method, params = {}, timeout = 45000) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout ' + method));
      }, timeout);
      t.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result?.value;
  }

  async shutdown() {
    await new Promise((res) => {
      const t = setTimeout(res, 400);
      this.ws.addEventListener(
        'close',
        () => {
          clearTimeout(t);
          res();
        },
        { once: true },
      );
      try {
        this.ws.close();
      } catch {
        res();
      }
    });
  }
}

// 价格数字可能被拆进多个 span（"￥4 . 08"），也可能被打码（"￥4.??"）
const READ_SNIPPET = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const unit = document.querySelector('[class*="unit--"]');
  const box = unit && unit.parentElement ? norm(unit.parentElement.innerText) : '';
  const flat = box.replace(/\\s+/g, '');
  const m = flat.match(/￥([\\d.,?]+)(?:[-~]([\\d.,?]+))?/);
  const price = m ? (m[2] ? m[1] + '-' + m[2] : m[1]) : null;
  const masked = !!(price && price.includes('?'));
  const chosen = [...document.querySelectorAll('[class*="valueItem" i]')]
    .filter((el) => /isSelected|selected|actived/i.test((el.className || '').toString()))
    .map((el) => norm(el.innerText).slice(0, 40));
  const stockEl = document.querySelector('[class*="quantity" i], #store-prompt, .store-prompt');
  return {
    price,
    num: price && !masked ? parseFloat(price) : null,
    masked,
    priceRaw: box.slice(0, 40),
    chosen,
    stock: stockEl ? norm(stockEl.innerText).slice(0, 20) : null,
  };
})()`;

function clickSnippet(tokens) {
  return `(() => {
    const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    const tokens = ${JSON.stringify(tokens)};
    const items = [...document.querySelectorAll('[class*="valueItemText" i]')];
    const hit = items.find((el) => {
      const t = norm(el.innerText) + ' ' + (el.getAttribute('title') || '');
      return tokens.every((tk) => t.includes(tk));
    });
    if (!hit) {
      return { ok: false, error: 'no option matching ' + JSON.stringify(tokens),
               available: [...new Set(items.map((el) => norm(el.innerText)).filter(Boolean))].slice(0, 80) };
    }
    const target = hit.closest('[class*="valueItem" i]') || hit;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return { ok: true, clicked: norm(target.innerText).slice(0, 40) };
  })()`;
}

const planPath = process.argv[2];
const outPath = process.argv[3];
if (!planPath || !outPath) {
  console.error('usage: node sku.mjs plan.json out.json [--only key1,key2]');
  process.exit(2);
}
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > 0 ? String(process.argv[onlyIdx + 1]).split(',') : null;
const plan = JSON.parse(readFileSync(planPath, 'utf8'));

const pages = (await api('/json/list')).filter((t) => t.type === 'page' && /^https?:/.test(t.url));
const target = pages[0] ?? (await api(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT'));
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const results = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};

try {
  await cdp.send('Page.enable');
  for (const item of plan) {
    if (only && !only.includes(item.key)) continue;
    if (results[item.key]?.picks?.length) {
      console.log('skip (cached)', item.key);
      continue;
    }
    const rec = { key: item.key, name: item.name, spec: item.spec, url: item.url, picks: [] };
    try {
      const nav = await cdp.send('Page.navigate', { url: item.url });
      if (nav?.errorText) throw new Error('nav: ' + nav.errorText);
      await sleep(3500);
      rec.title = await cdp.evaluate('document.title');
      rec.base = await cdp.evaluate(READ_SNIPPET);
      for (const pick of item.picks) {
        const steps = [];
        for (const tokens of pick.tokens) {
          const r = await cdp.evaluate(clickSnippet(tokens));
          steps.push(r);
          if (!r.ok) break;
          await sleep(900);
        }
        rec.picks.push({ label: pick.label, tokens: pick.tokens, steps, state: await cdp.evaluate(READ_SNIPPET) });
        await sleep(300);
      }
    } catch (e) {
      rec.error = e.message;
    }
    results[item.key] = rec;
    writeFileSync(outPath, JSON.stringify(results, null, 1), 'utf8');
    console.log(
      item.key,
      rec.error ? 'ERR ' + rec.error : rec.picks.map((p) => `${p.label}=${p.state?.price ?? '?'}`).join(' '),
    );
  }
} finally {
  await cdp.shutdown();
}
