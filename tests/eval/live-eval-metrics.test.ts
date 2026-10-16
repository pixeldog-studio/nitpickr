import { describe, expect, it } from "vitest";
import {
  inferStack,
  parseCaptureReference,
} from "../../src/cli/eval-capture-command.js";
import {
  isNit,
  type LiveCaseReport,
  summarizeCases,
} from "../../src/eval/live-review-evaluator.js";

function report(overrides: Partial<LiveCaseReport>): LiveCaseReport {
  return {
    name: "case",
    source: null,
    kind: "planted",
    stack: "typescript",
    matchedMediumPlus: 0,
    publishedMediumPlus: 0,
    nitCount: 0,
    verdictsExpected: 0,
    verdictsCorrect: 0,
    durationMs: 1_000,
    modelCalls: 1,
    promptTokens: null,
    completionTokens: null,
    estimatedPromptTokens: 0,
    chunkCount: 1,
    precision: 1,
    recall: 1,
    matched: [],
    missed: [],
    unexpected: [],
    summary: "",
    findings: [],
    error: null,
    ...overrides,
  };
}

const finding = (severity: "low" | "medium" | "high") => ({
  path: "a.ts",
  line: 1,
  severity,
  category: "correctness" as const,
  findingType: "bug" as const,
  title: "t",
  body: "b",
});

describe("live eval metrics", () => {
  it("treats low severity and style as nits", () => {
    expect(isNit({ severity: "low", category: "correctness" })).toBe(true);
    expect(isNit({ severity: "high", category: "style" })).toBe(true);
    expect(isNit({ severity: "medium", category: "security" })).toBe(false);
  });

  it("computes medium+ precision, clean-case false positives and verdicts", () => {
    const totals = summarizeCases([
      report({
        matched: [{ expected: "bug", finding: "f" }],
        findings: [finding("high"), finding("low")],
        unexpected: ["nit"],
        matchedMediumPlus: 1,
        publishedMediumPlus: 1,
        nitCount: 1,
        durationMs: 3_000,
      }),
      report({
        kind: "clean",
        findings: [finding("medium")],
        unexpected: ["fp"],
        publishedMediumPlus: 1,
        verdictsExpected: 2,
        verdictsCorrect: 1,
        durationMs: 1_000,
      }),
    ]);

    expect(totals.precisionMediumPlus).toBe(0.5);
    expect(totals.precision).toBeCloseTo(1 / 3);
    expect(totals.nitCount).toBe(1);
    expect(totals.cleanCaseFalsePositives).toBe(1);
    expect(totals.verdictAccuracy).toBe(0.5);
    expect(totals.medianCaseMs).toBe(2_000);
  });
});

describe("capture references", () => {
  it("parses pull requests and commits", () => {
    expect(parseCaptureReference("o/r#12")).toEqual({
      kind: "pull",
      owner: "o",
      repo: "r",
      number: 12,
    });
    expect(parseCaptureReference("o/r@abc1234")).toEqual({
      kind: "commit",
      owner: "o",
      repo: "r",
      sha: "abc1234",
    });
    expect(
      parseCaptureReference("https://github.com/o/r/commit/abc1234def"),
    ).toMatchObject({ kind: "commit", sha: "abc1234def" });
  });

  it("infers the dominant stack from paths", () => {
    expect(inferStack(["a.swift", "b.swift", "c.ts"])).toBe("swift");
    expect(inferStack(["README.md"])).toBe("other");
  });
});
