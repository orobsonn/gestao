import { chromium } from "@playwright/test";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:5173/login", { waitUntil: "networkidle" });

await page.getByLabel(/e-mail/i).fill("admin@e2e.local");
await page.getByLabel(/^senha$/i).fill("password-e2e-ok");
await page.getByRole("button", { name: /^entrar$/i }).click();
await page
  .waitForURL((u) => !u.pathname.includes("login"), { timeout: 15000 })
  .catch(() => {});
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const all = [...document.querySelectorAll("*")];
  const wrapper = all.find((el) =>
    el.className?.toString?.().includes("sidebar-wrapper"),
  );
  const peer = document.querySelector(".peer");
  const spacer = peer?.children?.[0];
  const fixed = peer?.querySelector(".fixed");
  const mains = [...document.querySelectorAll("main")];
  const inset = mains[mains.length - 1] || mains[0];
  const card = document.querySelector(".rounded-xl.border");
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const cs = (el, prop) => (el ? getComputedStyle(el).getPropertyValue(prop) : null);
  return {
    url: location.href,
    cssVar: wrapper ? getComputedStyle(wrapper).getPropertyValue("--sidebar-width") : null,
    wrapper: { display: cs(wrapper, "display"), width: cs(wrapper, "width"), rect: rect(wrapper) },
    peer: {
      display: cs(peer, "display"),
      width: cs(peer, "width"),
      rect: rect(peer),
      cls: peer?.className?.toString().slice(0, 120),
    },
    spacer: {
      width: cs(spacer, "width"),
      rect: rect(spacer),
      cls: spacer?.className?.toString().slice(0, 160),
    },
    fixed: { width: cs(fixed, "width"), left: cs(fixed, "left"), rect: rect(fixed) },
    inset: {
      width: cs(inset, "width"),
      ml: cs(inset, "margin-left"),
      minW: cs(inset, "min-width"),
      rect: rect(inset),
      cls: inset?.className?.toString().slice(0, 200),
    },
    card: { rect: rect(card), text: card?.innerText },
  };
});

console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "scripts/layout-diag.png" });
await browser.close();
