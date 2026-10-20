import MarkdownIt from "markdown-it";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";

type Node = DefaultTreeAdapterMap["node"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];

/**
 * Untrusted Markdown reduced to what a reader sees on GitHub. Rendering it
 * (CommonMark, raw HTML allowed, as GitHub does) and parsing the HTML (HTML5,
 * as browsers do) drops everything GitHub shows as nothing: comments, the
 * bogus comments the HTML parser makes of `<!x>`, `</1>`, `<?…>` and CDATA,
 * and link reference definitions like `[//]: # (comment)`. Hand-written
 * patterns kept missing corners of that grammar; the parsers don't, and both
 * run in linear time.
 *
 * The result is light Markdown (headings, list bullets, quotes, code), so the
 * model still sees the structure. Attribute values (titles, alt text, link
 * targets) are dropped: a reader doesn't see them either.
 */
const markdown = new MarkdownIt({ html: true, linkify: false });

// GFM's tagfilter: GitHub escapes these tags, so their text shows and any
// comment inside them is still parsed (and hidden). Without this, parse5
// would read their contents as raw text and expose the comment.
const TAG_FILTER =
  /<(\/?)(title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext)(?=[\s/>]|$)/gi;
for (const rule of ["html_block", "html_inline"] as const) {
  markdown.renderer.rules[rule] = (tokens, index) =>
    (tokens[index]?.content ?? "").replace(TAG_FILTER, "&lt;$1$2");
}

// GFM footnote definitions: GitHub drops unreferenced ones and moves the
// rest to the end; drop them all (only a referenced note's text is lost).
markdown.block.ruler.before(
  "reference",
  "footnote_definition",
  (state, startLine, endLine, silent) => {
    const start =
      (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0);
    const max = state.eMarks[startLine] ?? 0;
    if (!/^\[\^[^\]\s]+\]:/.test(state.src.slice(start, max))) {
      return false;
    }
    if (silent) {
      return true;
    }
    // The definition runs on through lazy and indented continuation lines,
    // up to a blank line that is not followed by an indented line.
    let next = startLine + 1;
    while (next < endLine) {
      const lineStart = (state.bMarks[next] ?? 0) + (state.tShift[next] ?? 0);
      const blank = lineStart >= (state.eMarks[next] ?? 0);
      if (blank) {
        const after = next + 1;
        if (
          after < endLine &&
          (state.sCount[after] ?? 0) - state.blkIndent >= 4
        ) {
          next = after + 1;
          continue;
        }
        break;
      }
      if (
        /^\[\^[^\]\s]+\]:/.test(state.src.slice(lineStart, state.eMarks[next]))
      ) {
        break;
      }
      next += 1;
    }
    state.line = next;
    return true;
  },
  { alt: ["paragraph", "reference", "blockquote", "list"] },
);

/**
 * Bounds that keep parsing fast on hostile input. markdown-it is quadratic on
 * a link definition followed by a huge run of spaces; collapsing long runs
 * doesn't change what renders outside absurd indentation. The length cap is
 * GitHub's own limit for bodies and comments, so nothing GitHub renders is
 * cut; anything longer is cut fail-closed (see below).
 */
const MAX_INPUT_CHARACTERS = 65_536;
const MAX_SPACE_RUN = 64;

/**
 * Cutting can strand an opener whose close was past the cut, which would
 * show text GitHub hides; drop from the earliest such opener.
 */
function cutFailClosed(value: string): string {
  if (value.length <= MAX_INPUT_CHARACTERS) {
    return value;
  }
  // Back off to the last blank line: no inline construct, link title or
  // footnote spans one, so nothing hidden can straddle the cut.
  const head = value.slice(0, MAX_INPUT_CHARACTERS);
  const blank = head.search(/\n[ \t]*\n(?![\s\S]*\n[ \t]*\n)/);
  const kept = blank === -1 ? head : head.slice(0, blank);
  const comment = kept.lastIndexOf("<!--");
  const cut =
    comment !== -1 && !kept.includes("-->", comment) ? comment : kept.length;
  const tail = kept.slice(0, cut);
  const opener = tail.search(/<[!?/][^>]*$/);
  return opener === -1 ? tail : tail.slice(0, opener);
}

export function visibleMarkdown(value: string): string {
  const bounded = cutFailClosed(value).replace(
    new RegExp(`[ \\t]{${MAX_SPACE_RUN + 1},}`, "g"),
    (run) => run.slice(0, MAX_SPACE_RUN),
  );
  const html = markdown.render(bounded);
  const text = serialize(
    parseFragment(html, { scriptingEnabled: false }).childNodes,
    0,
  );
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isParent(node: Node): node is ParentNode & Node {
  return "childNodes" in node;
}

/** Deeper than this, structure is dropped and only visible text is kept. */
const MAX_DEPTH = 100;

/** Elements whose direct whitespace children are layout, not content. */
const CONTAINERS = new Set([
  "ul",
  "ol",
  "li",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "div",
  "details",
  "section",
]);

function children(node: Node, depth: number): string {
  if (!isParent(node)) {
    return "";
  }
  const container = "tagName" in node && CONTAINERS.has(node.tagName);
  return serialize(node.childNodes, depth + 1, container);
}

function serialize(nodes: Node[], depth: number, inContainer = true): string {
  let out = "";
  for (const node of nodes) {
    out +=
      depth > MAX_DEPTH
        ? textOf(node)
        : serializeNode(node, depth, inContainer);
  }
  return out;
}

function block(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

function serializeNode(
  node: Node,
  depth: number,
  inContainer: boolean,
): string {
  if (node.nodeName === "#text") {
    const value = "value" in node ? node.value : "";
    // Layout whitespace between block elements (`</h2>\n<ul>`) goes; between
    // inline elements (`**a**\n**b**`) it is a soft break and stays.
    if (/^\s*\n\s*$/.test(value)) {
      return inContainer ? "" : "\n";
    }
    return value;
  }
  if (node.nodeName === "#comment" || !("tagName" in node)) {
    return "";
  }
  const tag = node.tagName;
  if (tag === "template") {
    // Template contents are inert and never shown.
    return "";
  }
  if (tag === "br") {
    return "\n";
  }
  if (tag === "hr") {
    return "---\n";
  }
  if (/^h[1-6]$/.test(tag)) {
    const inner = children(node, depth).trim();
    return inner ? `${"#".repeat(Number(tag[1]))} ${inner}\n` : "";
  }
  if (tag === "pre") {
    const code = textOf(node).replace(/\n$/, "");
    return code ? `\`\`\`\n${code}\n\`\`\`\n` : "";
  }
  if (tag === "code") {
    const code = textOf(node);
    return code ? `\`${code}\`` : "";
  }
  if (tag === "li") {
    const inner = children(node, depth).trim().replace(/\n/g, "\n  ");
    return inner ? `- ${inner}\n` : "";
  }
  if (tag === "blockquote") {
    const inner = children(node, depth).trim();
    return inner
      ? `${inner
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n`
      : "";
  }
  if (tag === "tr") {
    const cells = isParent(node)
      ? node.childNodes
          .filter((cell) => "tagName" in cell)
          .map((cell) => children(cell, depth).trim())
      : [];
    return cells.some((cell) => cell) ? `${cells.join(" | ")}\n` : "";
  }
  if (
    ["p", "div", "ul", "ol", "table", "details", "summary", "section"].includes(
      tag,
    )
  ) {
    return block(children(node, depth));
  }
  return children(node, depth);
}

/** Visible text under a node, iteratively (no recursion limit). */
function textOf(root: Node): string {
  let out = "";
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (node.nodeName === "#text") {
      out += "value" in node ? node.value : "";
    } else if (
      node.nodeName !== "#comment" &&
      !("tagName" in node && node.tagName === "template") &&
      isParent(node)
    ) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index] as Node);
      }
    }
  }
  return out;
}
