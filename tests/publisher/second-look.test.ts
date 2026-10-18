import { describe, expect, it } from "vitest";

import {
  buildEndStateLine,
  neutralizeProse,
  renderSecondLook,
} from "../../src/publisher/review-publisher.js";
import { applySeverityFloor } from "../../src/review/severity-floor.js";

describe("second look", () => {
  it("keeps model prose from breaking out of the summary", () => {
    const body =
      "Bad.\n</details>\n# Owned ![x](https://evil/p.png) cc @org/team, see `a<b>`";
    const rendered = renderSecondLook([
      {
        path: "a.ts",
        line: 1,
        title: "t",
        body,
      } as never,
    ]);
    expect(rendered).not.toContain("</details>\n#");
    expect(rendered?.match(/<\/details>/g)).toHaveLength(1);
    expect(neutralizeProse(body)).toContain("@​org");
    expect(neutralizeProse(body)).toContain("!&#91;x]");
    expect(neutralizeProse(body)).toContain("`a<b>`");
  });

  it("does not say 'no further comments' while items are listed", () => {
    expect(buildEndStateLine(0, 2)).toContain("No confirmed issues");
    expect(buildEndStateLine(0)).toContain("No further comments");
  });

  it("applies the severity floor to the second-look list", () => {
    const finding = (severity: string) =>
      ({ path: "a.ts", line: 1, severity, title: severity }) as never;
    const { kept } = applySeverityFloor(
      {
        summary: "s",
        mermaid: "",
        findings: [],
        secondLook: [finding("medium"), finding("high")],
      },
      "high",
    );
    expect(kept.secondLook?.map((entry) => entry.title)).toEqual(["high"]);
  });
});

describe("first-review headline", () => {
  it("counts unconfirmed items instead of saying nothing was found", async () => {
    const { summarizeFindingCount } = await import(
      "../../src/publisher/review-publisher.js"
    );
    expect(summarizeFindingCount([], 2)).toBe(
      "no confirmed issues; 2 unconfirmed items below.",
    );
    expect(summarizeFindingCount([])).toBe(
      "nothing worth flagging in this PR.",
    );
  });
});

describe("parsing nitpickr's own comments", () => {
  it("reads the whole first paragraph so the fix isn't lost", async () => {
    const { parseInlineCommentContext } = await import(
      "../../src/review/reviewer-chat-service.js"
    );
    const parsed = parseInlineCommentContext(
      [
        "**Fetch has no timeout**",
        "🟠 High · reliability",
        "",
        "A slow upstream hangs the request.",
        "Pass an AbortSignal with a 5 s timeout.",
        "",
        "<!-- nitpickr:fingerprint:x -->",
      ].join("\n"),
    );
    expect(parsed.body).toBe(
      "A slow upstream hangs the request. Pass an AbortSignal with a 5 s timeout.",
    );
  });
});

describe("renderFixLine", () => {
  it("states the fix without the agent prompt's file scoping", async () => {
    const { renderFixLine } = await import(
      "../../src/publisher/review-publisher.js"
    );
    expect(
      renderFixLine(
        "In `src/a.ts` around line 12, return early when the list is empty.\n\nFailure scenario: crash",
        "src/a.ts",
      ),
    ).toEqual(["**Fix:** Return early when the list is empty.", ""]);
    expect(
      renderFixLine("In src/a.ts at line 4, use a guard.", "src/a.ts"),
    ).toEqual(["**Fix:** Use a guard.", ""]);
    expect(renderFixLine("Resolve: something.", "src/a.ts")).toEqual([]);
  });
});
