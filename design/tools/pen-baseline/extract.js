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
    bgImage: cs.backgroundImage,
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
    const r = document.createRange();
    r.selectNodeContents(node);
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
    return lines;
  };
  const svgShapes = (svg) => {
    const out = [];
    const vb = svg.viewBox?.baseVal?.width
      ? [
          svg.viewBox.baseVal.x,
          svg.viewBox.baseVal.y,
          svg.viewBox.baseVal.width,
          svg.viewBox.baseVal.height,
        ]
      : null;
    let complex = !!svg.querySelector(
      "text,image,mask,pattern,foreignObject,use,filter,clipPath,linearGradient,radialGradient",
    );
    for (const s of svg.querySelectorAll(
      "path,circle,ellipse,rect,line,polyline,polygon",
    )) {
      const cs = getComputedStyle(s);
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
      if (
        s.getAttribute("transform") ||
        (s.parentElement &&
          s.parentElement.tagName.toLowerCase() === "g" &&
          s.parentElement.getAttribute("transform"))
      )
        complex = true;
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
