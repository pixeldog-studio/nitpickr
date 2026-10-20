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

/**
 * Bounds that keep parsing fast on hostile input: markdown-it is quadratic on
 * a link definition followed by a huge run of spaces. Cutting the input can
 * only remove text (an opener left unclosed hides the rest), and collapsing
 * long space runs doesn't change what renders outside absurd indentation.
 * Prompts use at most a few thousand characters of any of these fields.
 */
const MAX_INPUT_CHARACTERS = 32_768;
const MAX_SPACE_RUN = 64;

export function visibleMarkdown(value: string): string {
  const bounded = value
    .slice(0, MAX_INPUT_CHARACTERS)
    .replace(new RegExp(`[ \\t]{${MAX_SPACE_RUN + 1},}`, "g"), (run) =>
      run.slice(0, MAX_SPACE_RUN),
    );
  const html = markdown.render(bounded);
  const text = serialize(parseFragment(html).childNodes, 0);
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

function children(node: Node, depth: number): string {
  return isParent(node) ? serialize(node.childNodes, depth + 1) : "";
}

function serialize(nodes: Node[], depth: number): string {
  let out = "";
  for (const node of nodes) {
    out += depth > MAX_DEPTH ? textOf(node) : serializeNode(node, depth);
  }
  return out;
}

function block(text: string): string {
  const trimmed = text.trim();
  return trimmed.length === 0 ? "" : `${trimmed}\n`;
}

function serializeNode(node: Node, depth: number): string {
  if (node.nodeName === "#text") {
    const value = "value" in node ? node.value : "";
    // Layout whitespace between block elements (`</h2>\n<ul>`).
    return /^\s*\n\s*$/.test(value) ? "" : value;
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
