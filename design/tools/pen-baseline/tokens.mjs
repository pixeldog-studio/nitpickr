// DESIGN.md front matter -> Pen variables. Colours come from `hq design pen-tokens` (the converter the design flow
// mandates); every other token section is flattened to number/string variables named `<section>-<key>` and
// `text-<role>-<prop>`. No dependencies: the front matter uses a small YAML subset (nested maps, inline
// `{ k: v }` maps, numbers, quoted or bare strings, comments).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stripComment = (v) => {
  let q = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(v[i - 1])))
      return v.slice(0, i).trimEnd();
  }
  return v.trimEnd();
};
const scalar = (v) => {
  const s = v.trim();
  if (/^(["']).*\1$/.test(s)) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
};
const flowMap = (s) => {
  const out = {};
  const body = s.trim().replace(/^\{/, "").replace(/\}$/, "");
  let depth = 0,
    q = null,
    cur = "";
  const parts = [];
  for (const c of body) {
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const i = p.indexOf(":");
    out[p.slice(0, i).trim()] = scalar(p.slice(i + 1));
  }
  return out;
};

export function frontMatter(md) {
  const m = /^---\n([\s\S]*?)\n---/.exec(md.replace(/\r\n?/g, "\n"));
  if (!m) throw new Error("DESIGN.md has no front matter");
  const root = {};
  const stack = [{ indent: -1, obj: root }];
  for (const raw of m[1].split("\n")) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const mm = /^\s*([^:]+?):\s*(.*)$/.exec(line);
    if (!mm) continue;
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).obj;
    const [, rawKey, rest] = mm;
    const key = String(scalar(rawKey));
    if (rest === "") {
      parent[key] = {};
      stack.push({ indent, obj: parent[key] });
    } else if (rest.startsWith("{")) parent[key] = flowMap(rest);
    else parent[key] = scalar(rest);
  }
  return root;
}

const hq = () => process.env.HQ || join(homedir(), "Developer", "hq");

// Colours: `hq design pen-tokens <repoDir>` (sRGB, P3 converted when DESIGN.md declares display-p3).
export function penColorTokens(repoDir) {
  const out = execFileSync(
    "node",
    [join(hq(), "scripts", "hq.mjs"), "design", "pen-tokens", repoDir],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

// Returns { variables, fm }. Colour variables are themed on the `mode` axis when light and dark differ.
export function penVariables(
  repoDir,
  { skip = ["colors", "name", "version", "colorSpace", "colorsExtra"] } = {},
) {
  const fm = frontMatter(
    readFileSync(join(repoDir, "design", "DESIGN.md"), "utf8"),
  );
  const variables = {};
  for (const [name, v] of Object.entries(penColorTokens(repoDir))) {
    variables[name] =
      v.light === v.dark
        ? { type: "color", value: v.light }
        : {
            type: "color",
            value: [
              { value: v.light, theme: { mode: "light" } },
              { value: v.dark, theme: { mode: "dark" } },
            ],
          };
  }
  // colorsExtra: colours outside the code's token source (literals, framework palette); same format as colors.
  const hexOf = (v) =>
    /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(String(v))
      ? String(v).toUpperCase()
      : null;
  for (const [name, v] of Object.entries(fm.colorsExtra || {})) {
    const light = typeof v === "object" ? hexOf(v.light) : hexOf(v);
    const dark = typeof v === "object" ? hexOf(v.dark || v.light) : light;
    if (!light) continue;
    variables[name] =
      light === dark
        ? { type: "color", value: light }
        : {
            type: "color",
            value: [
              { value: light, theme: { mode: "light" } },
              { value: dark, theme: { mode: "dark" } },
            ],
          };
  }
  const put = (name, value) => {
    if (typeof value === "number") variables[name] = { type: "number", value };
    else if (typeof value === "string")
      variables[name] = { type: "string", value };
  };
  const typo = fm.typography || {};
  for (const [k, v] of Object.entries(typo.families || {})) put(`font-${k}`, v);
  for (const [role, spec] of Object.entries(typo)) {
    if (role === "families" || typeof spec !== "object") continue;
    put(`text-${role}-size`, spec.size);
    put(`text-${role}-weight`, String(spec.weight));
    // Pen letter spacing = code tracking + the tracking iOS adds itself (systemTracking, the fonts' trak table).
    if (spec.tracking !== undefined || spec.systemTracking)
      put(
        `text-${role}-tracking`,
        Math.round(((spec.tracking || 0) + (spec.systemTracking || 0)) * 100) /
          100,
      );
    // Pen's lineHeight is a multiple of the font size.
    if (spec.lineHeight !== undefined)
      put(
        `text-${role}-lineHeight`,
        Math.round((spec.lineHeight / spec.size) * 10000) / 10000,
      );
  }
  for (const [section, entries] of Object.entries(fm)) {
    if (
      skip.includes(section) ||
      section === "typography" ||
      typeof entries !== "object"
    )
      continue;
    for (const [k, v] of Object.entries(entries)) put(`${section}-${k}`, v);
  }
  return { variables, fm };
}

// The text-role properties of a node: every value bound to its variable.
export function textRole(fm, role) {
  const spec = fm.typography[role];
  if (!spec) throw new Error(`no typography role ${role}`);
  const t = {
    fontFamily: `$font-${spec.family}`,
    fontSize: `$text-${role}-size`,
    fontWeight: `$text-${role}-weight`,
  };
  if (spec.tracking !== undefined || spec.systemTracking)
    t.letterSpacing = `$text-${role}-tracking`;
  if (spec.lineHeight !== undefined) t.lineHeight = `$text-${role}-lineHeight`;
  return t;
}
