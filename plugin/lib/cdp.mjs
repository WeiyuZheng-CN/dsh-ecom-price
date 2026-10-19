/**
 * Minimal DevTools Protocol client + Taobao extractors.
 *
 * Zero dependencies: Node >= 22 ships a global WebSocket.
 * The browser must already be started with --remote-debugging-port on a
 * NON-default --user-data-dir (Chromium 136+ refuses the default one).
 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 9222;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CdpError extends Error {}

/** List page targets that are real web pages (edge:// dialogs also appear there). */
export async function listPages(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  let res;
  try {
    res = await fetch(`http://${host}:${port}/json/list`);
  } catch (err) {
    throw new CdpError(
      `no CDP endpoint on ${host}:${port} — start Edge with launch-edge-cdp.ps1 ` +
        `(--remote-debugging-port=${port} --user-data-dir=<non-default dir>). ${err.message}`,
    );
  }
  if (!res.ok) throw new CdpError(`/json/list -> HTTP ${res.status}`);
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && /^https?:/i.test(t.url || ''));
}

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = (ev) => this._frame(ev.data);
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new CdpError(`WebSocket failed: ${wsUrl}`));
    });
    return cdp;
  }

  _frame(raw) {
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
      clearTimeout(p.timer);
      msg.error ? p.reject(new CdpError(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg.result);
      return;
    }
    for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
  }

  send(method, params = {}, timeout = 30000) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpError(`timeout after ${timeout}ms: ${method}`));
      }, timeout);
      timer.unref?.();
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

  once(method, timeout = 30000) {
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
        resolve(null);
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
      throw new CdpError(`page JS threw: ${d}`);
    }
    return r.result?.value;
  }

  async navigate(url, timeout = 45000) {
    await this.send('Page.enable');
    const loaded = this.once('Page.loadEventFired', timeout);
    const nav = await this.send('Page.navigate', { url });
    if (nav?.errorText) throw new CdpError(`navigation failed: ${nav.errorText}`);
    await loaded;
    await sleep(900);
    return this.evaluate('document.title');
  }

  async cookies(url) {
    await this.send('Network.enable');
    const { cookies } = await this.send('Network.getCookies', { urls: [url] });
    return cookies;
  }

  async close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Attach to the first matching web tab, or open one if none exists. */
export async function attach({ host = DEFAULT_HOST, port = DEFAULT_PORT, match } = {}) {
  const pages = await listPages(host, port);
  let target = match
    ? pages.find((t) => `${t.url} ${t.title}`.toLowerCase().includes(String(match).toLowerCase()))
    : pages[0];
  if (!target) {
    const res = await fetch(`http://${host}:${port}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
    if (!res.ok) throw new CdpError(`cannot open a tab: HTTP ${res.status}`);
    target = await res.json();
  }
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  return { cdp, target };
}

/** Taobao search list. Prices here are masked ("4??"); use the item page for real ones. */
export const taobaoListExpr = (limit) => `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const priceRe = /[¥￥]\\s*(\\d+(?:\\.\\d+)?)(?:\\s*[-~]\\s*[¥￥]?\\s*(\\d+(?:\\.\\d+)?))?/;
  const soldRe = /(\\d+(?:\\.\\d+)?\\s*万?)\\s*\\+?\\s*(?:人付款|人已买|件已售|已售|付款)/;
  const itemUrl = /\\/\\/item\\.(taobao|tmall)\\.com|\\/\\/detail\\.tmall\\.com|item\\.htm/;
  const rows = [];
  const seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href || '';
    if (!itemUrl.test(href) || seen.has(href)) continue;
    let box = a;
    let text = '';
    for (let i = 0; i < 6 && box; i++) {
      text = norm(box.innerText);
      if (priceRe.test(text) || text.length > 40) break;
      box = box.parentElement;
    }
    if (!text || text.length < 6) continue;
    seen.add(href);
    const pm = text.match(priceRe);
    const sm = text.match(soldRe);
    const lines = text.split(/ {2,}| /).filter((s) => s.length > 1);
    const shop = [...lines].reverse().find((s) => s.length <= 20 && !/^[¥￥\\d]/.test(s) && !/付款|已售|包邮|退货|险/.test(s)) ?? null;
    rows.push({
      title: (a.getAttribute('title') || lines[0] || '').slice(0, 80),
      text: text.slice(0, 220),
      price: pm ? (pm[2] ? pm[1] + '-' + pm[2] : pm[1]) : null,
      sold: sm ? sm[1] : null,
      shop,
      link: href.split('&')[0],
    });
    if (rows.length >= ${Number(limit) || 8}) break;
  }
  const body = norm(document.body.innerText);
  return {
    title: document.title,
    count: rows.length,
    items: rows,
    loginWall: /亲，请登录/.test(body.slice(0, 200)) || /login\\.taobao\\.com/.test(location.href),
    head: body.slice(0, 100),
  };
})()`;

/** Taobao item page. The price digits live in a CLASS-LESS parent of the "￥" span. */
export const taobaoItemExpr = `(() => {
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
    loginWall: /亲，请登录/.test(body.slice(0, 200)),
  };
})()`;
