import { describe, expect, it } from "vitest";

import type {
  ReviewEngineResult,
  ReviewFinding,
} from "../../src/review/review-engine.js";
import {
  applySeverityFloor,
  severityFloorForRound,
} from "../../src/review/severity-floor.js";

function makeFinding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return {
    path: "src/x.ts",
    line: 1,
    findingType: "bug",
    severity: "low",
    category: "correctness",
    title: "t",
    body: "b",
    fixPrompt: "fix at src/x.ts:1",
    ...overrides,
  } as ReviewFinding;
}

function makeResult(findings: ReviewFinding[]): ReviewEngineResult {
  return {
    summary: "summary text",
    mermaid: "flowchart TD\nA --> B",
    findings,
  };
}

describe("severityFloorForRound", () => {
  it.each([
    [0, "medium"],
    [1, "medium"],
    [2, "medium"],
    [3, "medium"],
    [4, "high"],
    [5, "high"],
    [10, "high"],
  ] as const)("round %i → floor %o", (round, expected) => {
    expect(severityFloorForRound(round)).toBe(expected);
  });
});

describe("applySeverityFloor", () => {
  const mixed = [
    makeFinding({ severity: "low", title: "nit" }),
    makeFinding({ severity: "medium", title: "warn" }),
    makeFinding({ severity: "high", title: "bug" }),
    makeFinding({ severity: "critical", title: "crit" }),
  ];

  it("returns the input unchanged when the floor is null", () => {
    const input = makeResult(mixed);
    const { kept, dropped } = applySeverityFloor(input, null);
    // Value equality is the contract; the implementation is free to return
    // the same reference or a fresh copy.
    expect(kept).toEqual(input);
    expect(kept.findings).toHaveLength(mixed.length);
    expect(dropped).toEqual([]);
  });

  it("drops 'low' findings when floor is 'medium'", () => {
    const { kept, dropped } = applySeverityFloor(makeResult(mixed), "medium");
    expect(kept.findings.map((finding) => finding.title)).toEqual([
      "warn",
      "bug",
      "crit",
    ]);
    expect(dropped.map((finding) => finding.title)).toEqual(["nit"]);
  });

  it("drops 'low' and 'medium' findings when floor is 'high'", () => {
    const { kept, dropped } = applySeverityFloor(makeResult(mixed), "high");
    expect(kept.findings.map((finding) => finding.title)).toEqual([
      "bug",
      "crit",
    ]);
    expect(dropped.map((finding) => finding.title)).toEqual(["nit", "warn"]);
  });

  it("preserves non-finding fields (summary, mermaid)", () => {
    const input = makeResult(mixed);
    const { kept } = applySeverityFloor(input, "medium");
    expect(kept.summary).toBe("summary text");
    expect(kept.mermaid).toBe("flowchart TD\nA --> B");
  });

  it("returns empty arrays when no findings cross the floor", () => {
    const onlyHigh = makeResult([
      makeFinding({ severity: "high", title: "a" }),
      makeFinding({ severity: "critical", title: "b" }),
    ]);
    const { kept, dropped } = applySeverityFloor(onlyHigh, "medium");
    expect(kept.findings).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it("drops everything when all findings are below the floor", () => {
    const onlyLow = makeResult([
      makeFinding({ severity: "low", title: "a" }),
      makeFinding({ severity: "low", title: "b" }),
    ]);
    const { kept, dropped } = applySeverityFloor(onlyLow, "high");
    expect(kept.findings).toEqual([]);
    expect(dropped).toHaveLength(2);
  });
});
