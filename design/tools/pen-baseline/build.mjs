#!/usr/bin/env node
// Builds design/<file>.pen from the captured extracts (capture.mjs) and design/DESIGN.md (tokens.mjs ->
// `hq design pen-tokens`). Deterministic for the same inputs.
//  - Every fill, stroke, radius, font size/family/weight, line height, letter spacing, gap and padding is a
//    $variable whose value is the DESIGN.md token; a value with no token is reported, never silently kept.
//  - A container becomes a Pen auto-layout frame when its in-flow children sit exactly where Pen's flex rules
//    would put them (equal gaps, one cross alignment); otherwise children keep their measured positions.
//  - Light page frames are components; with a dark scheme, the dark frame is an instance of the light one with
//    the theme switched, so dark mode is the tokens' dark values, nothing else.
//  - Header and footer subtrees that repeat across pages become components (instances on every other page).
// Pen ignores $variables on width/height (pen 0.3.14), so sizes are literal measured numbers.
// Usage: node design/tools/pen-baseline/build.mjs
import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { penVariables } from "./tokens.mjs";
import {
  codeVars,
  colorName,
  indexTree,
  loadExtracts,
  numberName,
  penFamily,
  r2,
  setFontMap,
} from "./usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const design = resolve(here, "..", "..");
const repo = resolve(design, "..");
const cfg = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const ID = cfg.id;
const { variables } = penVariables(repo);
setFontMap(cfg.fontMap);
const extracts = loadExtracts(design);
const cvars = codeVars(extracts, cfg.schemes);
const tw = cvars.find((v) => v.name === "--spacing" && v.px)?.px || null;
// Dark instances only when both schemes were captured (a dark-only site captures "dark" as its one scheme).
const DARK = cfg.schemes.length > 1 && cfg.schemes.includes("dark");
const misses = new Map();
const miss = (what) => misses.set(what, (misses.get(what) || 0) + 1);
const unbound = { colors: {}, numbers: {} };

// ---------- token binding ----------
const has = (name) => Object.hasOwn(variables, name);
const colorVar = (l, d) => {
  if (!l && !d) return null;
  const key = `${l || d}|${DARK ? d || l : l || d}`;
  const name = colorName(key, cvars);
  if (has(name)) return `$${name}`;
  miss(`color ${key} (${name})`);
  unbound.colors[key] = (unbound.colors[key] || 0) + 1;
  return l || d;
};
const numVar = (section, value, key) => {
  if (!value) return 0;
  const v = r2(value);
  const k = key || numberName(section, v, cvars, tw);
  const name = `${section}-${k}`;
  if (has(name) && Math.abs(Number(variables[name].value) - v) < 0.011)
    return `$${name}`;
  // value lookup in the section (covers renamed keys)
  const hit = Object.entries(variables).find(
    ([n, x]) =>
      n.startsWith(`${section}-`) &&
      x.type === "number" &&
      Math.abs(x.value - v) < 0.011,
  );
  if (hit) return `$${hit[0]}`;
  miss(`${section} ${v}`);
  if (!unbound.numbers[section]) unbound.numbers[section] = {};
  unbound.numbers[section][v] = (unbound.numbers[section][v] || 0) + 1;
  return v;
};
const lineHeightVar = (lh, fs) =>
  lh
    ? numVar(
        "lineHeight",
        Math.round((lh / fs) * 1000) / 1000,
        String(Math.round((lh / fs) * 1000) / 1000).replace(".", "_"),
      )
    : undefined;
const weightVar = (w) => {
  const n = `fontWeight-${w}`;
  if (has(n)) return `$${n}`;
  miss(`fontWeight ${w}`);
  return String(w);
};
const familyVar = (ff, size) => {
  const f = penFamily(ff, size);
  const n = `font-${f
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`;
  if (has(n)) return `$${n}`;
  miss(`font ${f}`);
  return f;
};

// ---------- conversion ----------
let seq = 0;
const nid = (p) => `${p}${(++seq).toString(36)}`;
const _TRANSPARENT = (c) => !c;
const tagName = (n) =>
  n.label
    ? `${n.tag} "${n.label}"`
    : n.cls
      ? `${n.tag}.${n.cls.split(/\s+/)[0]}`
      : n.tag;

function fillsOf(n, d) {
  const fills = [];
  const s = n.s,
    ds = d ? d.s : s;
  if (s.bg) fills.push(colorVar(s.bg, ds.bg));
  const urls = n.bgAssets || [];
  // gradients: linear only (angle + stops); others are skipped and reported
  const grads = [
    ...(s.bgImage || "").matchAll(
      /(repeating-)?(linear|radial|conic)-gradient\(((?:[^()]|\([^()]*\))*)\)/g,
    ),
  ];
  for (const g of grads) {
    if (g[1] || g[2] === "conic") {
      miss(`gradient ${g[1] || ""}${g[2]}`);
      continue;
    }
    const parts = g[3].split(/,(?![^()]*\))/).map((p) => p.trim());
    let angle = 180;
    let center;
    if (g[2] === "radial") {
      const at = /at\s+([\d.]+)%\s+([\d.]+)%/.exec(parts[0]);
      if (!/rgba?\(|#/.test(parts[0])) parts.shift();
      if (at) center = { x: +at[1] / 100, y: +at[2] / 100 };
    }
    if (g[2] === "linear" && /deg$/.test(parts[0]))
      angle = parseFloat(parts.shift());
    else if (g[2] === "linear" && /^to /.test(parts[0])) {
      const t = parts.shift();
      angle =
        { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270 }[t] ??
        180;
    }
    const stops = parts.map((p, i) => {
      const m = /^(.*?)(?:\s+(-?[\d.]+)%)?(?:\s+-?[\d.]+%)?$/.exec(
        p.replace(/^transparent/, "rgba(0, 0, 0, 0)"),
      );
      return {
        c: m[1],
        pos:
          m[2] != null ? Number(m[2]) / 100 : i / Math.max(parts.length - 1, 1),
      };
    });
    fills.push({
      type: "gradient",
      gradientType: g[2],
      ...(g[2] === "linear" ? { rotation: angle } : center ? { center } : {}),
      colors: stops.map((st) => ({
        color: colorVar(cssColor(st.c), cssColor(st.c)),
        position: r2(st.pos),
      })),
    });
  }
  for (const u of urls) {
    if (u)
      fills.push({
        type: "image",
        url: u,
        mode: /contain/.test(s.bgSize)
          ? "contain"
          : /100% 100%/.test(s.bgSize)
            ? "stretch"
            : "cover",
      });
  }
  return fills;
}
// rgb()/rgba() inside gradients -> hex (computed styles are always rgb/rgba or color())
function cssColor(c) {
  if (/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(c || ""))
    return c.toUpperCase();
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(
    c,
  );
  if (!m) return null;
  const h = (x) => Math.round(+x).toString(16).padStart(2, "0").toUpperCase();
  const a = m[4] === undefined ? 1 : +m[4];
  return `#${h(m[1])}${h(m[2])}${h(m[3])}${a < 1 ? h(a * 255) : ""}`;
}
function shadowsOf(s) {
  if (!s.shadow || s.shadow === "none") return undefined;
  const list = s.shadow.split(/,(?![^()]*\))/).map((x) => x.trim());
  return list.map((sh) => {
    const color = /rgba?\([^)]*\)/.exec(sh);
    const nums = sh
      .replace(/rgba?\([^)]*\)/, "")
      .replace("inset", "")
      .trim()
      .split(/\s+/)
      .map(parseFloat);
    return {
      type: "shadow",
      shadowType: /inset/.test(sh) ? "inner" : "outer",
      offset: { x: nums[0] || 0, y: nums[1] || 0 },
      blur: nums[2] || 0,
      color: color ? cssColor(color[0]) || "#00000000" : "#00000040",
    };
  });
}
function strokeOf(n, d) {
  const s = n.s,
    ds = d ? d.s : s;
  const on = s.border.map(
    (w, i) => w > 0 && s.borderStyle[i] !== "none" && s.borderColor[i],
  );
  if (!on.some(Boolean)) return {};
  const i = on.findIndex(Boolean);
  const same = s.border.every((w, k) => !on[k] || w === s.border[i]);
  const color = colorVar(s.borderColor[i], ds.borderColor[i]);
  const widths = s.border.map((w, k) => (on[k] ? w : 0));
  return {
    stroke: color,
    strokeWidth:
      same && on.every(Boolean)
        ? widths[0]
        : {
            top: widths[0],
            right: widths[1],
            bottom: widths[2],
            left: widths[3],
          },
    strokeAlignment: "inner",
  };
}
function radiusOf(s, w, h) {
  const r = s.radius.map((v) => Math.min(v, Math.min(w, h) / 2 + 0.001));
  if (r.every((v) => v === 0)) return undefined;
  const bound = s.radius.map((v) => (v ? numVar("rounded", v) : 0));
  return bound.every((v) => v === bound[0]) ? bound[0] : bound;
}
const textStyle = (s, ds) => {
  const t = {
    fill: colorVar(s.color, ds.color),
    fontFamily: familyVar(s.fontFamily, s.fontSize),
    fontSize: numVar("fontSize", s.fontSize),
    fontWeight: weightVar(s.fontWeight),
  };
  if (s.lineHeight) t.lineHeight = lineHeightVar(s.lineHeight, s.fontSize);
  if (s.letterSpacing)
    t.letterSpacing = numVar("letterSpacing", s.letterSpacing);
  if (s.fontStyle === "italic") t.fontStyle = "italic";
  if (/underline/.test(s.textDecoration)) t.underline = true;
  if (/line-through/.test(s.textDecoration)) t.strikethrough = true;
  return t;
};

// A text run: one Pen text per run when it is one line or a whole paragraph of uniform style; per line otherwise.
function textNodes(run, el, d, origin, paragraph) {
  const s = el.s,
    ds = d ? d.s : s;
  const st = textStyle(s, ds);
  // Range rects are the font's content area; the CSS line box is line-height tall around it (half-leading).
  const lines = run.lines.map((q) =>
    s.lineHeight
      ? { ...q, y: q.y - (s.lineHeight - q.h) / 2, h: s.lineHeight }
      : q,
  );
  const text =
    run.text.trim() === run.text
      ? run.text
      : run.text.replace(/^\s+|\s+$/g, "");
  if (lines.length === 1) {
    const q = lines[0];
    return [
      {
        type: "text",
        id: nid("t"),
        name: text.slice(0, 40),
        content: text,
        ...st,
        x: r2(q.x - origin.x),
        y: r2(q.y - origin.y),
        _box: q,
      },
    ];
  }
  if (paragraph) {
    const _x0 = Math.min(...lines.map((q) => q.x)),
      y0 = lines[0].y;
    const right = el.rect.x + el.rect.w - s.padding[1] - s.border[1];
    const left = el.rect.x + s.padding[3] + s.border[3];
    const w = r2(right - left + 0.5);
    const align = {
      center: "center",
      right: "right",
      end: "right",
      justify: "justify",
    }[s.textAlign];
    return [
      {
        type: "text",
        id: nid("t"),
        name: text.slice(0, 40),
        content: text,
        ...st,
        textGrowth: "fixed-width",
        width: w,
        ...(align ? { textAlign: align } : {}),
        x: r2(left - origin.x),
        y: r2(y0 - origin.y),
        _box: { x: left, y: y0, w, h: lines.at(-1).y + lines.at(-1).h - y0 },
      },
    ];
  }
  // Mixed inline content: one positioned text per line, with the words the browser put on that line
  // (extract.js measures each word).
  const tt = (x) =>
    s.textTransform === "uppercase"
      ? x.toUpperCase()
      : s.textTransform === "lowercase"
        ? x.toLowerCase()
        : x;
  const out = [];
  for (const q of lines) {
    const chunk = tt(q.text || "").trim();
    if (!chunk) continue;
    out.push({
      type: "text",
      id: nid("t"),
      name: chunk.slice(0, 40),
      content: chunk,
      ...st,
      x: r2(q.x - origin.x),
      y: r2(q.y - origin.y),
      _box: q,
    });
  }
  return out;
}

const hasVisual = (n) =>
  n.s.bg ||
  (n.s.bgImage && n.s.bgImage !== "none") ||
  n.s.border.some((w, i) => w > 0 && n.s.borderStyle[i] !== "none") ||
  (n.s.shadow && n.s.shadow !== "none") ||
  n.img ||
  n.svg ||
  n.rasterAsset ||
  n.value;
const outOfFlow = (n) =>
  n.s && (n.s.position === "absolute" || n.s.position === "fixed");

// Try to express children as Pen flex layout. Returns layout props or null.
function layoutFor(n, kids) {
  if (kids.length < 2 || kids.some((k) => k.type === "text" && k._multi))
    return null;
  const s = n.s;
  const box = n.rect;
  const pad = [
    s.padding[0] + s.border[0],
    s.padding[1] + s.border[1],
    s.padding[2] + s.border[2],
    s.padding[3] + s.border[3],
  ];
  const flexRow = /flex/.test(s.display) && /^row$/.test(s.flexDirection);
  const flexCol = /flex/.test(s.display) && /^column$/.test(s.flexDirection);
  const blocks = !/flex|grid|inline/.test(s.display);
  const tries = flexRow
    ? ["horizontal"]
    : flexCol || blocks
      ? ["vertical"]
      : /grid/.test(s.display)
        ? ["vertical", "horizontal"]
        : [];
  for (const dir of tries) {
    const H = dir === "horizontal";
    const b = kids.map((k) => k._box);
    const order = b
      .map((_q, i) => i)
      .sort((i, j) => (H ? b[i].x - b[j].x : b[i].y - b[j].y));
    if (order.some((v, i) => v !== i)) continue;
    const st = (q) => (H ? q.x : q.y),
      sz = (q) => (H ? q.w : q.h),
      cst = (q) => (H ? q.y : q.x),
      csz = (q) => (H ? q.h : q.w);
    const gaps = [];
    for (let i = 1; i < b.length; i++)
      gaps.push(st(b[i]) - (st(b[i - 1]) + sz(b[i - 1])));
    if (gaps.some((g) => g < -0.5 || Math.abs(g - gaps[0]) > 0.6)) continue;
    const gap = gaps[0] < 0.5 ? 0 : gaps[0];
    const cssGap = H ? s.columnGap : s.rowGap;
    if (gap > 64 && Math.abs(gap - cssGap) >= 0.6) continue; // a position, not spacing
    const start = H ? box.x : box.y;
    const lead = st(b[0]) - start;
    // cross alignment
    const cStart = H ? box.y : box.x,
      cSize = H ? box.h : box.w;
    const offs = b.map((q) => cst(q) - cStart);
    const ends = b.map((q) => cStart + cSize - (cst(q) + csz(q)));
    const centers = b.map((q) => cst(q) + csz(q) / 2 - (cStart + cSize / 2));
    let align = null,
      cPadA = 0,
      cPadB = 0;
    if (offs.every((o) => Math.abs(o - offs[0]) < 0.6)) {
      align = "start";
      cPadA = offs[0];
    } else if (centers.every((o) => Math.abs(o - centers[0]) < 0.6)) {
      align = "center";
      cPadA = Math.max(0, 2 * centers[0]);
      cPadB = Math.max(0, -2 * centers[0]);
    } else if (ends.every((o) => Math.abs(o - ends[0]) < 0.6)) {
      align = "end";
      cPadB = ends[0];
    }
    if (!align || lead < -0.5 || cPadA < -0.5 || cPadB < -0.5) continue;
    const p = H ? [cPadA, 0, cPadB, lead] : [lead, cPadB, 0, cPadA];
    // Prefer the CSS padding where the measured offset equals it (keeps the token), else the measured value.
    const css = [pad[0], pad[1], pad[2], pad[3]];
    const fixed = p.map((v, i) =>
      Math.abs(v - css[i]) < 0.6 ? css[i] : v < 0.5 ? 0 : r2(v),
    );
    if (fixed.some((v, i) => v > 64 && Math.abs(v - css[i]) >= 0.6)) continue; // a position, not spacing
    return {
      layout: dir,
      gap: gap ? numVar("spacing", r2(gap)) : undefined,
      padding: fixed.map((v) => (v ? numVar("spacing", v) : 0)),
      alignItems: align === "start" ? undefined : align,
    };
  }
  return null;
}

// A CSS-rotated leaf (no element children): Pen box of the layout size, rotated about its top-left corner, placed
// so it lands where the browser drew it (transform-origin at the centre, the CSS default).
function rotate(node, n, origin) {
  const xf = n.xf;
  if (!xf || (n.kids || []).length) return node;
  const th = Math.atan2(xf.b, xf.a);
  const w = xf.w * Math.hypot(xf.a, xf.b);
  const h = xf.h * Math.hypot(xf.c, xf.d);
  const cx = n.rect.x + n.rect.w / 2;
  const cy = n.rect.y + n.rect.h / 2;
  const x = cx + Math.cos(th) * (-w / 2) - Math.sin(th) * (-h / 2);
  const y = cy + Math.sin(th) * (-w / 2) + Math.cos(th) * (-h / 2);
  return {
    ...node,
    x: r2(x - origin.x),
    y: r2(y - origin.y),
    width: r2(w),
    height: r2(h),
    rotation: r2((-th * 180) / Math.PI),
  };
}

function convert(n, D, origin, ctx) {
  const d = D ? D.get(n.id) : null;
  const s = n.s,
    r = n.rect;
  if (r.w < 0.5 && r.h < 0.5 && !(n.kids || []).length) return [];
  if (s.opacity === 0) return [];
  const rel = { x: r2(r.x - origin.x), y: r2(r.y - origin.y) };
  // images and rasters
  if (n.rasterAsset || n.img) {
    const url = n.rasterAsset || n.asset;
    if (!url) {
      miss(`image not saved ${n.img}`);
      return [];
    }
    const boxed =
      n.img &&
      !n.rasterAsset &&
      (s.bg ||
        s.padding.some((v) => v > 0) ||
        s.border.some((v) => v > 0) ||
        (s.shadow && s.shadow !== "none"));
    if (boxed) {
      // <img> with its own background, padding, border or shadow: a frame carrying those, the image inset by padding.
      const inset = [
        s.padding[0] + s.border[0],
        s.padding[1] + s.border[1],
        s.padding[2] + s.border[2],
        s.padding[3] + s.border[3],
      ];
      const f = {
        type: "frame",
        id: nid("f"),
        name: n.alt ? `img "${n.alt.slice(0, 40)}"` : tagName(n),
        ...rel,
        width: r2(r.w),
        height: r2(r.h),
        layout: "none",
        _box: r,
      };
      const fills = fillsOf(n, d);
      if (fills.length) f.fill = fills.length === 1 ? fills[0] : fills;
      Object.assign(f, strokeOf(n, d));
      const rad = radiusOf(s, r.w, r.h);
      if (rad !== undefined) f.cornerRadius = rad;
      const fx = shadowsOf(s);
      if (fx) f.effect = fx;
      f.children = [
        {
          type: "rectangle",
          id: nid("i"),
          name: "image",
          metadata: {
            type: "image-asset",
            reason:
              "raster image the site ships (photo, illustration or logo file)",
          },
          x: r2(inset[3]),
          y: r2(inset[0]),
          width: r2(r.w - inset[1] - inset[3]),
          height: r2(r.h - inset[0] - inset[2]),
          fill: {
            type: "image",
            url,
            mode:
              n.s.objectFit === "contain"
                ? "contain"
                : n.s.objectFit === "fill"
                  ? "stretch"
                  : "cover",
          },
        },
      ];
      return [f];
    }
    return [
      {
        type: "rectangle",
        id: nid("i"),
        name: n.alt ? `img "${n.alt.slice(0, 40)}"` : tagName(n),
        ...rel,
        width: r2(r.w),
        height: r2(r.h),
        fill: {
          type: "image",
          url,
          mode: n.rasterAsset
            ? "stretch"
            : n.s.objectFit === "contain"
              ? "contain"
              : n.s.objectFit === "fill"
                ? "stretch"
                : "cover",
        },
        ...(radiusOf(s, r.w, r.h) !== undefined
          ? { cornerRadius: radiusOf(s, r.w, r.h) }
          : {}),
        ...(s.opacity < 1 ? { opacity: s.opacity } : {}),
        _box: r,
        metadata: n.rasterAsset
          ? {
              type: "raster",
              reason: n.svg
                ? "complex inline SVG (gradients/masks/text/transforms)"
                : "element Pen cannot draw (canvas/iframe/unsupported image format)",
            }
          : {
              type: "image-asset",
              reason:
                "raster image the site ships (photo, illustration or logo file)",
            },
      },
    ];
  }
  if (n.svg) {
    const vb = n.svg.vb || [0, 0, r.w, r.h];
    const scale = r.w / vb[2];
    const ds = d?.svg ? d.svg.shapes : n.svg.shapes;
    return [
      {
        type: "frame",
        id: nid("v"),
        name: n.label ? `icon "${n.label}"` : "svg",
        ...rel,
        width: r2(r.w),
        height: r2(r.h),
        layout: "none",
        _box: r,
        children: n.svg.shapes
          .filter((sh) => sh.d)
          .map((sh, i) => ({
            type: "path",
            id: nid("p"),
            name: "path",
            geometry: sh.d,
            viewBox: vb,
            x: 0,
            y: 0,
            width: r2(r.w),
            height: r2(r.h),
            ...(sh.fill
              ? {
                  fill: colorVar(sh.fill, (ds[i] || sh).fill),
                  fillRule: sh.fillRule === "evenodd" ? "evenodd" : undefined,
                }
              : {}),
            ...(sh.stroke && sh.strokeWidth
              ? {
                  stroke: colorVar(sh.stroke, (ds[i] || sh).stroke),
                  strokeWidth: r2(sh.strokeWidth * scale),
                  strokeLinecap: sh.linecap,
                  strokeLinejoin: sh.linejoin,
                }
              : {}),
            ...(sh.opacity < 1 ? { opacity: sh.opacity } : {}),
          })),
      },
    ];
  }
  const elKids = (n.kids || []).filter((k) => k.text === undefined);
  const runs = (n.kids || []).filter((k) => k.text !== undefined);
  const visual = hasVisual(n);
  const clip = s.overflow && elKids.length > 0;
  // A box with no paint and no clip is only geometry: lift its children into the parent.
  const emit =
    visual ||
    clip ||
    s.opacity < 1 ||
    (elKids.length + runs.length > 1 && /flex|grid/.test(s.display)) ||
    n.tag === "body" ||
    ctx.keep?.has(n.tag);
  const myOrigin = emit ? { x: r.x, y: r.y } : origin;
  const paragraph = runs.length === 1 && elKids.length === 0;
  const kids = [];
  const flowKids = [];
  for (const k of n.kids || []) {
    if (k.text !== undefined) {
      const t = textNodes(k, n, d, myOrigin, paragraph);
      t.forEach((x) => {
        if (k.lines.length > 1 && !paragraph) x._multi = true;
      });
      kids.push(...t);
      flowKids.push(...t);
    } else {
      const c = convert(k, D, myOrigin, ctx);
      if (k.xf && c.length === 1) c[0] = rotate(c[0], k, myOrigin); // rotated icons and images too
      // CSS stacking: a positioned child with a z-index paints above (or below) its siblings regardless of DOM
      // order. Pen paints in child order, so those children come out of the flow and are re-ordered by z.
      const z =
        k.s && k.s.position !== "static" && /^-?\d+$/.test(k.s.zIndex)
          ? Number(k.s.zIndex)
          : 0;
      for (const x of c) if (z && x._z === undefined) x._z = z;
      if (outOfFlow(k) || z)
        c.forEach((x) => {
          x.layoutPosition = "absolute";
          x._abs = true;
        });
      kids.push(...c);
      for (const x of c) if (!x._abs) flowKids.push(x);
    }
  }
  if (n.value)
    kids.push({
      type: "text",
      id: nid("t"),
      name: n.value.slice(0, 40),
      content: n.value,
      ...textStyle(s, d ? d.s : s),
      x: r2(s.padding[3] + s.border[3]),
      y: r2((r.h - s.fontSize * 1.25) / 2),
      _box: r,
    });
  if (!emit) return kids;
  const frame = {
    type: "frame",
    id: nid("f"),
    name: tagName(n),
    ...rel,
    width: r2(r.w),
    height: r2(r.h),
    _box: r,
  };
  const fills = fillsOf(n, d);
  if (fills.length) frame.fill = fills.length === 1 ? fills[0] : fills;
  if (fills.some((f) => f && f.type === "image"))
    frame.metadata = {
      type: "image-asset",
      reason: "CSS background-image the site ships",
    };
  Object.assign(frame, strokeOf(n, d));
  const rad = radiusOf(s, r.w, r.h);
  if (rad !== undefined) frame.cornerRadius = rad;
  const fx = shadowsOf(s);
  if (fx) frame.effect = fx;
  if (s.backdrop && s.backdrop !== "none") {
    const m = /blur\(([\d.]+)px\)/.exec(s.backdrop);
    if (m)
      frame.effect = [
        ...(frame.effect || []),
        { type: "background_blur", radius: +m[1] },
      ];
  }
  if (s.opacity < 1) frame.opacity = s.opacity;
  if (clip) frame.clip = true;
  const byZ = (list) =>
    list
      .map((k, i) => [k, i])
      .sort((a, c) => (a[0]._z || 0) - (c[0]._z || 0) || a[1] - c[1])
      .map(([k]) => k);
  kids.splice(0, kids.length, ...byZ(kids));
  const lay = layoutFor(n, flowKids);
  if (lay) {
    Object.assign(
      frame,
      Object.fromEntries(
        Object.entries(lay).filter(([, v]) => v !== undefined),
      ),
    );
    // In a layout, Pen rounds text box heights: give each text a line-box frame of the measured height.
    frame.children = kids.map((k) =>
      k.type === "text" && !k.layoutPosition
        ? {
            type: "frame",
            id: nid("l"),
            name: `${k.name} (line box)`,
            layout: "vertical",
            width: k.textGrowth === "fixed-width" ? k.width : undefined,
            height: r2(k._box.h),
            children: [{ ...k, x: undefined, y: undefined }],
          }
        : k,
    );
    ctx.stats.layout++;
  } else {
    frame.layout = "none";
    frame.children = kids;
    if (kids.length) ctx.stats.absolute++;
  }
  return [rotate(frame, n, origin)];
}

// ---------- pages ----------
const strip = (o) =>
  JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith("_") ? undefined : v)));
const signature = (node) =>
  JSON.stringify(strip(node), (k, v) =>
    k === "id" || k === "x" || k === "y" ? undefined : v,
  );
const comps = new Map(); // signature -> component
const pages = [];
const stats = { layout: 0, absolute: 0 };
const order = [];
for (const ex of extracts) {
  const L = ex.schemes[cfg.schemes[0]];
  const D = DARK ? indexTree(ex.schemes.dark.tree) : null;
  const ctx = {
    stats,
    keep: new Set(["header", "footer", "nav", "main", "section"]),
  };
  const body = convert(L.tree, D, { x: 0, y: 0 }, ctx)[0];
  const name = `${ID}/A/${ex.screen}/${ex.viewport.name}`;
  // Page background: html/body colour, else the first full-width painted box.
  const bg = L.bodyBg || L.htmlBg;
  const page = {
    type: "frame",
    id: nid("P"),
    name: `${name}/${cfg.schemes[0]}`,
    reusable: DARK,
    theme: { mode: cfg.schemes[0] },
    width: L.width,
    height: L.height,
    clip: true,
    layout: "none",
    fill: bg
      ? colorVar(
          bg,
          DARK ? ex.schemes.dark.bodyBg || ex.schemes.dark.htmlBg : bg,
        )
      : undefined,
    children: body.children ? [{ ...body, name: "body" }] : [],
  };
  // Shared chrome: identical header/footer subtrees become components.
  const swap = (node) => {
    for (let i = 0; i < (node.children || []).length; i++) {
      const c = node.children[i];
      if (c.type === "frame" && /^(header|footer)\b/.test(c.name)) {
        const sig = `${ex.viewport.name}:${signature(c)}`;
        if (!comps.has(sig)) {
          comps.set(sig, {
            ...c,
            reusable: true,
            name: `${c.name.split(".")[0]} / ${ex.viewport.name}`,
            x: 0,
            y: 0,
            _first: true,
          });
        }
        const comp = comps.get(sig);
        node.children[i] = {
          type: "ref",
          id: nid("r"),
          ref: comp.id,
          name: comp.name,
          x: c.x,
          y: c.y,
          ...(c.layoutPosition ? { layoutPosition: c.layoutPosition } : {}),
        };
      } else if (c.type === "frame") swap(c);
    }
  };
  swap(page);
  pages.push(page);
  order.push({ ex, page });
}

// ---------- design system page ----------
// The page's own chrome uses the site's tokens too (nearest value), so the whole document binds.
const nearest = (section, v) => {
  const list = Object.entries(variables).filter(
    ([n, x]) => n.startsWith(`${section}-`) && x.type === "number",
  );
  if (!list.length) return v;
  list.sort((a, c) => Math.abs(a[1].value - v) - Math.abs(c[1].value - v));
  return `$${list[0][0]}`;
};
const wvar = (w) =>
  has(`fontWeight-${w}`) ? `$fontWeight-${w}` : nearestWeight(w);
const nearestWeight = (w) => {
  const l = Object.keys(variables)
    .filter((n) => n.startsWith("fontWeight-"))
    .sort(
      (a, c) => Math.abs(+a.split("-")[1] - w) - Math.abs(+c.split("-")[1] - w),
    );
  return l.length ? `$${l[0]}` : String(w);
};
const famVars = Object.entries(variables).filter(([n]) =>
  n.startsWith("font-"),
);
const ink = `$${cfg.dsInk}`,
  line = `$${cfg.dsLine || cfg.dsInk}`,
  muted = `$${cfg.dsMuted || cfg.dsInk}`;
const fam0 = famVars[0] ? `$${famVars[0][0]}` : "Inter";
const T = (content, extra = {}) => ({
  type: "text",
  id: nid("t"),
  name: content.slice(0, 40),
  content,
  fill: ink,
  fontFamily: cfg.dsFont ? `$${cfg.dsFont}` : fam0,
  fontSize: nearest("fontSize", 14),
  ...extra,
});
const V = (name, props, children) => ({
  type: "frame",
  id: nid("d"),
  name,
  layout: "vertical",
  ...props,
  children,
});
const Hz = (name, props, children) => ({
  type: "frame",
  id: nid("d"),
  name,
  layout: "horizontal",
  ...props,
  children,
});
const sp = (v) => nearest("spacing", v);
const sec = (title, children) =>
  V(`Design system / ${title}`, { gap: sp(24), width: "fill_container" }, [
    T(title, { fontSize: nearest("fontSize", 28), fontWeight: wvar(700) }),
    ...children,
  ]);
const rowsOf = (items, per) =>
  Array.from({ length: Math.ceil(items.length / per) }, (_, i) =>
    Hz(`Row ${i + 1}`, { gap: sp(24) }, items.slice(i * per, i * per + per)),
  );
const colorVars = Object.entries(variables).filter(
  ([, v]) => v.type === "color",
);
const swatch = ([name, v], theme) =>
  V(
    `Color / ${name}${theme ? ` / ${theme}` : ""}`,
    { gap: sp(6), width: 180, ...(theme ? { theme: { mode: theme } } : {}) },
    [
      {
        type: "rectangle",
        id: nid("x"),
        name: "Swatch",
        width: 180,
        height: 72,
        cornerRadius: nearest("rounded", 10),
        fill: `$${name}`,
        stroke: line,
        strokeWidth: 1,
        strokeAlignment: "inner",
      },
      T(name, { fontSize: nearest("fontSize", 12), fontWeight: wvar(600) }),
      T(
        Array.isArray(v.value)
          ? `${theme} ${v.value.find((x) => x.theme.mode === theme).value}`
          : v.value,
        { fontSize: nearest("fontSize", 11), fill: muted },
      ),
    ],
  );
const swatches = colorVars.flatMap(([n, v]) =>
  Array.isArray(v.value)
    ? [swatch([n, v], "light"), swatch([n, v], "dark")]
    : [swatch([n, v])],
);
const numSection = (prefix) =>
  Object.entries(variables)
    .filter(([n, v]) => n.startsWith(`${prefix}-`) && v.type === "number")
    .sort((a, c) => a[1].value - c[1].value);
const label = (s) =>
  T(s, {
    width: 260,
    textGrowth: "fixed-width",
    fontSize: nearest("fontSize", 12),
    fill: muted,
  });
const block = () => ({
  type: "rectangle",
  id: nid("x"),
  name: "block",
  width: 16,
  height: 16,
  fill: muted,
});
const ds = V(
  "Design system",
  {
    x: 0,
    y: 0,
    width: 1600,
    padding: sp(64),
    gap: sp(64),
    fill: `$${cfg.dsBg}`,
    theme: { mode: cfg.schemes[0] },
  },
  [
    V("Intro", { gap: sp(8) }, [
      T(`${cfg.name}: design system`, {
        fontSize: nearest("fontSize", 40),
        fontWeight: wvar(700),
      }),
      T(
        `Tokens from design/DESIGN.md, captured from origin/develop ${cfg.sha}. Every swatch, sample and bar below is a Pen variable.`,
        { fill: muted },
      ),
    ]),
    sec("Color", rowsOf(swatches, 7)),
    sec(
      "Type families",
      famVars.map(([n, v]) =>
        Hz(n, { gap: sp(24), alignItems: "center" }, [
          label(n),
          T(`${v.value}: The quick brown fox, 0123456789`, {
            fontFamily: `$${n}`,
            fontSize: nearest("fontSize", 32),
          }),
        ]),
      ),
    ),
    sec(
      "Font sizes",
      numSection("fontSize").map(([n, v]) =>
        Hz(n, { gap: sp(24), alignItems: "center" }, [
          label(`${n} · ${v.value}px`),
          T("Aa Sample text", { fontSize: `$${n}` }),
        ]),
      ),
    ),
    sec(
      "Font weights",
      Object.entries(variables)
        .filter(([n]) => n.startsWith("fontWeight-"))
        .map(([n]) =>
          T(`${n} · The quick brown fox`, {
            fontWeight: `$${n}`,
            fontSize: nearest("fontSize", 20),
          }),
        ),
    ),
    sec(
      "Spacing",
      numSection("spacing").map(([n, v]) =>
        Hz(n, { gap: sp(24), alignItems: "center" }, [
          label(`${n} · ${v.value}px`),
          Hz("Gap", { gap: `$${n}` }, [block(), block()]),
        ]),
      ),
    ),
    sec(
      "Radius",
      rowsOf(
        numSection("rounded").map(([n, v]) =>
          V(n, { gap: sp(8) }, [
            {
              type: "rectangle",
              id: nid("x"),
              name: "Shape",
              width: 120,
              height: 72,
              cornerRadius: `$${n}`,
              fill: line,
              stroke: muted,
              strokeWidth: 1,
            },
            label(`${n} · ${v.value}px`),
          ]),
        ),
        8,
      ),
    ),
    sec("Components", [
      T(
        "Shared page chrome. Every page uses instances; edit a master and every page follows.",
        { fill: muted },
      ),
      ...[...comps.values()],
    ]),
  ],
);
for (const c of comps.values()) {
  delete c._first;
}

// Lay pages out: one column per screen, viewports side by side, dark to the right.
let x = 1800;
const children = [ds];
const byScreen = new Map();
for (const { ex, page } of order) {
  if (!byScreen.has(ex.screen)) byScreen.set(ex.screen, []);
  byScreen.get(ex.screen).push(page);
}
for (const [, list] of byScreen) {
  let colW = 0;
  let px = x;
  for (const p of list) {
    p.x = px;
    p.y = 0;
    children.push(p);
    px += p.width + 80;
    if (DARK) {
      children.push({
        type: "ref",
        id: nid("D"),
        ref: p.id,
        name: p.name.replace(/\/light$/, "/dark"),
        x: px,
        y: 0,
        theme: { mode: "dark" },
      });
      px += p.width + 80;
    }
    colW = px - x;
  }
  x += colW + 200;
}

// Fonts Pen loads from design/fonts: config "fonts", plus one variable-weight entry per opsz instance.
const opszFonts = Object.values(cfg.fontMap || {})
  .filter((m) => m?.opsz)
  .flatMap((m) =>
    m.opsz.map((o) => ({
      name: `${m.prefix}${o}`,
      url: `fonts/${m.file.replace("{opsz}", o)}`,
      weight: m.wght || [100, 900],
      axes: [
        {
          tag: "wght",
          start: (m.wght || [100, 900])[0],
          end: (m.wght || [100, 900])[1],
        },
      ],
    })),
  );
const allFonts = [...(cfg.fonts || []), ...opszFonts];
const doc = {
  version: "2.21",
  themes: { mode: ["light", "dark"] },
  ...(allFonts.length ? { fonts: allFonts } : {}),
  variables,
  children,
};
const out = join(design, cfg.file);
writeFileSync(out, JSON.stringify(strip(doc)));
console.log(
  `wrote ${out}: ${pages.length} page frames${DARK ? ` (+${pages.length} dark instances)` : ""}, ${comps.size} shared components, ${Object.keys(variables).length} variables`,
);
console.log(
  `containers: ${stats.layout} auto-layout, ${stats.absolute} measured positions`,
);
// design/images is written only by capture.mjs: drop files no frame references any more (older captures).
const json = JSON.stringify(doc);
const imgDir = join(design, "images");
let pruned = 0;
if (existsSync(imgDir)) {
  for (const f of readdirSync(imgDir)) {
    if (!json.includes(`images/${f}`)) {
      unlinkSync(join(imgDir, f));
      pruned++;
    }
  }
}
if (pruned)
  console.log(`pruned ${pruned} unreferenced image(s) from design/images`);
// Accumulates across runs so the next tokens-draft keeps them (delete .refs/unbound.json to start over).
const ubFile = join(design, ".refs", "unbound.json");
const prev = existsSync(ubFile)
  ? JSON.parse(readFileSync(ubFile, "utf8"))
  : { colors: {}, numbers: {} };
for (const [k, n] of Object.entries(unbound.colors))
  prev.colors[k] = Math.max(prev.colors[k] || 0, n);
for (const [s, vals] of Object.entries(unbound.numbers))
  for (const [v, n] of Object.entries(vals)) {
    if (!prev.numbers[s]) prev.numbers[s] = {};
    prev.numbers[s][v] = Math.max(prev.numbers[s][v] || 0, n);
  }
writeFileSync(ubFile, JSON.stringify(prev, null, 2));
if (misses.size) {
  console.log(
    "UNBOUND (no DESIGN.md token; run tokens-draft.mjs again to add them):",
  );
  for (const [k, n] of misses) console.log(`  ${n} × ${k}`);
}
