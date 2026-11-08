#!/usr/bin/env node
// Prints the DESIGN.md front matter for this site from what the captured pages render (capture.mjs first):
// colours as light/dark pairs named after the code's custom properties, and every spacing, radius, type and
// border value in use, named after the code's custom properties where one matches. Values with no custom
// property are listed with a value-derived name and counted, so DESIGN.md can flag them as open questions.
// Usage: node design/tools/pen-baseline/tokens-draft.mjs [--write]   (--write replaces DESIGN.md's front matter)
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  codeVars,
  collectUsage,
  colorName,
  loadExtracts,
  numberName,
  setFontMap,
} from "./usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const design = resolve(here, "..", "..");
const cfg = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
setFontMap(cfg.fontMap);
const extracts = loadExtracts(design);
const vars = codeVars(extracts, cfg.schemes);
const use = collectUsage(extracts, cfg.schemes);
// Values the builder needed but CSS doesn't state directly (gaps made of margins, gradient stops): build.mjs
// writes them to .refs/unbound.json; they join their section, flagged.
const ub = existsSync(join(design, ".refs", "unbound.json"))
  ? JSON.parse(readFileSync(join(design, ".refs", "unbound.json"), "utf8"))
  : { colors: {}, numbers: {} };
const derived = new Set();
for (const [k, n] of Object.entries(ub.colors)) {
  use.colors.set(k, (use.colors.get(k) || 0) + n);
  derived.add(`c:${k}`);
}
for (const [sec, vals] of Object.entries(ub.numbers))
  for (const [v, n] of Object.entries(vals)) {
    if (!use.num[sec]) use.num[sec] = new Map();
    const map = use.num[sec];
    if (!map.has(+v)) derived.add(`${sec}:${+v}`);
    map.set(+v, (map.get(+v) || 0) + n);
  }
const tw = vars.find((v) => v.name === "--spacing" && v.px)?.px || null;
const out = [];
const q = (s) => `"${s}"`;
out.push(
  `name: ${q(cfg.name)}`,
  "version: 1",
  "colorSpace: srgb # computed sRGB values of the CSS the pages render (display-p3 / oklch converted by the browser)",
);
out.push(
  `# Generated from captures of origin/develop ${cfg.sha} by design/tools/pen-baseline/tokens-draft.mjs; names are the`,
);
out.push(
  "# code's CSS custom properties. `literal-*` colours and value-named numbers have no custom property: open questions.",
);
// Tailwind v4 sites: `hq design tokens-check` compares DESIGN.md `colors:` with the hex `--color-*` entries of the
// source `@theme` blocks, both ways. So `colors:` holds exactly those (rendered or not), and every other colour the
// pages render (Tailwind's built-in palette, rgba @theme values, literals) goes to `colorsExtra:`, which the Pen
// variables read too. Sites without @theme keep everything in `colors:`.
const themeHex = new Map();
const scanCss = (dir) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (
      e.name.startsWith(".") ||
      e.name === "node_modules" ||
      e.name === "dist"
    )
      continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) scanCss(p);
    else if (e.name.endsWith(".css"))
      for (const b of readFileSync(p, "utf8").matchAll(
        /@theme[^{]*\{([^}]*)\}/g,
      ))
        for (const m of b[1].matchAll(
          /--color-([\w-]+)\s*:\s*(#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?)\s*;/g,
        ))
          themeHex.set(m[1], m[2].toUpperCase());
  }
};
scanCss(join(design, "..", cfg.cssDir || "src"));
const colorEntries = [...use.colors.entries()]
  .map(([k, n]) => [colorName(k, vars), k, n])
  .sort(
    (a, b) =>
      a[0].startsWith("literal") - b[0].startsWith("literal") || b[2] - a[2],
  );
const seen = new Set();
const line = (name, key, note) => {
  const [l, dk] = key.split("|");
  return `  ${name}: ${l === dk ? q(l) : `{ light: ${q(l)}, dark: ${q(dk)} }`}  # ${note}`;
};
const main = [];
const extra = [];
for (const [name, key, n] of colorEntries) {
  if (seen.has(name)) continue;
  seen.add(name);
  const note = `${n} use(s)${name.startsWith("literal") ? ", no custom property" : ""}${derived.has(`c:${key}`) ? ", gradient stop or page background" : ""}`;
  if (!themeHex.size || themeHex.has(name)) main.push(line(name, key, note));
  else
    extra.push(
      line(
        name,
        key,
        `${note}${name.startsWith("literal") ? "" : ", not a hex @theme colour of this repo"}`,
      ),
    );
}
for (const [name, hex] of themeHex) {
  if (seen.has(name)) continue;
  seen.add(name);
  main.push(
    line(
      name,
      `${hex}|${hex}`,
      "defined in @theme, not rendered on the captured pages",
    ),
  );
}
out.push("colors:", ...main);
if (extra.length) out.push("colorsExtra:", ...extra);
out.push("typography:", "  families:");
const fam = [...use.fonts.entries()].sort((a, b) => b[1] - a[1]);
for (const [f, n] of fam)
  out.push(
    `    ${f
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")}: ${q(f)}  # ${n} text node(s)`,
  );
const section = (title, key, map, fmt = (v) => v) => {
  out.push(`${title}:`);
  const entries = [...map.entries()].sort((a, b) =>
    typeof a[0] === "number"
      ? a[0] - b[0]
      : String(a[0]).localeCompare(String(b[0])),
  );
  const names = new Set();
  for (const [v, n] of entries) {
    let name = key ? numberName(key, v, vars, tw) : String(v).replace(".", "_");
    while (names.has(name)) name += "_";
    names.add(name);
    out.push(
      `  ${/^[-\d]/.test(name) ? q(name) : name}: ${fmt(v)}  # ${n} use(s)${derived.has(`${key}:${v}`) ? ", from layout (margins/offsets), no CSS property" : ""}`,
    );
  }
};
section("fontSize", "fontSize", use.num.fontSize);
section("fontWeight", null, use.num.fontWeight, (v) => q(v));
section("lineHeight", null, use.num.lineHeight);
section("letterSpacing", "letterSpacing", use.num.letterSpacing);
section("spacing", "spacing", use.num.spacing);
section("rounded", "rounded", use.num.rounded);
section("borderWidth", null, use.num.borderWidth);
out.push("elevation:");
[...use.shadows.entries()]
  .sort((a, b) => b[1] - a[1])
  .forEach(([s, n], i) => {
    out.push(`  shadow${i + 1}: ${q(s.replace(/"/g, "'"))}  # ${n} use(s)`);
  });
const motion = vars.filter((v) =>
  /ease|duration|transition|motion/i.test(v.name),
);
out.push("motion:");
for (const v of motion)
  out.push(`  ${v.name.replace(/^--/, "")}: ${q(v.raw.replace(/"/g, "'"))}`);
if (!motion.length) out.push('  none: "no motion custom properties"');
const fmText = `---\n${out.join("\n")}\n---`;
if (process.argv.includes("--write")) {
  // Replace only the front matter of design/DESIGN.md; the prose below it is hand-written and kept.
  const file = join(design, "DESIGN.md");
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  const body =
    /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(prev)?.[1] ??
    `\n# ${cfg.name}: design rules\n`;
  writeFileSync(file, `${fmText}\n${body.replace(/^\n*/, "\n")}`);
} else console.log(fmText);
