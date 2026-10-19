/**
 * dsh-plugin-ecom-price — drive the user's already-logged-in browser to read
 * real Taobao prices, instead of scraping or trusting third-party plugins.
 *
 * The browser must be started with a debugging port on a non-default profile
 * (scripts/launch-edge-cdp.ps1 from the ecom-price-compare skill does that).
 * This plugin never touches credentials: it reuses the browser's session.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  attach,
  listPages,
  sleep,
  taobaoItemExpr,
  taobaoListExpr,
  taobaoSkuExpr,
} from './cdp.mjs';

export const name = 'ecom-price';

/** Only the tools service is required; everything else is optional. */
export const inject = ['tools'];

const NOTE_LIST =
  '淘宝搜索列表页的价格被脱敏成「4??」这类字面问号，只能用来发现候选。真实价格请用 shop_sku_price 按规格读取。';
const NOTE_LOGIN =
  '如果返回 loginWall=true，说明浏览器登录态失效（换网络、访问过 H5 详情页都会导致掉登录）。让用户重新扫码，不要归因为"反爬限流"。';
const NOTE_SKU =
  '商品页首屏/列表页给的是**最低 SKU 价**（常带「起」）。清单问的是某个规格的价，必须用 shop_sku_price 按规格取。';
const NOTE_MASK =
  '这家店把价格打码了（fuzzyPrice，例如「4.??」「2?」）：位数即量级（2? = 20–29），精确值拿不到。可换一家不打码的店，或表里按量级下限计并在备注写区间。';
const NOTE_CAPTCHA =
  '天猫验证码拦截。不要尝试自动化绕过：等几分钟，或改用 https://item.taobao.com/item.htm?id=<同一 id> 入口重开。';

const REASON_TEXT = {
  login_wall: NOTE_LOGIN,
  captcha: NOTE_CAPTCHA,
  no_ice_data: '页面没等到 SKU 数据（可能已下架/改版/没渲染完）。换时间重试，或用 shop_open 让用户自己看一眼。',
};

/** Attach with a short retry: a page may be mid-navigation right after startup. */
async function withBrowser(options, fn) {
  const { cdp, target } = await attach(options);
  try {
    return await fn(cdp, target);
  } finally {
    await cdp.close();
  }
}

function fail(reason, message) {
  return { ok: false, reason, message };
}

export function apply(ctx, config = {}) {
  const host = config.host || DEFAULT_HOST;
  const port = Number(config.port || DEFAULT_PORT);
  const opts = { host, port };

  // ---- browser status ----
  ctx.tools.register(
    defineTool({
      name: 'shop_browser_status',
      description:
        '检查本机浏览器调试端口是否可用，以及淘宝/京东的登录态是否还在。'
        + '抓价前先调这个：登录态失效时任何抓取都会返回空列表或登录页。',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            endpoint: { type: 'string' },
            tabs: { type: 'integer' },
            taobaoLoggedIn: { type: 'boolean' },
            jdLoggedIn: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_a, v) =>
          [{
            type: 'text',
            text: v.ok
              ? `浏览器可用（${v.endpoint}），标签页 ${v.tabs} 个；淘宝登录=${v.taobaoLoggedIn}，京东登录=${v.jdLoggedIn}`
                + (v.taobaoLoggedIn ? '' : `\n${NOTE_LOGIN}`)
              : `浏览器不可用：${v.message}`,
          }],
      },
      execute: async () => {
        try {
          const pages = await listPages(host, port);
          const cookiesFor = async (url) => {
            const { cdp } = await attach(opts);
            try {
              const list = await cdp.cookies(url);
              return list.map((c) => c.name);
            } finally {
              await cdp.close();
            }
          };
          const tb = await cookiesFor('https://www.taobao.com');
          const jd = await cookiesFor('https://www.jd.com');
          return {
            ok: true,
            endpoint: `${host}:${port}`,
            tabs: pages.length,
            taobaoLoggedIn: tb.includes('unb'),
            jdLoggedIn: jd.includes('pin') || jd.includes('thor') || jd.includes('pt_key'),
          };
        } catch (err) {
          return fail('browser_unavailable', err.message);
        }
      },
    }),
  );

  // ---- search ----
  ctx.tools.register(
    defineTool({
      name: 'shop_search',
      description:
        '在淘宝搜索商品，返回候选列表：标题、店铺、销量、链接。'
        + '价格字段不可信（被平台脱敏），只看候选与店铺；定稿后用 shop_sku_price 按规格读实价。'
        + '需要"靠谱"时优先挑店铺名含 旗舰店/官方/专营/自营 的候选。',
      parameters: {
        keyword: { type: 'string', required: true, description: '搜索关键词，可带品牌词与规格，例如「马利 丙烯颜料 1L 钛白」' },
        limit: { type: 'integer', description: '返回候选条数，默认 8，最多 20' },
        target: { type: 'string', description: '可选：匹配某个已打开标签页的 URL/标题片段；不填则用第一个网页标签' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            keyword: { type: 'string' },
            url: { type: 'string' },
            count: { type: 'integer' },
            loginWall: { type: 'boolean' },
            note: { type: 'string' },
            message: { type: 'string' },
            items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title: { type: 'string' },
                  shop: { type: 'string' },
                  sold: { type: 'string' },
                  link: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_a, v) => {
          if (!v.ok) return [{ type: 'text', text: `搜索失败：${v.message}` }];
          const lines = (v.items ?? []).map(
            (it, i) => `${i + 1}. ${it.title}\n   ${it.shop ?? '-'} | 已售 ${it.sold ?? '-'}\n   ${it.link}`,
          );
          return [{
            type: 'text',
            text: `「${v.keyword}」候选 ${v.count} 条：\n\n${lines.join('\n')}\n\n⚠️ ${v.note}`
              + (v.loginWall ? `\n⚠️ ${NOTE_LOGIN}` : ''),
          }];
        },
      },
      execute: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
        const url = `https://s.taobao.com/search?q=${encodeURIComponent(args.keyword)}`;
        try {
          return await withBrowser({ ...opts, match: args.target }, async (cdp) => {
            await cdp.navigate(url, 50000);
            await sleep(700);
            const r = await cdp.evaluate(taobaoListExpr(limit));
            return {
              ok: true,
              keyword: args.keyword,
              url,
              count: r.count,
              loginWall: Boolean(r.loginWall),
              note: NOTE_LIST,
              items: (r.items ?? []).map((it) => ({
                title: it.title,
                shop: it.shop ?? undefined,
                sold: it.sold ?? undefined,
                link: it.link,
              })),
            };
          });
        } catch (err) {
          return fail('search_failed', err.message);
        }
      },
    }),
  );

  // ---- real price (cheapest sku of the link) ----
  ctx.tools.register(
    defineTool({
      name: 'shop_price',
      description:
        '打开淘宝/天猫商品页，读出**页面首屏显示的价格**与店铺名。注意这是该链接最低 SKU 的价（常带「起」），'
        + '不等于清单里某个规格的价；要按规格取价用 shop_sku_price。支持传完整商品链接或纯商品 id。',
      parameters: {
        item: { type: 'string', required: true, description: '商品链接，或纯数字商品 id' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string' },
            title: { type: 'string' },
            price: { type: 'string' },
            priceRaw: { type: 'string' },
            masked: { type: 'boolean' },
            shop: { type: 'string' },
            loginWall: { type: 'boolean' },
            captcha: { type: 'boolean' },
            note: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: (_a, v) =>
          [{
            type: 'text',
            text: v.ok
              ? `${v.title}\n首屏价 ¥${v.price ?? '未读到'}（原样：${v.priceRaw ?? '-'}）\n店铺 ${v.shop ?? '-'}\n${v.url}`
                + `\n⚠️ ${v.masked ? NOTE_MASK : NOTE_SKU}`
                + (v.loginWall ? `\n⚠️ ${NOTE_LOGIN}` : '')
                + (v.captcha ? `\n⚠️ ${NOTE_CAPTCHA}` : '')
              : `读取失败：${v.message}${v.loginWall ? `\n⚠️ ${NOTE_LOGIN}` : ''}${v.captcha ? `\n⚠️ ${NOTE_CAPTCHA}` : ''}`,
          }],
      },
      execute: async (args) => {
        const raw = String(args.item).trim();
        const url = /^https?:/i.test(raw) ? raw : `https://item.taobao.com/item.htm?id=${raw}`;
        try {
          return await withBrowser(opts, async (cdp) => {
            await cdp.navigate(url, 50000);
            await sleep(1400);
            const r = await cdp.evaluate(taobaoItemExpr);
            return {
              ok: Boolean(r.price),
              url,
              title: r.title ?? undefined,
              price: r.price ?? undefined,
              priceRaw: r.priceRaw ?? undefined,
              masked: Boolean(r.masked),
              shop: r.shop ?? undefined,
              loginWall: Boolean(r.loginWall),
              captcha: Boolean(r.captcha),
              note: r.masked ? NOTE_MASK : NOTE_SKU,
              message: r.price ? undefined : '页面上没读到价格，可能被登录墙或验证页拦住',
            };
          });
        } catch (err) {
          return fail('price_failed', err.message);
        }
      },
    }),
  );

  // ---- SKU-level price: the thing that actually answers "how much is 500ml" ----
  ctx.tools.register(
    defineTool({
      name: 'shop_sku_price',
      description:
        '读一个商品链接里**每个规格各自的价**，并可按规格关键词筛出对应 SKU 的实价。'
        + '清单核价必须用这个：商品页首屏给的是最低 SKU 价，同链接换个规格能差 10 倍'
        + '（实测：缓干剂 60ml 3.8 元 / 250ml 10.3 元 / 500ml 38.8 元）。'
        + 'spec 用空格或斜杠分隔多个关键词，全部命中才算匹配，例如「500ml 钛白」。',
      parameters: {
        item: { type: 'string', required: true, description: '商品链接，或纯数字商品 id' },
        spec: { type: 'string', description: '可选：规格关键词，如「500ml」「【500ml罐装】 钛白」；不填则返回价格概览' },
        limit: { type: 'integer', description: '最多返回多少个匹配/候选 SKU，默认 12' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string' },
            title: { type: 'string' },
            shop: { type: 'string' },
            skuCount: { type: 'integer' },
            maskedCount: { type: 'integer' },
            minReal: { type: 'number' },
            maxReal: { type: 'number' },
            masked: { type: 'boolean' },
            reason: { type: 'string' },
            note: { type: 'string' },
            message: { type: 'string' },
            groups: { type: 'array', items: { type: 'string' } },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  attrs: { type: 'string' },
                  price: { type: 'string' },
                  masked: { type: 'boolean' },
                  stock: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_a, v) => {
          if (!v.ok) {
            return [{ type: 'text', text: `读取 SKU 失败：${v.reason ?? v.message ?? '-'}${v.note ? `\n⚠️ ${v.note}` : ''}` }];
          }
          const lines = (v.matches ?? []).map(
            (m) => `· ${m.attrs || '(默认)'} → ${m.masked ? `¥${m.price}（打码）` : `¥${m.price}`}${m.stock ? ` ${m.stock}` : ''}`,
          );
          const head =
            `${v.title}\n店铺 ${v.shop ?? '-'}｜SKU ${v.skuCount} 个｜可读价 ${v.minReal ?? '-'}–${v.maxReal ?? '-'}`
            + `${v.maskedCount ? `｜打码 ${v.maskedCount} 个` : ''}\n${v.url}`;
          const body = lines.length ? `\n\n${lines.join('\n')}` : `\n\n${v.message ?? '没有匹配到这个规格关键词'}`;
          const groups = (v.groups ?? []).length ? `\n\n可选规格值：${(v.groups ?? []).join(' | ')}` : '';
          return [{ type: 'text', text: `${head}${body}${groups}${v.masked ? `\n\n⚠️ ${NOTE_MASK}` : ''}` }];
        },
      },
      execute: async (args) => {
        const raw = String(args.item).trim();
        const url = /^https?:/i.test(raw) ? raw : `https://item.taobao.com/item.htm?id=${raw}`;
        const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 60);
        const tokens = String(args.spec ?? '')
          .split(/[\s,，、/|]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        try {
          return await withBrowser(opts, async (cdp) => {
            await cdp.navigate(url, 50000);
            const r = await cdp.evaluate(taobaoSkuExpr);
            if (!r?.ok) {
              return {
                ok: false,
                url,
                reason: r?.reason ?? 'extract_failed',
                note: REASON_TEXT[r?.reason],
                message: r?.reason === 'no_ice_data' ? '页面没读到 SKU 表' : undefined,
              };
            }
            const skus = (r.skus ?? []).filter((s) => s.price);
            const hits = tokens.length
              ? skus.filter((s) => tokens.every((t) => String(s.attrs || '').includes(t)))
              : skus;
            const groups = [...new Set((r.props ?? []).flatMap((p) => p.values ?? []))];
            return {
              ok: true,
              url: r.url ?? url,
              title: r.title ?? undefined,
              shop: r.shop ?? undefined,
              skuCount: r.skuCount ?? skus.length,
              maskedCount: r.maskedCount ?? 0,
              minReal: typeof r.minReal === 'number' ? r.minReal : undefined,
              maxReal: typeof r.maxReal === 'number' ? r.maxReal : undefined,
              masked: (r.maskedCount ?? 0) > 0 || Boolean(r.pagePrice && r.pagePrice.includes('?')),
              groups: tokens.length && !hits.length ? groups.slice(0, 40) : undefined,
              message: tokens.length && !hits.length ? `没有 SKU 同时包含 ${tokens.join(' + ')}` : undefined,
              matches: hits.slice(0, limit).map((s) => ({
                attrs: s.attrs || '(默认)',
                price: String(s.price),
                masked: Boolean(s.masked),
                stock: s.stock ?? undefined,
              })),
            };
          });
        } catch (err) {
          return fail('sku_failed', err.message);
        }
      },
    }),
  );

  // ---- open arbitrary url (for manual inspection by the user) ----
  ctx.tools.register(
    defineTool({
      name: 'shop_open',
      description: '在当前浏览器标签里打开一个 URL，用于把商品页/搜索结果页摆到用户面前让他自己核对。',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的 http(s) 地址' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string' },
            title: { type: 'string' },
            message: { type: 'string' },
          },
        },
        render: (_a, v) => [{ type: 'text', text: v.ok ? `已打开：${v.title || v.url}` : `打开失败：${v.message}` }],
      },
      execute: async (args) => {
        if (!/^https?:/i.test(args.url)) return fail('bad_url', '只接受 http(s) 地址');
        try {
          return await withBrowser(opts, async (cdp) => {
            const title = await cdp.navigate(args.url, 50000);
            return { ok: true, url: args.url, title: title || undefined };
          });
        } catch (err) {
          return fail('open_failed', err.message);
        }
      },
    }),
  );
}
