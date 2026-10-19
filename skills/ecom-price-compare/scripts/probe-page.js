(() => {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const txt = (el) => (el ? norm(el.innerText || el.textContent) : '');
  const unit = document.querySelector('[class*="unit--"]');
  const priceBox = unit && unit.parentElement ? txt(unit.parentElement) : '';
  const opts = [];
  document.querySelectorAll('[class*="valueItem" i]').forEach((el) => {
    const t = txt(el);
    if (t && t.length < 60) opts.push({ cls: (el.className || '').toString().slice(0, 50), text: t });
  });
  return {
    url: location.href,
    title: document.title,
    priceBox,
    optionCount: opts.length,
    options: opts.slice(0, 80),
    iceData: (() => {
      try {
        const c = window.__ICE_APP_CONTEXT__;
        const res = c && c.loaderData && c.loaderData.home && c.loaderData.home.data && c.loaderData.home.data.res;
        return res ? { skus: (res.skuBase?.skus || []).length, props: (res.skuBase?.props || []).map((p) => p.name) } : null;
      } catch {
        return null;
      }
    })(),
    bodyHead: txt(document.body).slice(0, 700),
  };
})()
