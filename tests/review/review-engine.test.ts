import { describe, expect, it } from "vitest";

import {
  ReviewEngine,
  type ReviewModel,
} from "../../src/review/review-engine.js";

class FakeReviewModel implements ReviewModel {
  readonly prompts: string[] = [];
  readonly chunkResponses: unknown[];

  constructor(chunkResponses: unknown[]) {
    this.chunkResponses = [...chunkResponses];
  }

  async generateStructuredReview(input: { system: string; user: string }) {
    this.prompts.push(`${input.system}\n---\n${input.user}`);
    return (
      this.chunkResponses.shift() ?? {
        summary: "No findings.",
        mermaid: "flowchart TD\nA[Change] --> B[Reviewed]",
        findings: [],
      }
    );
  }
}

describe("ReviewEngine", () => {
  it("constrains the model to the review JSON Schema and accepts null optional fields", async () => {
    const schemas: unknown[] = [];
    const model: ReviewModel = {
      async generateStructuredReview(input) {
        schemas.push(input.jsonSchema);
        return {
          summary: "Summary",
          diagram: {
            type: "flowchart",
            direction: null,
            nodes: [{ id: "a", label: "A" }],
            edges: [{ from: "a", to: "a", label: null }],
          },
          findings: [
            {
              path: "src/queue/a.ts",
              line: 1,
              findingType: "bug",
              severity: "high",
              category: "correctness",
              title: "Ordering breaks",
              body: "Stable ordering is lost.",
              fixPrompt: "Fix ordering in src/queue/a.ts line 1.",
              suggestedChange: null,
            },
          ],
        };
      },
    };

    const result = await new ReviewEngine(model).review({
      changeRequest: { title: "Queue", number: 1 },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 1,
          deletions: 0,
          patch: "@@ -0,0 +1,1 @@\n+stable ordering",
        },
      ],
      instructionText: "",
      memory: [],
      commentBudget: 5,
    });

    expect(schemas[0]).toEqual(
      expect.objectContaining({
        name: "nitpickr_review",
        schema: expect.objectContaining({
          required: ["summary", "diagram", "findings", "priorThreadVerdicts"],
          additionalProperties: false,
        }),
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.suggestedChange).toBeUndefined();
  });

  it("chunks large file sets and merges structured findings", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Chunk one summary",
        diagram: {
          type: "sequence",
          title: "Chunk one",
          participants: [
            { id: "queue", label: "Queue" },
            { id: "sort", label: "Sort step" },
          ],
          steps: [
            {
              from: "queue",
              to: "sort",
              label: "Prepare ordering",
            },
          ],
        },
        findings: [
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Ordering breaks for equal priority",
            body: "Stable ordering is lost when priorities match.",
            fixPrompt:
              "Refactor the queue insertion logic to preserve stable ordering.",
          },
        ],
      },
      {
        summary: "Chunk two summary",
        diagram: {
          type: "sequence",
          title: "Chunk one",
          participants: [
            { id: "sort", label: "Sort step" },
            { id: "publish", label: "Publish" },
          ],
          steps: [
            {
              from: "sort",
              to: "publish",
              label: "Publish comments",
            },
          ],
        },
        findings: [],
      },
    ]);

    const engine = new ReviewEngine(model, {
      maxPatchCharactersPerChunk: 20,
    });

    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+12345678901234567890",
        },
        {
          path: "src/queue/b.ts",
          additions: 8,
          deletions: 1,
          patch: "@@ -1,1 +1,20 @@\n+abcdefghijklmnopqrst",
        },
      ],
      contextFiles: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+12345678901234567890",
        },
        {
          path: "src/queue/b.ts",
          additions: 8,
          deletions: 1,
          patch: "@@ -1,1 +1,20 @@\n+abcdefghijklmnopqrst",
        },
        {
          path: "src/api/server.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,5 @@\n+validate body",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 10,
    });

    expect(model.prompts).toHaveLength(2);
    expect(result.findings).toHaveLength(1);
    expect(result.summary).toContain("Chunk one summary");
    expect(result.summary).toContain("Chunk two summary");
    expect(result.mermaid).toContain("sequenceDiagram");
    expect(result.mermaid).toContain("queue->>sort: Prepare ordering");
    expect(result.mermaid).toContain("sort->>publish: Publish comments");
    expect(model.prompts[0]).toContain("Current PR context:");
    expect(model.prompts[0]).toContain("src/api/server.ts (+3/-1)");
  });

  it("caps findings to the configured comment budget", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        diagram: {
          type: "sequence",
          participants: [
            { id: "code", label: "Code" },
            { id: "review", label: "Review" },
          ],
          steps: [
            {
              from: "code",
              to: "review",
              label: "Review change",
            },
          ],
        },
        findings: [
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "bug",
            severity: "critical",
            category: "correctness",
            title: "Critical bug",
            body: "Critical issue.",
            fixPrompt: "Fix critical issue.",
          },
          {
            path: "src/queue/b.ts",
            line: 18,
            findingType: "teaching_note",
            severity: "low",
            category: "maintainability",
            title: "Minor issue",
            body: "Minor issue.",
            fixPrompt: "Fix minor issue.",
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+stable ordering",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 1,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Critical bug");
  });

  it("suppresses findings outside the changed scope and exposes rejection reasons", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        mermaid: "flowchart TD\nA[Change] --> B[Reviewed]",
        findings: [
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Stable ordering breaks when equal priorities are inserted.",
            fixPrompt:
              "In `src/queue/a.ts` around line 12, preserve insertion order.",
          },
          {
            path: "src/queue/a.ts",
            line: 40,
            findingType: "bug",
            severity: "medium",
            category: "correctness",
            title: "Outside changed context",
            body: "This finding points to a line outside the changed hunk.",
            fixPrompt:
              "In `src/queue/a.ts` around line 40, update the changed branch.",
          },
          {
            path: "src/missing.ts",
            line: 10,
            findingType: "bug",
            severity: "medium",
            category: "correctness",
            title: "Wrong file",
            body: "This finding points to an unknown file.",
            fixPrompt: "In `src/missing.ts` around line 10, update the file.",
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.reviewWithDiagnostics({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -10,2 +10,3 @@\n context\n-old\n+new alpha",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 5,
    });

    expect(result.result.findings).toHaveLength(1);
    expect(result.result.findings[0]?.title).toBe("Stable ordering breaks");
    expect(result.rejectedFindings).toHaveLength(2);
    expect(result.rejectedFindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          findingFingerprint:
            "src/queue/a.ts:40:correctness:outside_changed_context",
          reasons: ["line_not_in_changed_context"],
        }),
        expect.objectContaining({
          findingFingerprint: "src/missing.ts:10:correctness:wrong_file",
          reasons: ["path_not_in_scope"],
        }),
      ]),
    );
  });

  it("applies the comment budget after the gate and severity floor", async () => {
    const lowFinding = (line: number) => ({
      path: "src/queue/a.ts",
      line,
      findingType: "bug",
      severity: "low",
      category: "correctness",
      title: `Low finding ${line}`,
      body: "Minor issue.",
      fixPrompt: `In \`src/queue/a.ts\` around line ${line}, tidy this.`,
    });
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        findings: [
          lowFinding(10),
          lowFinding(11),
          {
            path: "src/context/b.ts",
            line: 3,
            findingType: "bug",
            severity: "critical",
            category: "security",
            title: "Context-only file",
            body: "Points at a file outside the primary scope.",
            fixPrompt: "In `src/context/b.ts` around line 3, fix it.",
          },
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "bug",
            severity: "medium",
            category: "correctness",
            title: "Real bug",
            body: "Equal priorities lose insertion order.",
            fixPrompt: "In `src/queue/a.ts` around line 12, keep order.",
          },
        ],
      },
    ]);

    const result = await new ReviewEngine(model).reviewWithDiagnostics({
      changeRequest: { title: "Queue", number: 7 },
      scope: "commit_delta",
      files: [
        {
          path: "src/queue/a.ts",
          additions: 3,
          deletions: 0,
          patch: "@@ -9,1 +10,3 @@\n+a\n+b\n+c",
        },
      ],
      contextFiles: [
        {
          path: "src/context/b.ts",
          additions: 1,
          deletions: 0,
          patch: "@@ -1,1 +3,1 @@\n+x",
        },
      ],
      instructionText: "",
      memory: [],
      commentBudget: 1,
      severityFloor: "medium",
    });

    expect(result.result.findings.map((finding) => finding.title)).toEqual([
      "Real bug",
    ]);
    const reasons = Object.fromEntries(
      result.rejectedFindings.map((rejected) => [
        rejected.finding.title,
        rejected.reasons,
      ]),
    );
    expect(reasons["Context-only file"]).toEqual(["path_not_in_scope"]);
    expect(reasons["Low finding 10"]).toEqual(["below_severity_floor"]);
  });

  it("emits prompt usage diagnostics and compacts balanced commit-delta payloads", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        findings: [],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.reviewWithDiagnostics({
      changeRequest: {
        title: "Optimize prompts",
        number: 99,
      },
      scope: "commit_delta",
      optimizationMode: "balanced",
      files: [
        {
          path: "src/queue/a.ts",
          additions: 2,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n+optimized",
        },
      ],
      contextFiles: [
        {
          path: "src/context/a.ts",
          additions: 30,
          deletions: 5,
          patch: "@@ -1,1 +1,200 @@\n+".padEnd(500, "x"),
        },
      ],
      instructionText: "instruction ".repeat(500),
      memory: new Array(12).fill(0).map((_, index) => ({
        summary: `memory-${index}-${"x".repeat(400)}`,
      })),
      commentBudget: 5,
    });

    expect(
      result.promptUsage.beforeCompaction.contextPatchChars,
    ).toBeGreaterThan(0);
    expect(result.promptUsage.afterCompaction.contextPatchChars).toBe(0);
    expect(result.promptUsage.afterCompaction.instructionChars).toBeLessThan(
      result.promptUsage.beforeCompaction.instructionChars,
    );
    expect(result.promptUsage.afterCompaction.memoryChars).toBeLessThan(
      result.promptUsage.beforeCompaction.memoryChars,
    );
    expect(
      result.promptUsage.afterCompaction.estimatedPromptTokens,
    ).toBeLessThan(result.promptUsage.beforeCompaction.estimatedPromptTokens);
  });

  it("deduplicates repeated findings and keeps ordering stable", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        diagram: {
          type: "sequence",
          participants: [
            { id: "code", label: "Code" },
            { id: "review", label: "Review" },
          ],
          steps: [
            {
              from: "code",
              to: "review",
              label: "Review change",
            },
          ],
        },
        findings: [
          {
            path: "src/queue/b.ts",
            line: 30,
            findingType: "bug",
            severity: "medium",
            category: "maintainability",
            title: "Extract duplicate branch",
            body: "The branch is repeated twice.",
            fixPrompt: "Extract the shared branch into a helper.",
          },
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Ordering breaks for equal priority",
            body: "Stable ordering is lost when priorities match.",
            fixPrompt: "Preserve insertion order for equal priorities.",
          },
        ],
      },
      {
        summary: "Summary two",
        diagram: {
          type: "sequence",
          participants: [
            { id: "code", label: "Code" },
            { id: "review", label: "Review" },
          ],
          steps: [
            {
              from: "code",
              to: "review",
              label: "Review change",
            },
          ],
        },
        findings: [
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "bug",
            severity: "critical",
            category: "correctness",
            title: "Ordering breaks for equal priority",
            body: "Stable ordering is lost when priorities match.",
            fixPrompt: "Preserve insertion order for equal priorities.",
          },
          {
            path: "src/queue/a.ts",
            line: 40,
            findingType: "question",
            severity: "medium",
            category: "testing",
            title: "Add a regression test",
            body: "The case is not covered today.",
            fixPrompt: "Add a regression test for equal-priority insertion.",
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model, {
      maxPatchCharactersPerChunk: 20,
    });
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+12345678901234567890",
        },
        {
          path: "src/queue/b.ts",
          additions: 8,
          deletions: 1,
          patch: "@@ -1,1 +1,20 @@\n+abcdefghijklmnopqrst",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 10,
    });

    expect(result.findings).toHaveLength(3);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        path: "src/queue/a.ts",
        line: 12,
        severity: "critical",
      }),
    );
    expect(
      result.findings.map((finding) => `${finding.path}:${finding.line}`),
    ).toEqual(["src/queue/a.ts:12", "src/queue/a.ts:40", "src/queue/b.ts:30"]);
  });

  it("falls back to a default mermaid graph when the model returns null", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        diagram: null,
        findings: [],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+stable ordering",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 2,
    });

    expect(result.mermaid).toBe(
      'sequenceDiagram\ntitle "Review flow"\nparticipant pull_request as "Pull Request"\nparticipant nitpickr as "nitpickr"\npull_request->>nitpickr: Review requested\nnitpickr->>pull_request: Publish review summary',
    );
  });

  it("normalizes common severity and category synonyms from the model", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        diagram: {
          type: "sequence",
          participants: [
            { id: "code", label: "Code" },
            { id: "review", label: "Review" },
          ],
          steps: [
            {
              from: "code",
              to: "review",
              label: "Review change",
            },
          ],
        },
        findings: [
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "safe_suggestion",
            severity: "minor",
            category: "robustness",
            title: "Guard missing state",
            body: "The queue should handle missing state defensively.",
            fixPrompt: "Add a guard for missing queue state.",
            suggestedChange:
              "```suggestion\nif (!queueState) {\n  return;\n}\n```",
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+stable ordering",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 2,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "low",
        category: "correctness",
        fixPrompt: expect.stringContaining("src/queue/a.ts"),
        suggestedChange: "if (!queueState) {\n  return;\n}",
      }),
    ]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        fixPrompt: expect.stringContaining("line 12"),
      }),
    ]);
  });

  it("drops unrecoverable findings instead of failing the full review", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        diagram: {
          type: "sequence",
          participants: [
            { id: "code", label: "Code" },
            { id: "review", label: "Review" },
          ],
          steps: [
            {
              from: "code",
              to: "review",
              label: "Review change",
            },
          ],
        },
        findings: [
          {
            path: "",
            line: 12,
            findingType: "bug",
            severity: "minor",
            category: "robustness",
            title: "Bad finding",
            body: "This should be dropped.",
            fixPrompt: "Drop it.",
          },
          {
            path: "src/queue/a.ts",
            line: 18,
            findingType: "bug",
            severity: "major",
            category: "performance",
            title: "Avoid repeated scans",
            body: "Scanning the queue repeatedly is expensive.",
            fixPrompt: "Cache the computed ordering before reuse.",
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+stable ordering",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 2,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        path: "src/queue/a.ts",
        severity: "high",
        category: "performance",
        fixPrompt: expect.stringContaining("src/queue/a.ts"),
      }),
    );
  });

  it("adds file and line context to fix prompts when the model omits it", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        diagram: {
          type: "sequence",
          participants: [
            { id: "code", label: "Code" },
            { id: "review", label: "Review" },
          ],
          steps: [
            {
              from: "code",
              to: "review",
              label: "Review change",
            },
          ],
        },
        findings: [
          {
            path: "src/api/server.ts",
            line: 27,
            findingType: "bug",
            severity: "medium",
            category: "maintainability",
            title: "Clarify parsing path",
            body: "Guard the invalid JSON branch explicitly.",
            fixPrompt: "Add an explicit JSON parse guard.",
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/api/server.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+stable ordering",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 2,
    });

    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        fixPrompt: expect.stringContaining("src/api/server.ts"),
      }),
    );
    expect(result.findings[0]).toEqual(
      expect.objectContaining({
        fixPrompt: expect.stringContaining("line 27"),
      }),
    );
  });

  it("drops oversized inline suggestions while keeping the finding", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        diagram: {
          type: "sequence",
          participants: [
            { id: "code", label: "Code" },
            { id: "review", label: "Review" },
          ],
          steps: [
            {
              from: "code",
              to: "review",
              label: "Review change",
            },
          ],
        },
        findings: [
          {
            path: "src/api/server.ts",
            line: 27,
            findingType: "safe_suggestion",
            severity: "medium",
            category: "maintainability",
            title: "Extract request validation",
            body: "The validation branch is getting harder to scan.",
            fixPrompt: "Extract the validation into a helper.",
            suggestedChange: new Array(20)
              .fill("const value = input;")
              .join("\n"),
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve API validation",
        number: 51,
      },
      files: [
        {
          path: "src/api/server.ts",
          additions: 6,
          deletions: 1,
          patch: "@@ -20,1 +20,6 @@\n+const value = input;",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 2,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        path: "src/api/server.ts",
        suggestedChange: undefined,
      }),
    ]);
  });

  it("normalizes finding types and strips suggested changes from non-safe findings", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        findings: [
          {
            path: "src/queue/a.ts",
            line: 12,
            findingType: "suggestion",
            severity: "medium",
            category: "maintainability",
            title: "Extract a helper",
            body: "This branch repeats logic twice.",
            fixPrompt: "Extract a helper for the repeated branch.",
            suggestedChange: "return buildTenantCountMap(runningJobs);",
          },
          {
            path: "src/queue/a.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Ordering breaks",
            body: "Stable ordering is lost for equal priorities.",
            fixPrompt: "Preserve insertion order for equal priorities.",
            suggestedChange: "return left.sequence - right.sequence;",
          },
        ],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+stable ordering",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 10,
    });

    const suggestionFinding = result.findings.find(
      (finding) => finding.findingType === "safe_suggestion",
    );
    const bugFinding = result.findings.find(
      (finding) => finding.title === "Ordering breaks",
    );

    expect(suggestionFinding).toEqual(
      expect.objectContaining({
        findingType: "safe_suggestion",
        suggestedChange: "return buildTenantCountMap(runningJobs);",
      }),
    );
    expect(bugFinding).toEqual(
      expect.objectContaining({
        findingType: "bug",
        suggestedChange: undefined,
      }),
    );
  });

  it("rejects malformed top-level model output", async () => {
    const model = new FakeReviewModel(["not-an-object"]);

    const engine = new ReviewEngine(model);

    await expect(() =>
      engine.review({
        changeRequest: {
          title: "Improve queue fairness",
          number: 42,
        },
        files: [
          {
            path: "src/queue/a.ts",
            additions: 10,
            deletions: 2,
            patch: "@@ -1,1 +1,20 @@\n+stable ordering",
          },
        ],
        instructionText: "strictness: balanced",
        memory: [],
        commentBudget: 2,
      }),
    ).rejects.toThrow(/object/i);
  });

  it("supports legacy raw mermaid output as a fallback", async () => {
    const model = new FakeReviewModel([
      {
        summary: "Summary",
        mermaid: "flowchart LR\nA[Legacy] --> B[Graph]",
        findings: [],
      },
    ]);

    const engine = new ReviewEngine(model);
    const result = await engine.review({
      changeRequest: {
        title: "Improve queue fairness",
        number: 42,
      },
      files: [
        {
          path: "src/queue/a.ts",
          additions: 10,
          deletions: 2,
          patch: "@@ -1,1 +1,20 @@\n+stable ordering",
        },
      ],
      instructionText: "strictness: balanced",
      memory: [],
      commentBudget: 2,
    });

    expect(result.mermaid).toContain("flowchart TD");
    expect(result.mermaid).toContain("A[Legacy] --> B[Graph]");
  });

  it("splits chunks by total characters when full file content is large", async () => {
    const model = new FakeReviewModel([]);
    const engine = new ReviewEngine(model, {
      maxPatchCharactersPerChunk: 10_000,
      maxTotalCharactersPerChunk: 1_500,
    });

    await engine.review({
      changeRequest: { title: "Big files", number: 7 },
      files: [
        {
          path: "src/a.ts",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n+a",
          fileContent: "x".repeat(1_000),
        },
        {
          path: "src/b.ts",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n+b",
          fileContent: "y".repeat(1_000),
        },
        {
          path: "src/c.ts",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n+c",
          fileContent: null,
        },
      ],
      instructionText: "",
      memory: [],
      commentBudget: 5,
      optimizationMode: "off",
    });

    // a alone (1k), then b + c (1k + tiny) — patch budget never trips.
    expect(model.prompts).toHaveLength(2);
    expect(model.prompts[0]).toContain("src/a.ts");
    expect(model.prompts[0]).not.toContain("src/b.ts");
    expect(model.prompts[1]).toContain("src/b.ts");
    expect(model.prompts[1]).toContain("src/c.ts");
  });

  it("bounds concurrent model requests and preserves chunk order", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: number[] = [];
    const model: ReviewModel = {
      async generateStructuredReview(input) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const match = /Chunk (\d+) of/.exec(input.user);
        const index = Number(match?.[1] ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        order.push(index);
        return {
          summary: `Summary ${index}`,
          mermaid: "flowchart TD\nA --> B",
          findings: [],
        };
      },
    };
    const engine = new ReviewEngine(model, {
      maxPatchCharactersPerChunk: 5,
      maxConcurrentModelRequests: 1,
    });

    const result = await engine.review({
      changeRequest: { title: "Sequential", number: 8 },
      files: ["a", "b", "c", "d"].map((name) => ({
        path: `src/${name}.ts`,
        additions: 1,
        deletions: 0,
        patch: `@@ -1 +1 @@\n+${name}${name}${name}`,
      })),
      instructionText: "",
      memory: [],
      commentBudget: 5,
      optimizationMode: "off",
    });

    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(result.summary).toMatch(
      /Summary 1[\s\S]*Summary 2[\s\S]*Summary 3[\s\S]*Summary 4/,
    );
  });
});
