const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({
    viewport: { width: 1366, height: 768 }
  });

  await page.goto("http://127.0.0.1:8787/online.html", {
    waitUntil: "domcontentloaded",
    timeout: 15000
  }).catch(() => {});

  const result = await page.evaluate(() => {
    const selectors = [
      "html", "body", "header", "main", ".topbar",
      ".layout", ".boardwrap", "#board", ".controls",
      ".hint", ".side"
    ];

    return {
      viewport: {
        width: innerWidth,
        height: innerHeight,
        scrollHeight: document.documentElement.scrollHeight
      },
      elements: selectors.map(selector => {
        const el = document.querySelector(selector);
        if (!el) return { selector, missing: true };

        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);

        return {
          selector,
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          height: Math.round(r.height),
          scrollHeight: el.scrollHeight,
          overflowY: s.overflowY,
          display: s.display
        };
      })
    };
  });

  console.log(JSON.stringify(result, null, 2));
  await page.screenshot({
    path: "gravity-go-layout-diagnostic.png",
    fullPage: true
  });

  console.log("Diagnóstico guardado en gravity-go-layout-diagnostic.png");
  console.log("Cierra el navegador cuando hayas revisado el resultado.");
})();
