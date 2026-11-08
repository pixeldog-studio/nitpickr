#!/usr/bin/env node
import { createHash } from "node:crypto";
// Captures every route in manifest.txt from a local server running this worktree's build:
//   design/.refs/captures/<screen>__<viewport>__<scheme>.png   full-page screenshot (DPR 1)
//   design/.refs/extract/<screen>__<viewport>.json            rendered tree, light + dark (same DOM, paired by id)
//   design/images/<sha1>.<ext>                                 every image the pages render (committed: the .pen uses them)
// Usage: node design/tools/pen-baseline/capture.mjs --base http://127.0.0.1:4321 [--only home]
// Needs Playwright: PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs (any 1.5x; not a repo dependency).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--"))
    args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const here = dirname(fileURLToPath(import.meta.url));
const design = resolve(here, "..", "..");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
// extract.js is one arrow-function expression; a formatter may add a trailing semicolon.
const extractSrc = readFileSync(join(here, "extract.js"), "utf8")
  .trim()
  .replace(/;$/, "");
const cfg = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
// manifest rows: <screen> <path> [note…]
const rows = readFileSync(join(here, "manifest.txt"), "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("#"))
  .map((l) => l.trim().split(/\s+/));
const base = args.base || cfg.base;
for (const d of ["captures", "extract"])
  mkdirSync(join(design, ".refs", d), { recursive: true });
mkdirSync(join(design, "images"), { recursive: true });

const FREEZE = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}`;
const browser = await chromium.launch();
const saved = new Map();
const saveAsset = async (page, url) => {
  if (!url || (url.startsWith("data:") && url.length > 2_000_000)) return null;
  if (saved.has(url)) return saved.get(url);
  let buf, type;
  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (!m) return null;
    type = m[1];
    buf = m[2]
      ? Buffer.from(m[3], "base64")
      : Buffer.from(decodeURIComponent(m[3]));
  } else {
    const r = await page.request.get(url).catch(() => null);
    if (!r?.ok()) {
      saved.set(url, null);
      return null;
    }
    buf = await r.body();
    type = (r.headers()["content-type"] || "").split(";")[0];
  }
  const ext =
    {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/gif": "gif",
      "image/avif": "avif",
    }[type] || (url.split("?")[0].split(".").pop() || "bin").slice(0, 4);
  const name = `${createHash("sha1").update(buf).digest("hex").slice(0, 16)}.${ext}`;
  const file = join(design, "images", name);
  if (!existsSync(file)) writeFileSync(file, buf);
  saved.set(url, `images/${name}`);
  return `images/${name}`;
};
const urlsIn = (bgImage) =>
  [...(bgImage || "").matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]);
const assets = async (page, node, ctx, out) => {
  if (!node || node.text !== undefined) return;
  if (node.img) node.asset = await saveAsset(page, node.img);
  const bgs = urlsIn(node.s?.bgImage);
  if (bgs.length)
    node.bgAssets = await Promise.all(
      bgs.map((u) => saveAsset(page, new URL(u, page.url()).href)),
    );
  // Things Pen can't draw as vectors: complex SVG, canvas, iframes, AVIF/unsupported images -> raster of the element.
  const raster =
    node.raster ||
    (node.svg && (node.svg.complex || !node.svg.shapes.length)) ||
    (node.asset && /\.(avif|gif|bin|svg)$/.test(node.asset));
  if (raster && node.rect.w >= 1 && node.rect.h >= 1) {
    const el = page.locator(`[data-pen="${node.id}"]`).first();
    const buf = await el
      .screenshot({
        omitBackground: true,
        animations: "disabled",
        timeout: 10000,
      })
      .catch(() => null);
    if (buf) {
      const name = `${createHash("sha1").update(buf).digest("hex").slice(0, 16)}.png`;
      writeFileSync(join(design, "images", name), buf);
      node.rasterAsset = `images/${name}`;
      out.rasters++;
    }
  }
  for (const k of node.kids || []) await assets(page, k, ctx, out);
};

const only = args.only ? new Set(args.only.split(",")) : null;
for (const [screen, path] of rows) {
  if (only && !only.has(screen)) continue;
  for (const vp of cfg.viewports) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale: cfg.locale || "en-US",
    });
    const page = await ctx.newPage();
    const url = new URL(path, base).href;
    const res = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    if (!res?.ok()) {
      console.log(`FAIL ${screen} ${vp.name} ${url} -> ${res?.status()}`);
      await ctx.close();
      continue;
    }
    await page.addStyleTag({ content: FREEZE });
    for (const css of cfg.captureCss || [])
      await page.addStyleTag({ content: css });
    // Walk the page once so lazy images and reveal-on-scroll content load, then return to the top.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(400);
    const out = { screen, path, viewport: vp, schemes: {}, rasters: 0 };
    for (const scheme of cfg.schemes) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
      await page.waitForTimeout(250);
      const shot = join(
        design,
        ".refs",
        "captures",
        `${screen}__${vp.name}__${scheme}.png`,
      );
      await page.screenshot({
        path: shot,
        fullPage: true,
        animations: "disabled",
      });
      const data = await page.evaluate(
        `(${extractSrc})(${JSON.stringify({})})`,
      );
      out.schemes[scheme] = data;
    }
    await page.emulateMedia({
      colorScheme: cfg.schemes[0],
      reducedMotion: "reduce",
    });
    await assets(page, out.schemes[cfg.schemes[0]].tree, ctx, out);
    writeFileSync(
      join(design, ".refs", "extract", `${screen}__${vp.name}.json`),
      JSON.stringify(out),
    );
    const d = out.schemes[cfg.schemes[0]];
    console.log(
      `ok ${screen} ${vp.name} ${d.width}x${d.height} rasters=${out.rasters}`,
    );
    await ctx.close();
  }
}
await browser.close();
