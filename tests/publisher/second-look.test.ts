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
    expect(buildEndStateLine(0, 2)).toContain("Nothing blocking");
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
