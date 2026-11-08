// Runs inside the page (page.evaluate). Returns the rendered tree: boxes in page coordinates, the computed styles
// Pen can express, text runs and line boxes, images and inline SVG, plus every CSS custom property on :root
// resolved to its computed value. Kept dependency-free and side-effect-free apart from data-pen ids.
(_opts) => {
  const scrollY = window.scrollY,
    scrollX = window.scrollX;
  const px = (v) => (v === "" || v == null ? 0 : parseFloat(v) || 0);
  const vis = (cs) =>
    cs.display !== "none" &&
    cs.visibility !== "hidden" &&
    cs.visibility !== "collapse";
  const rectOf = (r) => ({
    x: r.left + scrollX,
    y: r.top + scrollY,
    w: r.width,
    h: r.height,
  });
  let seq = 0;
  // Every colour as sRGB "#RRGGBB" or "#RRGGBBAA": rgb()/rgba() parsed directly, anything else (display-p3, oklch,
  // color-mix) through a canvas, which converts to sRGB.
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const hex2 = (n) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  const norm = (c) => {
    if (!c || c === "none" || c === "transparent" || c === "rgba(0, 0, 0, 0)")
      return null;
    if (cache.has(c)) return cache.get(c);
    let out = null;
    const m =
      /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c);
    if (m) {
      const a = m[4] === undefined ? 1 : Number(m[4]);
      out =
        a === 0
          ? null
          : `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}${a < 1 ? hex2(a * 255) : ""}`;
    } else {
      cx.clearRect(0, 0, 1, 1);
      cx.fillStyle = "#000";
      cx.fillStyle = c;
      cx.fillRect(0, 0, 1, 1);
      const d = cx.getImageData(0, 0, 1, 1).data;
      out =
        d[3] === 0
          ? null
          : `#${hex2(d[0])}${hex2(d[1])}${hex2(d[2])}${d[3] < 255 ? hex2(d[3]) : ""}`;
    }
    cache.set(c, out);
    return out;
  };
  const sides = (cs, p) =>
    ["Top", "Right", "Bottom", "Left"].map((s) =>
      px(cs[`${p}${s}${p === "border" ? "Width" : ""}`]),
    );
  const style = (_el, cs) => ({
    display: cs.display,
    position: cs.position,
    flexDirection: cs.flexDirection,
    flexWrap: cs.flexWrap,
    justifyContent: cs.justifyContent,
    alignItems: cs.alignItems,
    rowGap: px(cs.rowGap),
    columnGap: px(cs.columnGap),
    padding: sides(cs, "padding"),
    border: sides(cs, "border"),
    borderColor: [
      cs.borderTopColor,
      cs.borderRightColor,
      cs.borderBottomColor,
      cs.borderLeftColor,
    ].map(norm),
    borderStyle: [
      cs.borderTopStyle,
      cs.borderRightStyle,
      cs.borderBottomStyle,
      cs.borderLeftStyle,
    ],
    radius: [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ].map((v) => px(v.split(" ")[0])),
    bg: norm(cs.backgroundColor),
    // colours inside gradients normalised to sRGB hex like every other colour
    bgImage: cs.backgroundImage.replace(
      /(rgba?|color|oklch|oklab|lab|lch|hsla?)\([^()]*\)/g,
      (c) => norm(c) || "#00000000",
    ),
    bgSize: cs.backgroundSize,
    bgPosition: cs.backgroundPosition,
    shadow: cs.boxShadow,
    opacity: parseFloat(cs.opacity),
    overflow: cs.overflowX !== "visible" || cs.overflowY !== "visible",
    transform: cs.transform,
    filter: cs.filter,
    backdrop: cs.backdropFilter || cs.webkitBackdropFilter || "none",
    color: norm(cs.color),
    fontFamily: cs.fontFamily,
    fontSize: px(cs.fontSize),
    fontWeight: cs.fontWeight,
    fontStyle: cs.fontStyle,
    lineHeight: cs.lineHeight === "normal" ? null : px(cs.lineHeight),
    letterSpacing: cs.letterSpacing === "normal" ? 0 : px(cs.letterSpacing),
    textAlign: cs.textAlign,
    textTransform: cs.textTransform,
    textDecoration: cs.textDecorationLine,
    whiteSpace: cs.whiteSpace,
    zIndex: cs.zIndex,
    objectFit: cs.objectFit,
  });
  const transform = (t, s) =>
    s === "uppercase"
      ? t.toUpperCase()
      : s === "lowercase"
        ? t.toLowerCase()
        : s === "capitalize"
          ? t.replace(/\b\p{L}/gu, (c) => c.toUpperCase())
          : t;
  const textOf = (node, cs) => {
    const raw = node.textContent;
    const pre = /pre/.test(cs.whiteSpace);
    return transform(pre ? raw : raw.replace(/\s+/g, " "), cs.textTransform);
  };
  const lineRects = (node) => {
    // Measure the visible characters only: leading/trailing whitespace would shift the box left or widen it.
    const r = document.createRange();
    const txt = node.textContent;
    const lead = txt.length - txt.trimStart().length;
    const trail = txt.length - txt.trimEnd().length;
    r.setStart(node, lead);
    r.setEnd(node, Math.max(lead, txt.length - trail));
    const rects = [...r.getClientRects()]
      .filter((q) => q.width > 0.5 && q.height > 0.5)
      .map(rectOf);
    // merge rects on the same line (same top within 2px)
    const lines = [];
    for (const q of rects) {
      const l = lines.find((m) => Math.abs(m.y - q.y) < 2);
      if (l) {
        const x2 = Math.max(l.x + l.w, q.x + q.w);
        l.x = Math.min(l.x, q.x);
        l.w = x2 - l.x;
        l.h = Math.max(l.h, q.h);
      } else lines.push({ ...q });
    }
    // A run that wraps: measure each word so every line knows its exact text (no guessing where it broke).
    if (lines.length > 1) {
      const t = node.textContent;
      const words = [...t.matchAll(/\S+/g)];
      const byLine = lines.map(() => []);
      for (const w of words) {
        const wr = document.createRange();
        wr.setStart(node, w.index);
        wr.setEnd(node, w.index + w[0].length);
        const q = [...wr.getClientRects()].find((x) => x.width > 0);
        if (!q) continue;
        const y = q.top + scrollY;
        let i = lines.findIndex((m) => Math.abs(m.y - y) < 2);
        if (i < 0)
          i = lines.reduce(
            (b, m, k) => (Math.abs(m.y - y) < Math.abs(lines[b].y - y) ? k : b),
            0,
          );
        byLine[i].push({ s: w[0], x: q.left + scrollX, r: q.right + scrollX });
      }
      lines.forEach((l, i) => {
        const ws = byLine[i];
        if (!ws.length) return;
        l.text = ws.map((w) => w.s).join(" ");
        l.x = ws[0].x;
        l.w = ws[ws.length - 1].r - ws[0].x;
      });
    }
    return lines;
  };
  // Applies an affine matrix to SVG path data: every command made absolute, H/V/S/T expanded, arcs carried
  // through with scaled radii and rotated axes (exact for rotation + uniform scale, close otherwise).
  const transformPath = (d, m) => {
    const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
    const P = (x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
    const f = (n) => Math.round(n * 1000) / 1000;
    const det = m.a * m.d - m.b * m.c;
    const sc = Math.sqrt(Math.abs(det));
    const rot = (Math.atan2(m.b, m.a) * 180) / Math.PI;
    let i = 0,
      cmd = "",
      x = 0,
      y = 0,
      sx = 0,
      sy = 0,
      px2 = 0,
      py2 = 0;
    const out = [];
    const num = () => parseFloat(toks[i++]);
    const pt = (rel) => {
      const a = num(),
        b = num();
      return rel ? [x + a, y + b] : [a, b];
    };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      if (C === "Z") {
        out.push("Z");
        x = sx;
        y = sy;
        if (i < toks.length && !/[a-zA-Z]/.test(toks[i])) cmd = "L";
        continue;
      }
      if (C === "M" || C === "L" || C === "T") {
        const [nx, ny] = pt(rel);
        const q = P(nx, ny);
        out.push(`${C === "M" ? "M" : "L"} ${f(q[0])} ${f(q[1])}`);
        if (C === "M") {
          sx = nx;
          sy = ny;
          cmd = rel ? "l" : "L";
        }
        x = nx;
        y = ny;
        px2 = x;
        py2 = y;
        continue;
      }
      if (C === "H") {
        const v = num();
        x = rel ? x + v : v;
        const q = P(x, y);
        out.push(`L ${f(q[0])} ${f(q[1])}`);
        continue;
      }
      if (C === "V") {
        const v = num();
        y = rel ? y + v : v;
        const q = P(x, y);
        out.push(`L ${f(q[0])} ${f(q[1])}`);
        continue;
      }
      if (C === "C" || C === "S") {
        let c1;
        if (C === "C") c1 = pt(rel);
        else c1 = [2 * x - px2, 2 * y - py2];
        const c2 = pt(rel),
          e2 = pt(rel);
        const [a, b, c] = [P(...c1), P(...c2), P(...e2)];
        out.push(
          `C ${f(a[0])} ${f(a[1])} ${f(b[0])} ${f(b[1])} ${f(c[0])} ${f(c[1])}`,
        );
        px2 = c2[0];
        py2 = c2[1];
        x = e2[0];
        y = e2[1];
        continue;
      }
      if (C === "Q") {
        const c1 = pt(rel),
          e2 = pt(rel);
        const [a, b] = [P(...c1), P(...e2)];
        out.push(`Q ${f(a[0])} ${f(a[1])} ${f(b[0])} ${f(b[1])}`);
        x = e2[0];
        y = e2[1];
        continue;
      }
      if (C === "A") {
        const rx = num(),
          ry = num(),
          xr = num(),
          large = num(),
          sweep = num();
        const [nx, ny] = pt(rel);
        const q = P(nx, ny);
        out.push(
          `A ${f(rx * sc)} ${f(ry * sc)} ${f(xr + rot)} ${large} ${det < 0 ? 1 - sweep : sweep} ${f(q[0])} ${f(q[1])}`,
        );
        x = nx;
        y = ny;
        continue;
      }
      i++; // unknown token: skip
    }
    return out.join(" ");
  };
  const svgShapes = (svg) => {
    const out = [];
    // <use href="#symbol"> sprites: draw the symbol's shapes with the <use>'s inherited paint.
    const SHAPES = "path,circle,ellipse,rect,line,polyline,polygon";
    const items = [...svg.querySelectorAll(SHAPES)].map((s) => ({
      s,
      ctx: null,
    }));
    let symVb = null;
    let unresolved = false;
    for (const u of svg.querySelectorAll("use")) {
      const href = u.getAttribute("href") || u.getAttribute("xlink:href") || "";
      const target = href.startsWith("#")
        ? document.getElementById(href.slice(1))
        : null;
      if (!target) {
        unresolved = true;
        continue;
      }
      if (target.viewBox?.baseVal?.width)
        symVb = [
          target.viewBox.baseVal.x,
          target.viewBox.baseVal.y,
          target.viewBox.baseVal.width,
          target.viewBox.baseVal.height,
        ];
      for (const s of target.matches(SHAPES)
        ? [target]
        : target.querySelectorAll(SHAPES))
        items.push({ s, ctx: getComputedStyle(u) });
    }
    const vb =
      !svg.viewBox?.baseVal?.width && symVb
        ? symVb
        : svg.viewBox?.baseVal?.width
          ? [
              svg.viewBox.baseVal.x,
              svg.viewBox.baseVal.y,
              svg.viewBox.baseVal.width,
              svg.viewBox.baseVal.height,
            ]
          : null;
    const complex =
      !!svg.querySelector(
        "text,image,mask,pattern,foreignObject,filter,clipPath,linearGradient,radialGradient",
      ) || unresolved;
    for (const { s, ctx } of items) {
      const own = getComputedStyle(s);
      // Inside a sprite symbol, paint that isn't set on the shape comes from the <use>.
      const attr = (n) => {
        for (
          let p = s;
          p?.tagName && p.tagName.toLowerCase() !== "svg";
          p = p.parentElement
        ) {
          const v = p.getAttribute(n);
          if (v) return v;
        }
        return null;
      };
      const pick = (n, prop) =>
        ctx && (!attr(n) || attr(n) === "currentColor") ? ctx[prop] : own[prop];
      const cs = ctx
        ? {
            display: own.display,
            fill: pick("fill", "fill"),
            stroke: pick("stroke", "stroke"),
            strokeWidth: attr("stroke-width") || ctx.strokeWidth,
            fillRule: own.fillRule,
            fillOpacity: own.fillOpacity,
            strokeOpacity: own.strokeOpacity,
            strokeLinecap: attr("stroke-linecap") || ctx.strokeLinecap,
            strokeLinejoin: attr("stroke-linejoin") || ctx.strokeLinejoin,
            opacity: own.opacity,
          }
        : own;
      if (cs.display === "none") continue;
      let d = "";
      const a = (n) => parseFloat(s.getAttribute(n) || 0);
      switch (s.tagName.toLowerCase()) {
        case "path":
          d = s.getAttribute("d") || "";
          break;
        case "circle": {
          const cx = a("cx"),
            cy = a("cy"),
            r = a("r");
          d = `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
          break;
        }
        case "ellipse": {
          const cx = a("cx"),
            cy = a("cy"),
            rx = a("rx"),
            ry = a("ry");
          d = `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
          break;
        }
        case "rect": {
          const x = a("x"),
            y = a("y"),
            w = a("width"),
            h = a("height");
          const r = Math.min(a("rx") || a("ry"), w / 2, h / 2);
          d = r
            ? `M ${x + r} ${y} H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r} V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h} H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} Z`
            : `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`;
          break;
        }
        case "line":
          d = `M ${a("x1")} ${a("y1")} L ${a("x2")} ${a("y2")}`;
          break;
        case "polyline":
        case "polygon": {
          const pts = (s.getAttribute("points") || "")
            .trim()
            .split(/[\s,]+/)
            .map(Number);
          d = pts.reduce(
            (acc, v, i) => acc + (i % 2 ? ` ${v}` : `${i ? " L" : "M"} ${v}`),
            "",
          );
          if (s.tagName.toLowerCase() === "polygon") d += " Z";
          break;
        }
      }
      // Transforms between the shape and its <svg>/<symbol>: baked into the path.
      let mtx = new DOMMatrix();
      for (
        let p = s;
        p?.tagName && !["svg", "symbol"].includes(p.tagName.toLowerCase());
        p = p.parentElement
      ) {
        const t = p.transform?.baseVal?.consolidate?.();
        if (t)
          mtx = t.matrix.multiply
            ? new DOMMatrix([
                t.matrix.a,
                t.matrix.b,
                t.matrix.c,
                t.matrix.d,
                t.matrix.e,
                t.matrix.f,
              ]).multiply(mtx)
            : mtx;
      }
      if (!mtx.isIdentity && d) d = transformPath(d, mtx);
      out.push({
        d,
        fill: cs.fill === "none" ? null : norm(cs.fill),
        fillRule: cs.fillRule,
        fillOpacity: parseFloat(cs.fillOpacity),
        stroke: cs.stroke === "none" ? null : norm(cs.stroke),
        strokeWidth: px(cs.strokeWidth),
        strokeOpacity: parseFloat(cs.strokeOpacity),
        linecap: cs.strokeLinecap,
        linejoin: cs.strokeLinejoin,
        opacity: parseFloat(cs.opacity),
      });
    }
    return { vb, shapes: out, complex };
  };
  const walk = (el, depth) => {
    const cs = getComputedStyle(el);
    if (!vis(cs)) return null;
    // closed <details>, content-visibility:hidden and similar: rendered nowhere
    if (
      el.checkVisibility &&
      !el.checkVisibility({
        contentVisibilityAuto: true,
        visibilityProperty: true,
      })
    )
      return null;
    const tag = el.tagName.toLowerCase();
    if (
      [
        "script",
        "style",
        "noscript",
        "template",
        "meta",
        "link",
        "head",
      ].includes(tag)
    )
      return null;
    const r = el.getBoundingClientRect();
    // Visually hidden (sr-only) text: a 1 px clipped box that screen readers read and nobody sees.
    if (
      r.width <= 1 &&
      r.height <= 1 &&
      (cs.overflow !== "visible" ||
        cs.clip !== "auto" ||
        cs.clipPath !== "none")
    )
      return null;
    const node = {
      id: `e${++seq}`,
      tag,
      cls: (el.getAttribute("class") || "").slice(0, 80),
      rect: rectOf(r),
      s: style(el, cs),
      kids: [],
    };
    el.setAttribute("data-pen", node.id);
    if (el.getAttribute("aria-label"))
      node.label = el.getAttribute("aria-label").slice(0, 60);
    if (tag === "img") {
      node.img = el.currentSrc || el.src;
      node.alt = el.alt;
    }
    if (tag === "video") node.img = el.poster || null;
    if (tag === "input" || tag === "textarea")
      node.value = el.value || el.placeholder || "";
    if (tag === "svg") {
      node.svg = svgShapes(el);
      return node;
    }
    if (tag === "iframe" || tag === "canvas") {
      node.raster = true;
      return node;
    }
    for (const c of el.childNodes) {
      if (c.nodeType === 3) {
        const t = c.textContent;
        if (!t.trim()) continue;
        const lines = lineRects(c);
        if (!lines.length) continue;
        node.kids.push({ text: textOf(c, cs), lines });
      } else if (c.nodeType === 1) {
        const k = walk(c, depth + 1);
        if (k) node.kids.push(k);
      }
    }
    for (const pseudo of ["::before", "::after"]) {
      const p = getComputedStyle(el, pseudo);
      if (
        p.content &&
        p.content !== "none" &&
        p.content !== "normal" &&
        vis(p)
      ) {
        const hasBox =
          p.backgroundColor !== "rgba(0, 0, 0, 0)" ||
          p.backgroundImage !== "none" ||
          px(p.borderTopWidth) > 0;
        const txt = /^["']/.test(p.content) ? p.content.slice(1, -1) : "";
        if (hasBox || txt.trim()) if (!node.pseudo) node.pseudo = [];
        node.pseudo.push({
          which: pseudo,
          text: txt,
          bg: norm(p.backgroundColor),
          bgImage: p.backgroundImage,
          w: px(p.width),
          h: p.height,
          position: p.position,
        });
      }
    }
    return node;
  };
  // :root custom properties, resolved through a probe so light-dark(), var() chains and rem resolve.
  const names = new Set();
  const collect = (rules) => {
    for (const rule of rules) {
      if (rule.style)
        for (const n of rule.style) if (n.startsWith("--")) names.add(n);
      if (rule.cssRules) collect(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      collect(sheet.cssRules);
    } catch (_e) {
      /* cross-origin */
    }
  }
  // A var that is invalid for a property falls back to inherit/initial, so the wrapper carries sentinels.
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "position:absolute;left:-9999px;top:0;width:1234.5px;color:rgb(1, 2, 3);";
  const probe = document.createElement("div");
  wrap.appendChild(probe);
  document.body.appendChild(wrap);
  const vars = {};
  const rootCs = getComputedStyle(document.documentElement);
  for (const n of names) {
    const raw = rootCs.getPropertyValue(n).trim();
    if (!raw) continue;
    probe.style.color = `var(${n})`;
    const c = getComputedStyle(probe).color;
    probe.style.color = "";
    probe.style.width = `var(${n})`;
    const w = getComputedStyle(probe).width;
    probe.style.width = "";
    vars[n] = {
      raw,
      color: c !== "rgb(1, 2, 3)" ? norm(c) : null,
      px:
        w !== "1234.5px" && w.endsWith("px") && !/%/.test(raw)
          ? parseFloat(w)
          : null,
    };
  }
  wrap.remove();
  const doc = document.documentElement;
  return {
    url: location.pathname,
    title: document.title,
    width: doc.clientWidth,
    height: Math.max(doc.scrollHeight, document.body.scrollHeight),
    htmlBg: norm(getComputedStyle(doc).backgroundColor),
    bodyBg: norm(getComputedStyle(document.body).backgroundColor),
    vars,
    tree: walk(document.body, 0),
  };
};
