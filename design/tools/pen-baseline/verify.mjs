#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Verifies a Pen baseline as it is on disk (no rebuild):
//   1. exports every frame named `<id>/...` at @3x through `pen interactive` (headless, no agent, no cost) into
//      design/exports/<id>/<option>__<screen>__<state>__<scheme>.png;
//   2. diffs each export against its capture from manifest.txt with `hq design diff` (heatmaps in .refs/heat/);
//   3. prints the binding report: every fill, stroke, corner radius, font size, gap and padding in the document
//      (instance overrides included), bound to a `$variable` or hard-coded, with each exception's reason.
// Usage: node design/tools/pen-baseline/verify.mjs --pen design/<file>.pen --id GH-123 [--scale 3] [--json out.json]
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith("--"))
    args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const pen = resolve(repo, args.pen);
const id = args.id;
const scale = Number(args.scale || 3);
const hq = process.env.HQ || join(homedir(), "Developer", "hq");
if (!id || !existsSync(pen)) {
  console.error("usage: verify.mjs --pen design/<file>.pen --id GH-123");
  process.exit(1);
}

// ---------- 1. export ----------
const tmp = join(tmpdir(), `pen-verify-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const js = `ids=[];Get((n,c)=>{c.skipChildren();if(n.name&&n.name.startsWith(${JSON.stringify(`${id}/`)})){ids.push(n.id);Print("FRAME",n.id,n.name)}});Export(ids,"png",${JSON.stringify(tmp)},{scale:${scale}})`;
const cmd = `execute({ input: ${JSON.stringify(js)} })\nexit()\n`;
const r = spawnSync(
  "pen",
  ["interactive", "--in", pen, "--out", join(tmp, "scratch.pen")],
  { input: cmd, encoding: "utf8", cwd: dirname(pen), timeout: 600000 },
);
const log = (r.stdout || "") + (r.stderr || "");
const frames = [...log.matchAll(/^FRAME (\S+) (.+)$/gm)].map((m) => ({
  node: m[1],
  name: m[2].trim(),
}));
const issues = [...log.matchAll(/^- (.+)$/gm)]
  .map((m) => m[1])
  .filter((l) => !/^\s*$/.test(l));
if (!frames.length) {
  console.error(`no frames named ${id}/… exported\n${log.slice(-2000)}`);
  process.exit(1);
}
const outDir = join(repo, "design", "exports", id);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const exported = [];
let missing = 0;
for (const f of frames) {
  const file = `${f.name.split("/").slice(1).join("__")}.png`;
  const src = join(tmp, `${f.node}.png`);
  if (!existsSync(src)) {
    console.log(`MISSING export ${f.name}`);
    missing++;
    continue;
  }
  renameSync(src, join(outDir, file));
  exported.push({ ...f, file });
}
console.log(`exported ${exported.length}/${frames.length} frames to ${outDir}`);
if (issues.length) console.log(`pen reported:\n  ${issues.join("\n  ")}`);

// ---------- 2. diff against captures ----------
// manifest.txt rows: <screen>/<state> <capture path relative to design/> [note…]
// Web baselines (config.json present): frame <id>/A/<screen>/<viewport>/<scheme> pairs with
// .refs/captures/<screen>__<viewport>__<scheme>.png.
const web = existsSync(join(here, "config.json"));
const manifest = web
  ? exported.map((e) => {
      const [, , screen, vp, scheme] = e.name.split("/");
      return [e.name, `.refs/captures/${screen}__${vp}__${scheme}.png`];
    })
  : readFileSync(join(here, "manifest.txt"), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => l.trim().split(/\s+/));
const diffs = [];
for (const [key, capture] of manifest) {
  if (!capture || capture === "-") continue;
  const ex = web
    ? exported.filter((e) => e.name === key)
    : exported.filter((e) => e.name.split("/").slice(2, 4).join("/") === key);
  for (const e of ex) {
    const shot = join(repo, "design", capture);
    if (!existsSync(shot)) {
      diffs.push({ frame: e.name, capture, error: "capture missing" });
      continue;
    }
    const heat = join(repo, "design", ".refs", "heat", id, e.file);
    const d = spawnSync(
      "node",
      [
        join(hq, "scripts", "hq.mjs"),
        "design",
        "diff",
        join(outDir, e.file),
        shot,
        "--out",
        heat,
      ],
      { encoding: "utf8" },
    );
    const m = /diff_ratio=([\d.]+)/.exec(d.stdout);
    diffs.push({
      frame: e.name,
      capture,
      ratio: m ? Number(m[1]) : null,
      code: d.status,
      note: (d.stdout + d.stderr).trim().split("\n").pop(),
    });
  }
}
console.log("\nframe | capture | diff_ratio");
for (const d of diffs)
  console.log(
    `${d.frame} | ${d.capture} | ${d.ratio ?? `ERROR ${d.error || d.note}`}`,
  );

// ---------- 3. binding report ----------
const doc = JSON.parse(readFileSync(pen, "utf8"));
const KEYS = {
  fill: "fill",
  stroke: "stroke",
  cornerRadius: "radius",
  fontSize: "fontSize",
  gap: "gap",
  padding: "padding",
};
const EXTRA = {
  fontFamily: "fontFamily",
  fontWeight: "fontWeight",
  letterSpacing: "letterSpacing",
  lineHeight: "lineHeight",
};
const count = {};
const hard = [];
const isVar = (v) => typeof v === "string" && v.startsWith("$");
const values = (key, v) => {
  if (v === undefined || v === null) return [];
  if (key === "fill" || key === "stroke") {
    const list = Array.isArray(v) ? v : [v];
    return list.flatMap((f) => {
      if (typeof f === "string") return [{ v: f }];
      if (f.type === "color") return [{ v: f.color }];
      if (f.type === "gradient")
        return (f.colors || []).map((c) => ({ v: c.color }));
      return [{ v: `${f.type}:${f.url || ""}`, kind: f.type }];
    });
  }
  const list = Array.isArray(v)
    ? v
    : typeof v === "object"
      ? Object.values(v)
      : [v];
  return list.map((x) => ({ v: x }));
};
const tally = (group, key, v, path, reason) => {
  for (const { v: x, kind } of values(key, v)) {
    if (x === 0 || x === "0") continue; // zero is the absence of a value, not a value to bind
    if (!count[group]) count[group] = { bound: 0, hard: 0 };
    const c = count[group];
    if (isVar(x)) c.bound++;
    else {
      c.hard++;
      hard.push({ group, value: x, kind, path, reason: reason || "NO REASON" });
    }
  }
};
const walk = (n, path, reason) => {
  const p = `${path}/${n.name || n.id}`;
  const why = n.metadata?.reason
    ? `${n.metadata.type}: ${n.metadata.reason}`
    : reason;
  for (const [k, g] of Object.entries({ ...KEYS, ...EXTRA }))
    if (k in n) tally(g, k, n[k], p, why);
  if (n.type === "ref" && n.descendants)
    for (const [did, o] of Object.entries(n.descendants))
      for (const [k, g] of Object.entries({ ...KEYS, ...EXTRA }))
        if (k in o) tally(g, k, o[k], `${p}>${did}`, why);
  for (const c of n.children || []) walk(c, p, why);
};
for (const c of doc.children) walk(c, "", null);
console.log("\nproperty | bound | hard-coded | bound %");
const req = Object.values(KEYS);
let rb = 0,
  rh = 0;
for (const [g, c] of Object.entries(count)) {
  console.log(
    `${g}${req.includes(g) ? "" : " (extra)"} | ${c.bound} | ${c.hard} | ${((100 * c.bound) / (c.bound + c.hard)).toFixed(1)}%`,
  );
  if (req.includes(g)) {
    rb += c.bound;
    rh += c.hard;
  }
}
console.log(
  `REQUIRED (fill, stroke, radius, fontSize, gap, padding) | ${rb} | ${rh} | ${((100 * rb) / (rb + rh)).toFixed(1)}%`,
);
const byReason = {};
for (const h of hard) {
  const k = `${h.group} ${h.reason}`;
  if (!byReason[k]) byReason[k] = [];
  byReason[k].push(h);
}
if (hard.length) {
  console.log("\nexceptions (hard-coded values) by reason:");
  for (const [k, list] of Object.entries(byReason))
    console.log(
      `  ${list.length} × ${k}  e.g. ${list[0].value} at ${list[0].path}`,
    );
}
const unexplained = hard.filter(
  (h) => h.reason === "NO REASON" && req.includes(h.group),
);
console.log(
  `\nunexplained hard-coded required properties: ${unexplained.length}`,
);
if (args.json)
  writeFileSync(
    resolve(args.json),
    JSON.stringify({ frames: exported, diffs, count, hard, issues }, null, 2),
  );
rmSync(tmp, { recursive: true, force: true });
process.exit(
  missing || unexplained.length || diffs.some((d) => d.ratio == null) ? 1 : 0,
);
