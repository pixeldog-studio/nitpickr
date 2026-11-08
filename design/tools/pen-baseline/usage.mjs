// Shared by tokens-draft.mjs and build.mjs: reads the captured extracts and names every value the pages render
// after the code's own CSS custom properties when one matches, so DESIGN.md and the Pen variables speak the
// code's vocabulary. Values with no custom property get a value-derived name and are flagged in DESIGN.md.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Only screens still listed in manifest.txt count (a dropped row leaves a stale extract behind), in manifest order.
export function loadExtracts(design) {
  const dir = join(design, ".refs", "extract");
  const rows = readFileSync(
    join(design, "tools", "pen-baseline", "manifest.txt"),
    "utf8",
  )
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => l.trim().split(/\s+/)[0]);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  return rows.flatMap((screen) =>
    files
      .filter((f) => f.startsWith(`${screen}__`))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))),
  );
}

export const r2 = (n) => Math.round(n * 100) / 100;
const slug = (s) =>
  s
    .replace(/^--/, "")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
export const firstFamily = (ff) =>
  (ff || "")
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");

// The family Pen should use: config.json "fontMap" maps a CSS family (e.g. -apple-system) to the font the browser
// actually draws, either a name or { text, display, switchAt } for Apple's optical split (Text below 20 px).
let fontMap = {};
export const setFontMap = (m) => {
  fontMap = m || {};
};
export const penFamily = (ff, size) => {
  const f = firstFamily(ff);
  const m = fontMap[f];
  if (!m) return f;
  if (typeof m === "string") return m;
  if (m.opsz) {
    // One instance per optical size (design/fonts/install-sf.sh): the listed size nearest to the font size.
    const want = Math.max(m.opsz[0], Math.round(size));
    const pick = m.opsz.reduce((a, b) =>
      Math.abs(b - want) < Math.abs(a - want) ? b : a,
    );
    return `${m.prefix}${pick}`;
  }
  return size >= (m.switchAt || 20) ? m.display : m.text;
};

// Pairs light and dark nodes by extractor id (the DOM is the same; only colours change).
export function indexTree(tree) {
  const m = new Map();
  const walk = (n) => {
    if (n.id) m.set(n.id, n);
    for (const k of n.kids || []) if (k.text === undefined) walk(k);
  };
  walk(tree);
  return m;
}

// Every colour use as a light|dark pair, plus numeric uses per section.
export function collectUsage(extracts, schemes) {
  const dark = schemes.length > 1 && schemes.includes("dark");
  const colors = new Map(); // "L|D" -> count
  const num = {
    spacing: new Map(),
    rounded: new Map(),
    fontSize: new Map(),
    letterSpacing: new Map(),
    lineHeight: new Map(),
    fontWeight: new Map(),
    borderWidth: new Map(),
  };
  const fonts = new Map();
  const shadows = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const pair = (l, d) => {
    if (l || d) bump(colors, `${l || d}|${dark ? d || l : l || d}`);
  };
  for (const ex of extracts) {
    const L = ex.schemes[schemes[0]].tree;
    const D = dark ? indexTree(ex.schemes.dark.tree) : null;
    const walk = (n) => {
      const d = D ? D.get(n.id) : null;
      const s = n.s,
        ds = d ? d.s : n.s;
      if (s.bg) pair(s.bg, ds.bg);
      s.border.forEach((w, i) => {
        if (w > 0 && s.borderStyle[i] !== "none") {
          pair(s.borderColor[i], ds.borderColor[i]);
          bump(num.borderWidth, r2(w));
        }
      });
      for (const v of s.radius) if (v > 0) bump(num.rounded, r2(v));
      for (const v of s.padding) if (v > 0) bump(num.spacing, r2(v));
      if (s.rowGap > 0) bump(num.spacing, r2(s.rowGap));
      if (s.columnGap > 0) bump(num.spacing, r2(s.columnGap));
      if (s.shadow && s.shadow !== "none") bump(shadows, s.shadow);
      if (n.svg)
        n.svg.shapes.forEach((sh, i) => {
          const dsh = d?.svg ? d.svg.shapes[i] || sh : sh;
          if (sh.fill) pair(sh.fill, dsh.fill);
          if (sh.stroke) pair(sh.stroke, dsh.stroke);
        });
      const hasText =
        (n.kids || []).some((k) => k.text !== undefined) || n.value;
      if (hasText) {
        pair(s.color, ds.color);
        bump(num.fontSize, r2(s.fontSize));
        bump(num.fontWeight, String(s.fontWeight));
        if (s.letterSpacing) bump(num.letterSpacing, r2(s.letterSpacing));
        if (s.lineHeight)
          bump(
            num.lineHeight,
            Math.round((s.lineHeight / s.fontSize) * 1000) / 1000,
          );
        bump(fonts, penFamily(s.fontFamily, s.fontSize));
      }
      for (const k of n.kids || []) if (k.text === undefined) walk(k);
    };
    walk(L);
    // Gradient stops and page background
    for (const sch of [schemes[0]]) {
      const pg = ex.schemes[sch];
      if (pg.htmlBg || pg.bodyBg)
        pair(
          pg.bodyBg || pg.htmlBg,
          dark ? ex.schemes.dark.bodyBg || ex.schemes.dark.htmlBg : null,
        );
    }
  }
  return { colors, num, fonts, shadows };
}

// Custom properties -> { name, light, dark?, px?, raw } from the extracts (first page wins; :root vars are global).
export function codeVars(extracts, schemes) {
  const ex = extracts[0];
  const L = ex.schemes[schemes[0]].vars;
  const D = schemes.includes("dark") ? ex.schemes.dark.vars : L;
  return Object.entries(L).map(([k, v]) => ({
    name: k,
    light: v.color,
    dark: (D[k] || v).color,
    px: v.px,
    raw: v.raw,
  }));
}

// Names a colour pair: the custom property with the same light and dark value, preferring Tailwind @theme
// --color-* names (what `hq design tokens-check` compares), else literal-<hex>[-<hex>].
export function colorName(pairKey, vars) {
  const [l, d] = pairKey.split("|");
  const hit = vars.filter((v) => v.light === l && v.dark === d);
  const pick = hit.find((v) => v.name.startsWith("--color-")) || hit[0];
  if (pick) return slug(pick.name.replace(/^--color-/, ""));
  return l === d
    ? `literal-${l.slice(1)}`
    : `literal-${l.slice(1)}-${d.slice(1)}`;
}

// Numeric names: a custom property of that section with the same px value, else a value-derived key.
const SECTION_VARS = {
  spacing: /^--(spacing|space|gap|gutter|pad)/,
  rounded: /^--(radius|rounded)/,
  fontSize: /^--(text|font-size|fs)-/,
  letterSpacing: /^--(tracking|letter)/,
};
export function numberName(section, value, vars, tailwind) {
  const re = SECTION_VARS[section];
  if (re) {
    const hit = vars.find(
      (v) =>
        re.test(v.name) &&
        v.px != null &&
        Math.abs(v.px - value) < 0.01 &&
        !/--(text|tracking)-[\w-]+--/.test(v.name),
    );
    if (hit)
      return slug(hit.name.replace(re, "").replace(/^-/, "")) || slug(hit.name);
  }
  if (section === "spacing" && tailwind) {
    const n = value / tailwind;
    if (Math.abs(n * 2 - Math.round(n * 2)) < 0.01)
      return String(Math.round(n * 2) / 2);
  }
  if (section === "rounded" && value >= 999) return "full";
  return `${String(value).replace(".", "_")}`;
}
