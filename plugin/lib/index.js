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
} from './cdp.mjs';

export const name = 'ecom-price';

/** Only the tools service is required; everything else is optional. */
export const inject = ['tools'];

const NOTE_LIST =
  '淘宝搜索列表页的价格被脱敏成「4??」这类字面问号，只能用来发现候选。真实价格请用 shop_price 打开商品页读。';
const NOTE_LOGIN =
  '如果返回 loginWall=true，说明浏览器登录态失效（换网络会导致掉登录）。让用户重新扫码，不要归因为"反爬限流"。';

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
        + '价格字段不可信（被平台脱敏），只看候选与店铺；要真实价格用 shop_price 逐项读取。'
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

  // ---- real price ----
  ctx.tools.register(
    defineTool({
      name: 'shop_price',
      description:
        '打开淘宝/天猫商品页，读出真实价格与店铺名。列表页价格被脱敏，需要准确价格时必须用这个。'
        + '支持传完整商品链接或纯商品 id。',
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
            shop: { type: 'string' },
            loginWall: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_a, v) =>
          [{
            type: 'text',
            text: v.ok
              ? `${v.title}\n价格 ¥${v.price ?? '未读到'}（原样：${v.priceRaw ?? '-'}）\n店铺 ${v.shop ?? '-'}\n${v.url}`
                + (v.loginWall ? `\n⚠️ ${NOTE_LOGIN}` : '')
              : `读取失败：${v.message}`,
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
              shop: r.shop ?? undefined,
              loginWall: Boolean(r.loginWall),
              message: r.price ? undefined : '页面上没读到价格，可能被登录墙或验证页拦住',
            };
          });
        } catch (err) {
          return fail('price_failed', err.message);
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
