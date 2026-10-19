// Injected into a live JD search page. Function expression: called as (thisFn)(limit).
// JD's 2024+ search cards are JS click cards: no item href, no data-sku.
// The sku hides in the customer-service link: chat.jd.com?pid=<sku>&seller=&wname=
function extractJd(limit) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  // JD double-encodes these params: decode until it stops looking like percent-encoding.
  const dec = (v) => {
    if (!v) return v;
    let s = v;
    for (let i = 0; i < 3 && /%[0-9A-Fa-f]{2}/.test(s); i++) {
      try {
        s = decodeURIComponent(s);
      } catch (e) {
        break;
      }
    }
    return s;
  };
  const cards = [...document.querySelectorAll('[class*="_card_"]')];
  const out = [];

  for (const c of cards) {
    const chat = [...c.querySelectorAll('a[href]')].find(
      (a) => (a.getAttribute('href') || '').indexOf('chat.jd.com') >= 0,
    );
    let pid = null;
    let seller = null;
    let wname = null;
    let commentNum = null;
    if (chat) {
      try {
        const u = new URL(chat.getAttribute('href'), 'https://chat.jd.com');
        pid = u.searchParams.get('pid');
        seller = dec(u.searchParams.get('seller'));
        wname = dec(u.searchParams.get('wname'));
        commentNum = dec(u.searchParams.get('commentNum'));
      } catch (e) {
        /* ignore */
      }
    }

    const text = norm(c.innerText);
    // "¥ 33 . 91 到手价 ¥35.91" -> ["33.91", "35.91"]
    const prices = [...text.matchAll(/¥\s*(\d[\d ]*(?:\.\s*\d+)?)/g)].map((m) => m[1].replace(/\s+/g, ''));
    const sold = (text.match(/已售\s*([\d.]+万?\+?)/) || [])[1] || null;
    const nameEl = c.querySelector('[title]');
    const name = norm(wname || (nameEl && nameEl.getAttribute('title')) || '').slice(0, 80);

    if (!name && !prices.length) continue;

    out.push({
      name,
      price: prices[0] || null,
      listPrice: prices[1] || null,
      sold,
      comments: commentNum,
      shop: norm(seller || ''),
      sku: pid,
      link: pid ? 'https://item.jd.com/' + pid + '.html' : null,
      ad: /^广告/.test(text),
    });
    if (out.length >= limit) break;
  }

  const body = norm(document.body.innerText);
  return {
    title: document.title,
    cards: cards.length,
    items: out,
    loginWall: /欢迎登录|请登录/.test(body.slice(0, 300)),
    blocked: /验证|滑块|安全验证/.test(body.slice(0, 300)),
    head: body.slice(0, 100),
  };
}
