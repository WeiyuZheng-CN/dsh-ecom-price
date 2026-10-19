#!/usr/bin/env node
/**
 * cdp.mjs — zero-dependency Chromium DevTools Protocol driver.
 *
 * Needs: Node >= 22 (global WebSocket) and an Edge/Chrome started with
 *   --remote-debugging-port=9222 --user-data-dir=<a NON-default directory>
 * No npm packages, no plugins.
 *
 *   node cdp.mjs version
 *   node cdp.mjs list
 *   node cdp.mjs open  <url> [--target <substr>]
 *   node cdp.mjs eval  <js-expression>
 *   node cdp.mjs text  <css-selector>
 *   node cdp.mjs click <css-selector>
 *   node cdp.mjs type  <css-selector> <text>
 *   node cdp.mjs shot  <out.png>
 *   node cdp.mjs taobao <keyword> [--limit 10]
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = process.env.CDP_HOST ?? '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9222';
const BASE = `http://${HOST}:${PORT}`;
const CALL_TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, method = 'GET') {
  const res = await fetch(BASE + path, { method });
  const body = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

async function waitBrowser(timeoutMs = 20000) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try {
      return await api('/json/version');
    } catch (e) {
      last = e;
      await sleep(300);
    }
  }
  throw new Error(
    `No CDP endpoint at ${BASE}.\nStart the browser first:  powershell -File launch-edge-cdp.ps1\n${last?.message ?? ''}`,
  );
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => this._onFrame(ev.data);
    ws.onclose = () => {
      for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
      this.pending.clear();
    };
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`WebSocket failed: ${wsUrl}`));
    });
    return cdp;
  }

  _onFrame(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg.result);
      return;
    }
    for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
  }

  send(method, params = {}, timeout = CALL_TIMEOUT) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout after ${timeout}ms: ${method}`));
      }, timeout);
      timer.unref?.(); // never hold the event loop open on our own account
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }

  once(method, timeout = CALL_TIMEOUT) {
    return new Promise((resolve) => {
      let timer;
      const fn = (params) => {
        clearTimeout(timer);
        this.handlers.set(method, (this.handlers.get(method) ?? []).filter((f) => f !== fn));
        resolve(params);
      };
      this.handlers.set(method, [...(this.handlers.get(method) ?? []), fn]);
      timer = setTimeout(() => {
        this.handlers.set(method, (this.handlers.get(method) ?? []).filter((f) => f !== fn));
        resolve(null); // never hang forever waiting for an event that may not fire
      }, timeout);
      timer.unref?.();
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`page JS threw: ${d}`);
    }
    return r.result?.value;
  }

  async navigate(url, timeout = 30000) {
    await this.send('Page.enable');
    const loaded = this.once('Page.loadEventFired', timeout);
    const nav = await this.send('Page.navigate', { url });
    if (nav?.errorText) throw new Error(`navigation failed: ${nav.errorText}`);
    await loaded;
    // give SPA hydration / lazy lists a moment
    await sleep(800);
    return { url: url, title: await this.evaluate('document.title') };
  }

  async screenshot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(path, Buffer.from(data, 'base64'));
    return path;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }

  /** Close and wait for the socket to actually finish, so Node can exit cleanly. */
  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(done, 400);
      try {
        this.ws.addEventListener('close', done, { once: true });
        this.ws.close();
      } catch {
        done();
      }
    });
  }
}

async function pickTarget(match) {
  const pages = (await api('/json/list')).filter((t) => t.type === 'page');
  if (!pages.length) return null;
  if (match) {
    const hit = pages.find((t) => `${t.url} ${t.title}`.toLowerCase().includes(match.toLowerCase()));
    if (hit) return hit;
    throw new Error(`no tab matching "${match}". open tabs:\n${pages.map((t) => `  - ${t.title} :: ${t.url}`).join('\n')}`);
  }
  // Prefer a real web page: edge:// permission dialogs and friends also show up here
  // and must never become the navigation target.
  const isWeb = (u = '') => /^https?:/i.test(u);
  return pages.find((t) => isWeb(t.url)) ?? pages[0];
}

async function attach(match) {
  await waitBrowser();
  let target = await pickTarget(match);
  if (!target) target = await api(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT');
  return { cdp: await Cdp.connect(target.webSocketDebuggerUrl), target };
}

/** Run the cursor/selection-safe "set value like a human typed it" snippet. */
function setValueSnippet(selector, text) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'selector not found: ' + ${JSON.stringify(selector)} };
    el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`;
}

function clickSnippet(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'selector not found: ' + ${JSON.stringify(selector)} };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, tag: el.tagName, text: (el.innerText || el.value || '').trim().slice(0, 80) };
  })()`;
}

const argv = process.argv.slice(2);
const verb = argv[0];
const flags = new Map();
const positional = [];
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags.set(argv[i].slice(2), argv[i + 1]?.startsWith('--') ? true : argv[++i]);
  else positional.push(argv[i]);
}
const targetFlag = flags.get('target');

function print(x) {
  console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
}

try {
  if (!verb || verb === 'help') {
    console.log(readFileSync(join(HERE, 'cdp.mjs'), 'utf8').split('*/')[0].replace(/^.*?\/\*\*/s, '').trim());
    process.exit(0);
  }

  if (verb === 'version') {
    const v = await waitBrowser();
    print({ Browser: v.Browser, 'Protocol-Version': v['Protocol-Version'], webSocketDebuggerUrl: v.webSocketDebuggerUrl });
    process.exit(0);
  }

  if (verb === 'list') {
    await waitBrowser();
    const pages = (await api('/json/list')).filter((t) => t.type === 'page');
    print(pages.map((t) => ({ title: t.title, url: t.url })));
    process.exit(0);
  }

  const { cdp, target } = await attach(targetFlag);
  try {
    if (verb === 'open') {
      const url = positional[0];
      if (!url) throw new Error('usage: open <url>');
      print({ attachedTo: target.url, ...(await cdp.navigate(url)) });
    } else if (verb === 'eval') {
      print(await cdp.evaluate(positional.join(' ')));
    } else if (verb === 'text') {
      const sel = positional[0];
      print(
        await cdp.evaluate(`(() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (!el) return { found: false, selector: ${JSON.stringify(sel)} };
          return { found: true, selector: ${JSON.stringify(sel)}, text: (el.innerText || el.textContent || '').trim() };
        })()`),
      );
    } else if (verb === 'click') {
      print(await cdp.evaluate(clickSnippet(positional[0])));
    } else if (verb === 'type') {
      print(await cdp.evaluate(setValueSnippet(positional[0], positional.slice(1).join(' '))));
    } else if (verb === 'front') {
      await cdp.send('Page.bringToFront');
      print({ broughtToFront: target.url });
    } else if (verb === 'cookies') {
      // names only - never print values, they are live session credentials
      const urls = positional.length ? positional : [await cdp.evaluate('location.href')];
      await cdp.send('Network.enable');
      const { cookies } = await cdp.send('Network.getCookies', { urls });
      const names = cookies.map((c) => c.name);
      const taobaoUser = names.includes('unb'); // Taobao user-id cookie
      const jdUser = names.includes('pin') || names.includes('thor') || names.includes('pt_key');
      const markers = ['unb', 'pin', 'thor', 'pt_key', 'pt_pin', '_tb_token_', 'cookie2', 'sgcookie', '_l_g_'].filter((n) => names.includes(n));
      print({
        requestedUrls: urls,
        total: cookies.length,
        loggedIn: taobaoUser || jdUser,
        taobaoLoggedIn: taobaoUser,
        jdLoggedIn: jdUser,
        markersPresent: markers,
        names: [...new Set(names)].sort().slice(0, 30),
      });
    } else if (verb === 'item') {
      // Search-result prices come back masked ("4??"), item pages do not - so price from here.
      const arg = positional[0];
      if (!arg) throw new Error('usage: item <url|itemId>');
      const url = /^https?:/i.test(arg) ? arg : `https://item.taobao.com/item.htm?id=${arg}`;
      await cdp.navigate(url, 45000);
      await sleep(1800);
      print({
        url,
        ...(await cdp.evaluate(`(() => {
          const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
          // Taobao's item page puts the digits in a class-less parent of the "￥" unit span,
          // so [class*=price] finds nothing. Anchor on the unit symbol instead.
          const unit = document.querySelector('[class*="unit--"]');
          const box = unit?.parentElement ? norm(unit.parentElement.innerText) : '';
          const m = box.match(/￥\\s*([\\d.,]+)(?:\\s*[-~]\\s*([\\d.,]+))?/);
          // Shop name lives on the shop<digits>.taobao.com link, followed by its rating.
          // Written without a regex literal: backslashes are eaten by the outer template string.
          const isShopLink = (h) => {
            const i = h.indexOf('://');
            if (i < 0) return false;
            const rest = h.slice(i + 3);
            return rest.startsWith('shop') && rest.indexOf('.taobao.com') > 0;
          };
          const shopLink = [...document.querySelectorAll('a[href*="taobao.com"]')].find((a) => isShopLink(a.href));
          const shop = shopLink
            ? norm(shopLink.innerText).replace(/\\s*[\\d.]+\\s*(88VIP|好评).*$/, '').trim().slice(0, 24)
            : null;
          return {
            title: document.title.replace(/-淘宝网$/, ''),
            price: m ? (m[2] ? m[1] + '-' + m[2] : m[1]) : null,
            priceRaw: box.slice(0, 30) || null,
            shop,
          };
        })()`)),
      });
    } else if (verb === 'shot') {
      print({ saved: await cdp.screenshot(positional[0] ?? 'shot.png') });
    } else if (verb === 'taobao') {
      const keyword = positional[0];
      if (!keyword) throw new Error('usage: taobao <keyword> [--limit 10]');
      const limit = Number(flags.get('limit') ?? 10);
      const url = `https://s.taobao.com/search?q=${encodeURIComponent(keyword)}`;
      const nav = await cdp.navigate(url, 45000);
      const extractor = readFileSync(join(HERE, 'extract-taobao.js'), 'utf8');
      const result = await cdp.evaluate(`(${extractor})(${limit})`);
      print({ navigatedTo: nav.url, title: nav.title, ...result });
    } else {
      throw new Error(`unknown verb: ${verb}`);
    }
  } finally {
    await cdp.shutdown();
  }
  process.exitCode = 0;
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  // Do not process.exit() here: hard-exiting mid-teardown trips a libuv assertion.
  process.exitCode = 1;
}
