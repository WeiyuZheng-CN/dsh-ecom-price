#!/usr/bin/env node
/**
 * probe.mjs — 打开一个页面，把「价格盒 + SKU 选项 + 正文开头」原样 dump 出来。
 * 换平台、改版、抽取器失效时先用它看一眼 DOM，再改选择器。
 *
 *   node probe.mjs <url> [--sel '[class*="price"]']
 *
 * 页面侧逻辑在同目录 probe-page.js，改抽取规则改那个文件即可。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
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
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
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

  send(method, params = {}, timeout = 40000) {
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
      this.ws.close();
    });
  }
}

const url = process.argv[2];
if (!url) {
  console.error('usage: node probe.mjs <url>');
  process.exit(2);
}

const pages = (await api('/json/list')).filter((t) => t.type === 'page' && /^https?:/.test(t.url));
const target = pages[0] ?? (await api(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT'));
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
try {
  await cdp.send('Page.enable');
  const nav = await cdp.send('Page.navigate', { url });
  if (nav?.errorText) throw new Error('nav: ' + nav.errorText);
  await sleep(4000);
  const out = await cdp.evaluate(readFileSync(join(HERE, 'probe-page.js'), 'utf8'));
  console.log(JSON.stringify(out, null, 1).slice(0, 12000));
} finally {
  await cdp.shutdown();
}
