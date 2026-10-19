#!/usr/bin/env node
/**
 * audit.mjs — SKU 级核价：把商品页上「每个规格各自的价」整表导出来。
 *
 *   node audit.mjs urls.json out.json [--only key1,key2]
 *
 * urls.json = [{ "key": "maly", "url": "https://item.taobao.com/item.htm?id=...", "platform": "tb" }]
 *
 * 为什么需要它：搜索卡片与商品页首屏给的价是**最低 SKU 价**（常带「起」），
 * 清单要的是「某个规格」的价。只有把 skuBase(属性) × skuCore.sku2info(价格)
 * 摊开，才能回答「500ml 到底多少钱」。
 *
 * 淘宝/天猫：页面内嵌 __ICE_APP_CONTEXT__.loaderData.home.data.res
 *   res.skuBase.props[p].values[v] -> 属性值名（颜色/规格…）
 *   res.skuBase.skus[]           -> skuId + propPath（pid:vid;pid:vid）
 *   res.skuCore.sku2info[skuId]  -> price.priceText / quantityText
 *   注意：部分店铺 fuzzyPrice=true，priceText 形如 "4.??" / "2?" / "1??"，
 *        精确值拿不到，只能读量级（见 references/platform-playbook.md）。
 *
 * 京东：列表卡片名里通常已带规格（「1KG」「10片装」「*6卷/筒」），
 *      商品详情页会被 PC 频控(403) 拦，本脚本对京东只做尽力而为的 DOM 读取。
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

const EXTRACT_TB = `(async () => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const getRes = () => {
    try {
      const c = window.__ICE_APP_CONTEXT__;
      return c && c.loaderData && c.loaderData.home && c.loaderData.home.data && c.loaderData.home.data.res;
    } catch { return null; }
  };
  const deadline = Date.now() + 15000;
  let res = getRes();
  while (!res && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 500)); res = getRes(); }
  var box = document.querySelector('[class*="unit--"]');
  var pagePrice = box && box.parentElement ? norm(box.parentElement.innerText).slice(0, 40) : null;
  if (!res) {
    const t = document.title || '';
    const u = location.href;
    const body = norm(document.body.innerText).slice(0, 200);
    const reason = /验证码|滑动|安全验证/.test(t + body) ? 'captcha'
      : /login\\.taobao\\.com|havanaone/.test(u) || /请登录|扫码登录/.test(body) ? 'login_wall'
      : 'no_ice_data';
    return { ok: false, reason, title: t, url: u, pagePrice, bodyHead: body };
  }
  const valName = {};
  const props = (res.skuBase?.props || []).map((p) => {
    (p.values || []).forEach((v) => { valName[p.pid + ':' + v.vid] = { g: p.name, n: v.name }; });
    return { pid: p.pid, name: p.name, values: (p.values || []).map((v) => v.name) };
  });
  const info = (res.skuCore && res.skuCore.sku2info) || {};
  const skus = (res.skuBase?.skus || []).map((s) => {
    const parts = String(s.propPath || '').split(';').filter(Boolean).map((kv) => {
      const [pid, vid] = kv.split(':');
      const hit = valName[pid + ':' + vid];
      return hit ? hit.g + '=' + hit.n : kv;
    });
    const i = info[s.skuId] || {};
    const pt = i.price?.priceText ?? null;
    return {
      skuId: s.skuId,
      attrs: parts,
      attrsText: parts.join(' / '),
      priceText: pt,
      masked: !!(pt && pt.includes('?')),
      desc: i.price?.priceDesc || null,
      quantity: i.quantity ?? null,
      qtyText: i.quantityText || null,
    };
  });
  const real = skus.filter((s) => s.priceText && !s.masked).map((s) => Number(s.priceText)).filter((n) => n > 0);
  return {
    ok: true,
    platform: 'tb',
    title: document.title,
    url: location.href,
    shop: res.seller?.shopName || res.seller?.sellerNick || null,
    itemId: res.item?.itemId || null,
    props,
    skus,
    skuCount: skus.length,
    minReal: real.length ? Math.min(...real) : null,
    maxReal: real.length ? Math.max(...real) : null,
    maskedCount: skus.filter((s) => s.masked).length,
    pagePrice,
  };
})()`;

const EXTRACT_JD = `(() => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const u = location.href;
  if (/pc-frequent-pro|reason=403/.test(u)) {
    return { ok: false, reason: 'jd_rate_limited', title: document.title, url: u };
  }
  const priceEl = document.querySelector('.summary-price .p-price .price, .p-price .price, #jd-price');
  const price = priceEl ? norm(priceEl.innerText) : null;
  const groups = [];
  document.querySelectorAll('#choose-attrs li, #choose-attrs .li, .li[data-value], .item[data-value]').forEach((el) => {
    const t = norm(el.innerText);
    if (t && t.length < 40) groups.push(t);
  });
  return {
    ok: Boolean(price),
    platform: 'jd',
    title: document.title,
    url: u,
    pagePrice: price,
    skuGroups: [...new Set(groups)].slice(0, 80),
    reason: price ? undefined : 'jd_no_price_dom',
    note: '京东详情页只给当前选中 SKU 的价；规格更多时候要从搜索结果卡片名里读（含「1KG」「10片装」「*6卷/筒」等）',
  };
})()`;

const urlsPath = process.argv[2];
const outPath = process.argv[3];
if (!urlsPath || !outPath) {
  console.error('usage: node audit.mjs urls.json out.json [--only key1,key2]');
  process.exit(2);
}
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx > 0 ? String(process.argv[onlyIdx + 1]).split(',') : null;
const list = JSON.parse(readFileSync(urlsPath, 'utf8'));

const pages = (await api('/json/list')).filter((t) => t.type === 'page' && /^https?:/.test(t.url));
const target = pages[0] ?? (await api(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT'));
const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
const out = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {};
const REASONS = {
  captcha: '验证码拦截：等几分钟再试，或改用 item.taobao.com 入口重开；不要尝试绕过',
  login_wall: '登录态掉了：让用户重新扫码（见 SKILL.md 前置检查），不要当成反爬',
  no_ice_data: '页面没等到 __ICE_APP_CONTEXT__：多半是商品已下架/改版/没渲染完',
  jd_rate_limited: '京东 PC 频控：详情页 403，冷却后重试或改用搜索卡片里的 SKU 名核对',
};

try {
  await cdp.send('Page.enable');
  for (const it of list) {
    if (only && !only.includes(it.key)) continue;
    if (out[it.key] && out[it.key].ok) {
      console.log('cached', it.key);
      continue;
    }
    const rec = { key: it.key, url: it.url, platform: it.platform || 'tb', checkedAt: new Date().toISOString() };
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const nav = await cdp.send('Page.navigate', { url: it.url });
        if (nav?.errorText) throw new Error('nav: ' + nav.errorText);
        await sleep(it.platform === 'jd' ? 4500 : 4000);
        Object.assign(rec, await cdp.evaluate(it.platform === 'jd' ? EXTRACT_JD : EXTRACT_TB));
        if (rec.ok || attempt === 2) break;
        console.log('  retry', it.key, 'reason:', rec.reason || rec.title);
        await sleep(6000);
      }
    } catch (e) {
      rec.ok = false;
      rec.reason = 'error';
      rec.error = e.message;
    }
    if (!rec.ok && rec.reason && REASONS[rec.reason]) rec.hint = REASONS[rec.reason];
    out[it.key] = rec;
    writeFileSync(outPath, JSON.stringify(out, null, 1), 'utf8');
    const tag = rec.ok
      ? `${rec.skuCount ?? '?'} skus min=${rec.minReal ?? '-'} max=${rec.maxReal ?? '-'} masked=${rec.maskedCount ?? '-'}`
      : `FAIL ${rec.reason}${rec.hint ? ' — ' + rec.hint : ''}`;
    console.log(it.key, tag);
    await sleep(1200);
  }
} finally {
  await cdp.shutdown();
}
