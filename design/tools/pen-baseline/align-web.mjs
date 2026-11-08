#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Per-element alignment for the web frames (rules/design-fidelity.md's check, adapted): every text line and image
// the extractor recorded becomes an element box; align.py finds the shift that best maps the Pen export onto the
// capture inside that box. Run verify.mjs first (it writes design/exports/<id>/).
// Usage: node design/tools/pen-baseline/align-web.mjs <python with numpy+pillow>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtracts } from "./usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const design = resolve(here, "..", "..");
const cfg = JSON.parse(readFileSync(join(here, "config.json"), "utf8"));
const py = process.argv[2] || "python3";
mkdirSync(join(design, ".refs", "ax"), { recursive: true });
let total = 0;
let within = 0;
let worst = 0;
const rows = [];
for (const ex of loadExtracts(design)) {
  const data = ex.schemes[cfg.schemes[0]];
  const els = [];
  const walk = (n) => {
    for (const k of n.kids || []) {
      if (k.text !== undefined) {
        for (const q of k.lines)
          els.push({
            frame: { x: q.x, y: q.y, width: q.w, height: q.h },
            AXLabel: k.text.trim().slice(0, 38),
          });
      } else {
        if (k.img || k.svg)
          els.push({
            frame: {
              x: k.rect.x,
              y: k.rect.y,
              width: k.rect.w,
              height: k.rect.h,
            },
            AXLabel: `<${k.tag}>`,
          });
        walk(k);
      }
    }
  };
  walk(data.tree);
  for (const scheme of cfg.schemes) {
    const key = `${ex.screen}__${ex.viewport.name}__${scheme}`;
    const ax = join(design, ".refs", "ax", `${key}.ax.json`);
    writeFileSync(ax, JSON.stringify(els));
    // align.py works in @3x pixels of point coordinates; these captures are 1x, so scale the boxes by 1/3.
    const scaled = els.map((e) => ({
      ...e,
      frame: {
        x: e.frame.x / 3,
        y: e.frame.y / 3,
        width: e.frame.width / 3,
        height: e.frame.height / 3,
      },
    }));
    writeFileSync(ax, JSON.stringify(scaled));
    const r = spawnSync(
      py,
      [
        join(here, "align.py"),
        join(design, ".refs", "captures", `${key}.png`),
        join(design, "exports", cfg.id, `A__${key}.png`),
        ax,
        String(data.width / 3),
        String(data.height / 3),
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const lines = r.stdout.split("\n").filter((l) => /dx=/.test(l));
    const ok = lines.filter((l) => !/out of tolerance/.test(l)).length;
    const w = Number(/worst shift: (\d+)/.exec(r.stdout)?.[1] || 0);
    total += lines.length;
    within += ok;
    worst = Math.max(worst, w);
    rows.push(`${key} | ${ok}/${lines.length} within 1 px | worst ${w} px`);
  }
}
console.log(rows.join("\n"));
console.log(
  `TOTAL ${within}/${total} elements within 1 px (${((100 * within) / Math.max(total, 1)).toFixed(1)}%), worst shift ${worst} px (search radius 6)`,
);
