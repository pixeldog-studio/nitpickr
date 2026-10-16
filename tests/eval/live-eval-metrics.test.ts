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

describe("transport retries", () => {
  it("retries a case once after a transport failure", async () => {
    const { LiveReviewEvaluator, isTransportError } = await import(
      "../../src/eval/live-review-evaluator.js"
    );
    expect(isTransportError(new Error("fetch failed"))).toBe(true);
    expect(
      isTransportError(new Error("Model response must contain JSON")),
    ).toBe(false);

    let calls = 0;
    const report = await new LiveReviewEvaluator({
      transportRetryDelayMs: 0,
      model: {
        async generateStructuredReview() {
          calls += 1;
          if (calls === 1) {
            throw new Error("fetch failed");
          }
          return { summary: "ok", findings: [] };
        },
      },
    }).evaluate([
      {
        name: "retry",
        kind: "clean",
        stack: "typescript",
        expectedVerdicts: [],
        expectedFindings: [],
        input: {
          changeRequest: { title: "t", number: 1 },
          files: [
            {
              path: "a.ts",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+x",
            },
          ],
          instructionText: "",
          memory: [],
          commentBudget: 5,
          priorReviewRoundCount: 0,
          dismissals: [],
        },
      },
    ]);

    expect(calls).toBe(2);
    expect(report.cases[0]?.error).toBeNull();
  });
});

describe("rescoreReport", () => {
  it("re-matches saved findings against updated labels", async () => {
    const { rescoreReport } = await import(
      "../../src/eval/live-review-evaluator.js"
    );
    const saved = report({
      name: "case-a",
      findings: [
        { ...finding("high"), path: "a.ts", line: 10, title: "Path traversal" },
      ],
      unexpected: ["a.ts:10 [high/correctness] Path traversal"],
      publishedMediumPlus: 1,
    });
    const rescored = rescoreReport({ cases: [saved] }, [
      {
        name: "case-a",
        kind: "planted",
        stack: "python",
        expectedVerdicts: [],
        input: {} as never,
        expectedFindings: [
          { label: "path traversal", path: "a.ts", lineStart: 9, lineEnd: 11 },
        ],
      },
    ]);
    expect(rescored.totals.precisionMediumPlus).toBe(1);
    expect(rescored.cases[0]?.unexpected).toEqual([]);
  });
});

describe("resuming a run", () => {
  it("reuses completed cases and only runs the rest", async () => {
    const { LiveReviewEvaluator } = await import(
      "../../src/eval/live-review-evaluator.js"
    );
    let calls = 0;
    const fixture = (name: string) => ({
      name,
      kind: "clean" as const,
      stack: "typescript" as const,
      expectedVerdicts: [],
      expectedFindings: [],
      input: {
        changeRequest: { title: "t", number: 1 },
        files: [
          {
            path: "a.ts",
            additions: 1,
            deletions: 0,
            patch: "@@ -0,0 +1 @@\n+x",
          },
        ],
        instructionText: "",
        memory: [],
        commentBudget: 5,
        priorReviewRoundCount: 0,
      },
    });
    const progress: number[] = [];
    const result = await new LiveReviewEvaluator({
      completedCases: [report({ name: "done" })],
      model: {
        async generateStructuredReview() {
          calls += 1;
          return { summary: "s", findings: [] };
        },
      },
      onCaseDone: (_report, _index, soFar) => {
        progress.push(soFar.length);
      },
    }).evaluate([fixture("done"), fixture("todo")] as never);

    expect(calls).toBe(1);
    expect(result.cases.map((entry) => entry.name)).toEqual(["done", "todo"]);
    expect(progress).toEqual([2]);
  });
});

describe("learning pairs", () => {
  it("reports whether a repo learning changed the review", async () => {
    const { summarizeLearningPairs } = await import(
      "../../src/eval/live-review-evaluator.js"
    );
    const pairs = summarizeLearningPairs([
      report({
        name: "dismissal-control",
        kind: "learning",
        matched: [{ expected: "timeout", finding: "f" }],
        findings: [finding("medium")],
      }),
      report({ name: "dismissal-applied", kind: "learning", findings: [] }),
      report({
        name: "unchanged-control",
        kind: "learning",
        findings: [finding("medium")],
        unexpected: ["x"],
      }),
      report({
        name: "unchanged-applied",
        kind: "learning",
        findings: [finding("medium")],
        unexpected: ["x"],
      }),
    ]);

    expect(pairs.map((pair) => [pair.name, pair.learningApplied])).toEqual([
      ["dismissal", true],
      ["unchanged", false],
    ]);
  });
});

describe("dismissal filter in the eval", () => {
  it("drops findings that repeat a fixture dismissal", async () => {
    const { LiveReviewEvaluator } = await import(
      "../../src/eval/live-review-evaluator.js"
    );
    const embedder = {
      async embed(text: string) {
        const vector = new Array(32).fill(0);
        for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
          vector[word.length % 32] += 1;
        }
        return vector;
      },
    };
    const report = await new LiveReviewEvaluator({
      embedder,
      transportRetryDelayMs: 0,
      engineOptions: { requireEvidence: false },
      model: {
        async generateStructuredReview() {
          return {
            summary: "s",
            findings: [
              {
                path: "a.ts",
                line: 1,
                findingType: "bug",
                severity: "medium",
                category: "correctness",
                title: "fetch call has no timeout",
                body: "A slow upstream can hang the request.",
                fixPrompt: "Add a timeout in a.ts at line 1.",
              },
            ],
          };
        },
      },
    }).evaluate([
      {
        name: "filtered",
        kind: "learning",
        stack: "typescript",
        expectedVerdicts: [],
        expectedFindings: [],
        input: {
          changeRequest: { title: "t", number: 1 },
          files: [
            {
              path: "a.ts",
              additions: 1,
              deletions: 0,
              patch: "@@ -0,0 +1 @@\n+fetch(url)",
            },
          ],
          instructionText: "",
          memory: [],
          commentBudget: 5,
          priorReviewRoundCount: 0,
          dismissals: [
            {
              title: "fetch call has no timeout",
              body: "A slow upstream can hang the request.",
              path: "a.ts",
            },
          ],
        },
      },
    ]);

    expect(report.cases[0]?.findings).toEqual([]);
  });

  it("does not credit a learning when the control case errored", async () => {
    const { summarizeLearningPairs } = await import(
      "../../src/eval/live-review-evaluator.js"
    );
    const [pair] = summarizeLearningPairs([
      report({ name: "x-control", kind: "learning", error: "fetch failed" }),
      report({
        name: "x-applied",
        kind: "learning",
        findings: [finding("medium")],
      }),
    ]);
    expect(pair?.learningApplied).toBe(false);
  });
});
