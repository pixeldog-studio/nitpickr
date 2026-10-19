import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LiveReviewEvaluator,
  liveEvaluationFixtureSchema,
  loadLiveEvaluationFixtures,
  matchFindings,
  UsageTracker,
} from "../../src/eval/live-review-evaluator.js";
import type {
  ReviewFinding,
  ReviewModel,
} from "../../src/review/review-engine.js";

function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return {
    path: "src/a.ts",
    line: 10,
    findingType: "bug",
    severity: "high",
    category: "correctness",
    title: "Off by one",
    body: "Loop bound is wrong.",
    fixPrompt: "Fix the bound.",
    ...overrides,
  };
}

const fixture = liveEvaluationFixtureSchema.parse({
  name: "planted-off-by-one",
  input: {
    changeRequest: { title: "Add pagination", number: 1 },
    files: [
      {
        path: "src/a.ts",
        additions: 12,
        deletions: 0,
        patch: [
          "@@ -1,0 +1,12 @@",
          ...Array.from({ length: 12 }, (_, i) => `+line ${i + 1}`),
        ].join("\n"),
      },
    ],
  },
  expectedFindings: [
    { label: "off-by-one", path: "src/a.ts", lineStart: 9, lineEnd: 11 },
    { label: "unchecked null", path: "src/a.ts", lineStart: 3 },
  ],
});

describe("matchFindings", () => {
  it("matches by path and line window with tolerance, once per expectation", () => {
    const result = matchFindings(
      [
        finding({ line: 12 }),
        finding({ line: 12, title: "dup" }),
        finding({ path: "src/b.ts", line: 3 }),
      ],
      fixture.expectedFindings,
    );

    expect(result.matched.map((m) => m.expected.label)).toEqual(["off-by-one"]);
    expect(result.missed.map((m) => m.label)).toEqual(["unchecked null"]);
    expect(result.unexpected.map((f) => `${f.path}:${f.line}`)).toEqual([
      "src/a.ts:12",
      "src/b.ts:3",
    ]);
  });

  it("respects an expected category when provided", () => {
    const result = matchFindings(
      [finding({ line: 3, category: "style" })],
      [{ label: "sec", path: "src/a.ts", lineStart: 3, category: "security" }],
    );
    expect(result.matched).toHaveLength(0);
    expect(result.unexpected).toHaveLength(1);
  });
});

describe("LiveReviewEvaluator", () => {
  it("runs fixtures through the engine, scores them, and records usage", async () => {
    const usage = new UsageTracker();
    const model: ReviewModel = {
      async generateStructuredReview() {
        usage.onCompletion({
          durationMs: 5,
          attempts: 1,
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        });
        return {
          summary: "Found an off-by-one.",
          mermaid: "flowchart TD\nA --> B",
          findings: [
            {
              path: "src/a.ts",
              line: 10,
              findingType: "bug",
              severity: "high",
              category: "correctness",
              title: "Off by one",
              body: "The loop runs one iteration too many.",
              fixPrompt: "Use < instead of <=.",
            },
            {
              path: "src/a.ts",
              line: 6,
              findingType: "bug",
              severity: "medium",
              category: "maintainability",
              title: "Unclear contract",
              body: "Callers cannot tell when x is null.",
              fixPrompt: "Document the null case.",
            },
          ],
        };
      },
    };

    const report = await new LiveReviewEvaluator({
      model,
      usage,
      engineOptions: { requireEvidence: false },
    }).evaluate([fixture]);

    expect(report.cases).toHaveLength(1);
    const [entry] = report.cases;
    expect(entry?.error).toBeNull();
    expect(entry?.matched.map((m) => m.expected)).toEqual([
      "src/a.ts:9-11 off-by-one",
    ]);
    expect(entry?.missed).toEqual(["src/a.ts:3 unchecked null"]);
    expect(entry?.unexpected).toHaveLength(1);
    expect(entry?.recall).toBe(0.5);
    expect(entry?.precision).toBe(0.5);
    expect(entry?.promptTokens).toBe(100);
    expect(entry?.completionTokens).toBe(20);
    expect(entry?.modelCalls).toBe(1);
    expect(report.totals.recall).toBe(0.5);
    expect(report.totals.precision).toBe(0.5);
    expect(report.totals.promptTokens).toBe(100);
  });

  it("records model failures per case without aborting the run", async () => {
    let calls = 0;
    const model: ReviewModel = {
      async generateStructuredReview() {
        calls += 1;
        if (calls === 1) {
          throw new Error("model exploded");
        }
        return { summary: "ok", mermaid: null, findings: [] };
      },
    };

    const report = await new LiveReviewEvaluator({ model }).evaluate([
      fixture,
      { ...fixture, name: "second", expectedFindings: [] },
    ]);

    expect(report.cases[0]?.error).toBe("model exploded");
    expect(report.cases[0]?.recall).toBe(0);
    expect(report.cases[1]?.error).toBeNull();
    expect(report.cases[1]?.precision).toBe(1);
    expect(report.totals.failedCases).toBe(1);
  });

  it("loads fixtures from disk with schema defaults", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nitpickr-live-eval-"));
    await writeFile(
      join(dir, "case.json"),
      JSON.stringify({
        name: "minimal",
        input: {
          changeRequest: { title: "t", number: 2 },
          files: [{ path: "a.ts", additions: 1, deletions: 0, patch: "+x" }],
        },
        expectedFindings: [],
      }),
    );

    const fixtures = await loadLiveEvaluationFixtures(dir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]?.input.commentBudget).toBe(10);
    expect(fixtures[0]?.input.memory).toEqual([]);
  });
  it("feeds a fixture's pull request body into the review prompt", async () => {
    const prompts: string[] = [];
    const model: ReviewModel = {
      async generateStructuredReview(input) {
        prompts.push(input.user);
        return {
          summary: "ok",
          mermaid: "flowchart TD\nA --> B",
          findings: [],
        };
      },
    };
    const withBody = liveEvaluationFixtureSchema.parse({
      ...fixture,
      input: {
        ...fixture.input,
        changeRequest: {
          ...fixture.input.changeRequest,
          body: "AC: pages hold 20 items",
        },
      },
    });

    await new LiveReviewEvaluator({
      model,
      usage: new UsageTracker(),
      engineOptions: { requireEvidence: false },
    }).evaluate([withBody]);

    expect(withBody.input.changeRequest.body).toBe("AC: pages hold 20 items");
    expect(
      prompts.some((user) => user.includes("AC: pages hold 20 items")),
    ).toBe(true);
  });
});
