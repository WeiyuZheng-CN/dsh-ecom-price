// Injected into the live Taobao search page. Must be a single function expression
// so cdp.mjs can call it as (thisFunction)(limit).
function extractTaobao(limit) {
  const itemUrl = /\/\/item\.(taobao|tmall)\.com|\/\/detail\.tmall\.com|item\.htm/;
  const priceRe = /[¥￥]\s*(\d+(?:\.\d+)?)(?:\s*[-~]\s*[¥￥]?\s*(\d+(?:\.\d+)?))?/;
  const soldRe = /(\d+(?:\.\d+)?\s*万?)\s*\+?\s*(?:人付款|人已买|人收货|件已售|已售|付款)/;

  const rows = [];
  const seen = new Set();

  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href || '';
    if (!itemUrl.test(href)) continue;
    if (seen.has(href)) continue;

    // Walk up until the block contains a price, so we capture the whole card, not one fragment.
    let box = a;
    let text = '';
    for (let i = 0; i < 6 && box; i++) {
      text = (box.innerText || '').replace(/\s+/g, ' ').trim();
      if (priceRe.test(text) || text.length > 40) break;
      box = box.parentElement;
    }
    if (!text || text.length < 6) continue;
    seen.add(href);

    const pm = text.match(priceRe);
    const sm = text.match(soldRe);
    const lines = text.split(/ {2,}| /).filter((s) => s.length > 1);
    // Shop name is usually the last short line without digits at the front.
    const shop = [...lines].reverse().find((s) => s.length <= 20 && !/^[¥￥\d]/.test(s) && !/付款|已售|包邮|退货|险/.test(s)) ?? null;

    rows.push({
      title: (a.getAttribute('title') || lines[0] || '').slice(0, 80),
      text: text.slice(0, 220),
      price: pm ? (pm[2] ? `${pm[1]}-${pm[2]}` : pm[1]) : null,
      sold: sm ? sm[1] : null,
      shop,
      link: href.split('&')[0],
    });
    if (rows.length >= limit) break;
  }

  return {
    url: location.href,
    isLoginWall: /login|passport/.test(location.href) || /亲，请登录|扫码登录|密码登录/.test(document.body.innerText.slice(0, 5000)),
    bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200),
    count: rows.length,
    items: rows,
  };
}
