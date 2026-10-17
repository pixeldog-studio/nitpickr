import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_ELLIPSIS_TRUNCATION_MARKER,
  DIAGNOSTIC_OBJECT_TRUNCATION_MARKER,
  DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_DEPRECATED,
  DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_VARIANTS,
  DIAGNOSTIC_SANITIZED_MAX_LENGTH,
} from "../../src/publisher/diagnostic-constants.js";
import {
  type PublishReviewClient,
  ReviewPublisher,
  sanitizeDiagnosticErrorMessage,
} from "../../src/publisher/review-publisher.js";

class FakePublishReviewClient implements PublishReviewClient {
  readonly calls: Array<{
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    body: string;
    comments: Array<{
      path: string;
      line: number;
      side: "RIGHT";
      body: string;
    }>;
  }> = [];
  existingReviews: Array<{ reviewId: string; body: string }> = [];
  publishFailures: unknown[] = [];

  async listPullRequestReviews(): Promise<
    Array<{
      reviewId: string;
      body: string;
    }>
  > {
    return this.existingReviews;
  }

  async publishPullRequestReview(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    body: string;
    comments: Array<{
      path: string;
      line: number;
      side: "RIGHT";
      body: string;
    }>;
  }): Promise<{ reviewId: string }> {
    this.calls.push(input);
    const nextFailure = this.publishFailures.shift();
    if (nextFailure) {
      throw nextFailure;
    }
    return { reviewId: "review_1" };
  }
}

describe("ReviewPublisher", () => {
  describe("sanitizeDiagnosticErrorMessage", () => {
    it("registers the deprecated truncation marker variant", () => {
      expect(DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_VARIANTS).toContain(
        DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_DEPRECATED,
      );
    });

    it("sanitizes Error messages and collapses whitespace", () => {
      const message = sanitizeDiagnosticErrorMessage(
        new Error("  parse failed\nwith details 💥 "),
      );

      expect(message).toBe("parse failed with details");
    });

    it("sanitizes plain object values via JSON serialization", () => {
      const message = sanitizeDiagnosticErrorMessage({
        status: 422,
        errors: ["Path could not be resolved"],
      });

      expect(message).toContain('"status":422');
      expect(message).toContain('"Path could not be resolved"');
      expect(/^[\x20-\x7E]+$/.test(message)).toBe(true);
    });

    it("serializes BigInt values as strings", () => {
      const message = sanitizeDiagnosticErrorMessage({
        status: 422n,
        nested: { value: 9007199254740993n },
      });

      expect(message).toContain('"status":"422"');
      expect(message).toContain('"value":"9007199254740993"');
    });

    it("sanitizes strings with non-ascii characters and truncates to 200 chars", () => {
      const source = `${"émoji 🚨 ".repeat(40)}tail`;
      const message = sanitizeDiagnosticErrorMessage(source);

      expect(message.length).toBeLessThanOrEqual(
        DIAGNOSTIC_SANITIZED_MAX_LENGTH,
      );
      expect(/^[\x20-\x7E]+$/.test(message)).toBe(true);
    });

    it("preserves serialized-length truncation markers", () => {
      const oversizedPayload = Object.fromEntries(
        Array.from({ length: 80 }, (_value, index) => [
          `field_${index}`,
          `value_${index}_${"x".repeat(24)}`,
        ]),
      );

      const message = sanitizeDiagnosticErrorMessage(oversizedPayload);

      expect(message).toContain(DIAGNOSTIC_ELLIPSIS_TRUNCATION_MARKER);
      expect(message.length).toBeLessThanOrEqual(
        DIAGNOSTIC_SANITIZED_MAX_LENGTH,
      );
    });

    it("preserves object-budget truncation markers", () => {
      const budgetExhaustingPayload = {
        values: Array.from({ length: 210 }, () => ({})),
      };

      const message = sanitizeDiagnosticErrorMessage(budgetExhaustingPayload);

      expect(message).toContain(DIAGNOSTIC_OBJECT_TRUNCATION_MARKER);
      expect(message.length).toBeLessThanOrEqual(
        DIAGNOSTIC_SANITIZED_MAX_LENGTH,
      );
    });

    it("recognizes canonical and deprecated object truncation marker variants", () => {
      const canonicalSource = `${"x".repeat(250)}${DIAGNOSTIC_OBJECT_TRUNCATION_MARKER}`;
      const deprecatedSource = `${"x".repeat(250)}${DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_DEPRECATED}`;

      const canonicalMessage = sanitizeDiagnosticErrorMessage(canonicalSource);
      const deprecatedMessage =
        sanitizeDiagnosticErrorMessage(deprecatedSource);

      expect(canonicalMessage).toContain(DIAGNOSTIC_OBJECT_TRUNCATION_MARKER);
      expect(deprecatedMessage).toContain(
        DIAGNOSTIC_OBJECT_TRUNCATION_MARKER_DEPRECATED,
      );
      expect(canonicalMessage.length).toBeLessThanOrEqual(
        DIAGNOSTIC_SANITIZED_MAX_LENGTH,
      );
      expect(deprecatedMessage.length).toBeLessThanOrEqual(
        DIAGNOSTIC_SANITIZED_MAX_LENGTH,
      );
    });

    it("returns a fallback when sanitization yields an empty string", () => {
      const message = sanitizeDiagnosticErrorMessage("🚨💥");
      expect(message).toBe("unavailable");
    });

    it("handles circular objects without throwing", () => {
      const payload: Record<string, unknown> = { status: 422 };
      payload.self = payload;

      const message = sanitizeDiagnosticErrorMessage(payload);

      expect(message).toContain('"self":"[Circular]"');
      expect(message.length).toBeLessThanOrEqual(
        DIAGNOSTIC_SANITIZED_MAX_LENGTH,
      );
      expect(/^[\x20-\x7E]+$/.test(message)).toBe(true);
    });
  });

  it("renders a summary body with findings and mermaid output", () => {
    const publisher = new ReviewPublisher(new FakePublishReviewClient());

    const body = publisher.buildSummaryBody({
      reviewRunId: "review_run_1",
      summary: "Queue fairness improved.",
      mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
      findings: [
        {
          path: "src/queue/queue-scheduler.ts",
          line: 18,
          findingType: "bug",
          severity: "high",
          category: "correctness",
          title: "Stable ordering breaks",
          body: "Equal priorities do not preserve insertion order.",
          fixPrompt:
            "Refactor the queue to preserve insertion order for equal priorities.",
        },
      ],
    });

    expect(body).toContain("Queue fairness improved.");
    expect(body).toContain("<!-- nitpickr:review-run:review_run_1 -->");
    expect(body).toContain("# nitpickr review");
    expect(body).toContain("**Summary:**");
    expect(body).not.toContain("## 📌 Highlights");
    expect(body).toContain("## Findings");
    expect(body).toContain("| Signal | Location | Finding |");
    expect(body).toContain("⚠️ 🧩");
    expect(body).toContain("🧭 Change flow");
    expect(body).toContain("```mermaid");
    expect(body).toContain("Stable ordering breaks");
  });

  it("renders inline comment bodies with fix prompts", () => {
    const publisher = new ReviewPublisher(new FakePublishReviewClient());

    const comments = publisher.buildInlineComments([
      {
        path: "src/queue/queue-scheduler.ts",
        line: 18,
        findingType: "safe_suggestion",
        severity: "high",
        category: "correctness",
        title: "Stable ordering breaks",
        body: "Equal priorities do not preserve insertion order.",
        fixPrompt:
          "Refactor the queue to preserve insertion order for equal priorities.",
        suggestedChange:
          "return left.priority - right.priority || left.sequence - right.sequence;",
      },
    ]);

    expect(comments[0]?.body).toContain("⚠️ 🧩 **Stable ordering breaks**");
    expect(comments[0]?.body).toContain(
      "**Where:** `src/queue/queue-scheduler.ts:18`",
    );
    expect(comments[0]?.body).toContain("```suggestion");
    expect(comments[0]?.body).toContain("left.sequence - right.sequence");
    expect(comments[0]?.body).toContain("🤖 AI prompt");
    expect(comments[0]?.body).toContain("preserve insertion order");
    expect(comments[0]?.body).not.toContain("[high][correctness]");
    expect(comments[0]?.side).toBe("RIGHT");
  });

  it("omits GitHub suggestion blocks when no inline replacement is available", () => {
    const publisher = new ReviewPublisher(new FakePublishReviewClient());

    const comments = publisher.buildInlineComments([
      {
        path: "src/queue/queue-scheduler.ts",
        line: 18,
        findingType: "question",
        severity: "low",
        category: "style",
        title: "Rename variable for clarity",
        body: "The current name makes the branch harder to scan.",
        fixPrompt:
          "In `src/queue/queue-scheduler.ts` around line 18, rename `q` to `queueState`.",
      },
    ]);

    expect(comments[0]?.body).not.toContain("```suggestion");
  });

  it("targets inline comments to changed diff lines when file patches are provided", () => {
    const publisher = new ReviewPublisher(new FakePublishReviewClient());

    const comments = publisher.buildInlineComments(
      [
        {
          path: "src/queue/queue-scheduler.ts",
          line: 13,
          findingType: "bug",
          severity: "high",
          category: "correctness",
          title: "Stable ordering breaks",
          body: "Equal priorities do not preserve insertion order.",
          fixPrompt:
            "Refactor the queue to preserve insertion order for equal priorities.",
        },
      ],
      {
        files: [
          {
            path: "src/queue/queue-scheduler.ts",
            patch: ["@@ -10,2 +10,2 @@", " context", "-old", "+new alpha"].join(
              "\n",
            ),
          },
        ],
      },
    );

    expect(comments).toEqual([
      {
        path: "src/queue/queue-scheduler.ts",
        line: 11,
        side: "RIGHT",
        fingerprint:
          "src/queue/queue-scheduler.ts:13:correctness:stable_ordering_breaks",
        body: expect.stringContaining("Stable ordering breaks"),
      },
    ]);
  });

  it("publishes one summary plus inline comments", async () => {
    const client = new FakePublishReviewClient();
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_1",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: "src/queue/queue-scheduler.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Equal priorities do not preserve insertion order.",
            fixPrompt:
              "Refactor the queue to preserve insertion order for equal priorities.",
          },
        ],
      },
      files: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: [
            "@@ -17,1 +17,2 @@",
            " context",
            "+inserted",
            "+stable ordering",
          ].join("\n"),
        },
      ],
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls[0]?.comments).toHaveLength(1);
    expect(client.calls[0]?.body).toContain("Queue fairness improved.");
    expect(client.calls[0]?.comments[0]?.side).toBe("RIGHT");
    expect(client.calls[0]?.comments[0]).not.toHaveProperty("fingerprint");
  });

  it("falls back to summary-only publish when GitHub rejects inline comment path/line resolution", async () => {
    const client = new FakePublishReviewClient();
    client.publishFailures = [
      new Error(
        'GitHub request failed with status 422: {"message":"Unprocessable Entity","errors":["Path could not be resolved, and Line could not be resolved"],"status":"422"}',
      ),
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_422",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: "src/queue/queue-scheduler.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Equal priorities do not preserve insertion order.",
            fixPrompt:
              "Refactor the queue to preserve insertion order for equal priorities.",
          },
        ],
      },
      files: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: [
            "@@ -17,1 +17,2 @@",
            " context",
            "+inserted",
            "+stable ordering",
          ].join("\n"),
        },
      ],
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.comments).toHaveLength(1);
    expect(client.calls[1]?.comments).toHaveLength(0);
  });

  it("falls back to summary-only publish when client throws a non-Error 422 payload", async () => {
    const client = new FakePublishReviewClient();
    client.publishFailures = [
      {
        status: "422",
        errors: ["Path could not be resolved", "Line could not be resolved"],
      },
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_422_payload",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: "src/queue/queue-scheduler.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Equal priorities do not preserve insertion order.",
            fixPrompt:
              "Refactor the queue to preserve insertion order for equal priorities.",
          },
        ],
      },
      files: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: [
            "@@ -17,1 +17,2 @@",
            " context",
            "+inserted",
            "+stable ordering",
          ].join("\n"),
        },
      ],
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.comments).toHaveLength(1);
    expect(client.calls[1]?.comments).toHaveLength(0);
  });

  it("falls back when Error message contains a JSON payload with trailing text", async () => {
    const client = new FakePublishReviewClient();
    client.publishFailures = [
      new Error(
        'GitHub request failed with status 422: {"status":"422","errors":["Path could not be resolved"]} extra context',
      ),
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_422_trailing",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: "src/queue/queue-scheduler.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Equal priorities do not preserve insertion order.",
            fixPrompt:
              "Refactor the queue to preserve insertion order for equal priorities.",
          },
        ],
      },
      files: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: [
            "@@ -17,1 +17,2 @@",
            " context",
            "+inserted",
            "+stable ordering",
          ].join("\n"),
        },
      ],
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.comments).toHaveLength(0);
  });

  it("falls back when an Error message contains a non-JSON brace block before a valid JSON payload", async () => {
    const client = new FakePublishReviewClient();
    client.publishFailures = [
      new Error(
        'GitHub request failed {not-json} then {"status":"422","errors":["Path could not be resolved"]}',
      ),
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_422_mixed",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: "src/queue/queue-scheduler.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Equal priorities do not preserve insertion order.",
            fixPrompt:
              "Refactor the queue to preserve insertion order for equal priorities.",
          },
        ],
      },
      files: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: [
            "@@ -17,1 +17,2 @@",
            " context",
            "+inserted",
            "+stable ordering",
          ].join("\n"),
        },
      ],
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.comments).toHaveLength(0);
  });

  it("falls back when JSON string values include brace characters", async () => {
    const client = new FakePublishReviewClient();
    client.publishFailures = [
      new Error(
        'GitHub request failed with status 422: {"status":"422","message":"value with } and { braces","errors":["Path could not be resolved"]}',
      ),
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_422_braces",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: "src/queue/queue-scheduler.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Equal priorities do not preserve insertion order.",
            fixPrompt:
              "Refactor the queue to preserve insertion order for equal priorities.",
          },
        ],
      },
      files: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: [
            "@@ -17,1 +17,2 @@",
            " context",
            "+inserted",
            "+stable ordering",
          ].join("\n"),
        },
      ],
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.comments).toHaveLength(0);
  });

  it("does not swallow unrelated publish errors", async () => {
    const client = new FakePublishReviewClient();
    client.publishFailures = [
      new Error(
        'GitHub request failed with status 422: {"message":"Unprocessable Entity","errors":["Validation failed"],"status":"422"}',
      ),
    ];
    const publisher = new ReviewPublisher(client);

    await expect(() =>
      publisher.publish({
        reviewRunId: "review_run_error",
        installationId: "123456",
        repository: {
          owner: "rubenspessoa",
          name: "nitpickr",
        },
        pullNumber: 42,
        publishMode: "pr_summary",
        result: {
          summary: "Queue fairness improved.",
          mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
          findings: [
            {
              path: "src/queue/queue-scheduler.ts",
              line: 18,
              findingType: "bug",
              severity: "high",
              category: "correctness",
              title: "Stable ordering breaks",
              body: "Equal priorities do not preserve insertion order.",
              fixPrompt:
                "Refactor the queue to preserve insertion order for equal priorities.",
            },
          ],
        },
        files: [
          {
            path: "src/queue/queue-scheduler.ts",
            patch: [
              "@@ -17,1 +17,2 @@",
              " context",
              "+inserted",
              "+stable ordering",
            ].join("\n"),
          },
        ],
      }),
    ).rejects.toThrow(/Validation failed/i);
    expect(client.calls).toHaveLength(1);
  });

  it("does not treat non-numeric status strings as 422", async () => {
    const client = new FakePublishReviewClient();
    client.publishFailures = [
      {
        status: "422abc",
        errors: ["Path could not be resolved"],
      },
    ];
    const publisher = new ReviewPublisher(client);

    await expect(() =>
      publisher.publish({
        reviewRunId: "review_run_error_status",
        installationId: "123456",
        repository: {
          owner: "rubenspessoa",
          name: "nitpickr",
        },
        pullNumber: 42,
        publishMode: "pr_summary",
        result: {
          summary: "Queue fairness improved.",
          mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
          findings: [
            {
              path: "src/queue/queue-scheduler.ts",
              line: 18,
              findingType: "bug",
              severity: "high",
              category: "correctness",
              title: "Stable ordering breaks",
              body: "Equal priorities do not preserve insertion order.",
              fixPrompt:
                "Refactor the queue to preserve insertion order for equal priorities.",
            },
          ],
        },
        files: [
          {
            path: "src/queue/queue-scheduler.ts",
            patch: [
              "@@ -17,1 +17,2 @@",
              " context",
              "+inserted",
              "+stable ordering",
            ].join("\n"),
          },
        ],
      }),
    ).rejects.toEqual({
      errors: ["Path could not be resolved"],
      status: "422abc",
    });
    expect(client.calls).toHaveLength(1);
  });

  it("reuses an existing review when the same review run was already published", async () => {
    const client = new FakePublishReviewClient();
    client.existingReviews = [
      {
        reviewId: "review_existing",
        body: "<!-- nitpickr:review-run:review_run_1 -->\nexisting",
      },
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_1",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [],
      },
    });

    expect(published.reviewId).toBe("review_existing");
    expect(client.calls).toHaveLength(0);
  });

  it("posts a short end-state follow-up instead of a second summary", async () => {
    const client = new FakePublishReviewClient();
    client.existingReviews = [
      {
        reviewId: "review_summary",
        body: [
          "<!-- nitpickr:summary -->",
          "<!-- nitpickr:review-run:review_run_1 -->",
          "# nitpickr review ✨",
        ].join("\n"),
      },
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_2",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "pr_summary",
      result: {
        summary: "Queue fairness improved.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [],
      },
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.body).not.toContain("# nitpickr review");
    expect(client.calls[0]?.body).toContain("**No further comments.**");
  });

  it("publishes later review comments without another visible summary", async () => {
    const client = new FakePublishReviewClient();
    client.existingReviews = [
      {
        reviewId: "review_summary",
        body: [
          "<!-- nitpickr:summary -->",
          "<!-- nitpickr:review-run:review_run_1 -->",
          "# nitpickr review ✨",
        ].join("\n"),
      },
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_2",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "commit_summary",
      reviewedCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      commitSummaryCounts: {
        resolvedThreads: 0,
      },
      result: {
        summary: "This push tightens queue ordering checks.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: "src/queue/queue-scheduler.ts",
            line: 18,
            findingType: "bug",
            severity: "high",
            category: "correctness",
            title: "Stable ordering breaks",
            body: "Equal priorities do not preserve insertion order.",
            fixPrompt:
              "Refactor the queue to preserve insertion order for equal priorities.",
          },
        ],
      },
      files: [
        {
          path: "src/queue/queue-scheduler.ts",
          patch: [
            "@@ -17,1 +17,2 @@",
            " context",
            "+inserted",
            "+stable ordering",
          ].join("\n"),
        },
      ],
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.body).toContain(
      "<!-- nitpickr:review-run:review_run_2 -->",
    );
    expect(client.calls[0]?.body).toContain("nitpickr commit review");
    expect(client.calls[0]?.body).toContain("`bbbbbbb`");
    expect(client.calls[0]?.body).toContain("New findings: 1");
    expect(client.calls[0]?.comments).toHaveLength(1);
  });

  it("counts only findings that become inline comments in the commit summary", async () => {
    const client = new FakePublishReviewClient();
    client.existingReviews = [
      {
        reviewId: "review_summary",
        body: [
          "<!-- nitpickr:summary -->",
          "<!-- nitpickr:review-run:review_run_1 -->",
          "# nitpickr review ✨",
        ].join("\n"),
      },
    ];
    const publisher = new ReviewPublisher(client);

    await publisher.publish({
      reviewRunId: "review_run_4",
      installationId: "123456",
      repository: { owner: "rubenspessoa", name: "nitpickr" },
      pullNumber: 42,
      publishMode: "commit_summary",
      reviewedCommitSha: "dddddddddddddddddddddddddddddddddddddddd",
      commitSummaryCounts: { resolvedThreads: 0 },
      result: {
        summary: "This push clarifies a config comment.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [
          {
            path: ".env.example",
            line: 400,
            findingType: "safe_suggestion",
            severity: "low",
            category: "style",
            title: "Line outside the diff",
            body: "Cannot be anchored to the patch.",
            fixPrompt: "Clarify .env.example line 400.",
          },
        ],
      },
      files: [
        {
          path: ".env.example",
          patch: ["@@ -14,1 +14,2 @@", " context", "+clarified"].join("\n"),
        },
      ],
    });

    expect(client.calls[0]?.comments).toHaveLength(0);
    expect(client.calls[0]?.body).not.toContain("New findings: 1");
    expect(client.calls[0]?.body).toContain("**No further comments.**");
  });

  it("publishes a visible clean commit summary even when there are no findings", async () => {
    const client = new FakePublishReviewClient();
    client.existingReviews = [
      {
        reviewId: "review_summary",
        body: [
          "<!-- nitpickr:summary -->",
          "<!-- nitpickr:review-run:review_run_1 -->",
          "# nitpickr review ✨",
        ].join("\n"),
      },
    ];
    const publisher = new ReviewPublisher(client);

    const published = await publisher.publish({
      reviewRunId: "review_run_3",
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      publishMode: "commit_summary",
      reviewedCommitSha: "cccccccccccccccccccccccccccccccccccccccc",
      commitSummaryCounts: {
        resolvedThreads: 2,
      },
      result: {
        summary: "This push mainly refines webhook validation.",
        mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
        findings: [],
      },
    });

    expect(published.reviewId).toBe("review_1");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.comments).toHaveLength(0);
    expect(client.calls[0]?.body).toContain("**No further comments.**");
    expect(client.calls[0]?.body).toContain("over to a human reviewer");
    expect(client.calls[0]?.body).toContain("Resolved threads: 2");
  });

  it("rejects publish calls with no repository owner", async () => {
    const publisher = new ReviewPublisher(new FakePublishReviewClient());

    await expect(() =>
      publisher.publish({
        reviewRunId: "review_run_1",
        installationId: "123456",
        repository: {
          owner: "",
          name: "nitpickr",
        },
        pullNumber: 42,
        publishMode: "pr_summary",
        result: {
          summary: "Queue fairness improved.",
          mermaid: "flowchart TD\nA[Queue] --> B[Publish]",
          findings: [],
        },
      }),
    ).rejects.toThrow(/owner/i);
  });
});

describe("second look list", () => {
  it("renders unconfirmed findings as a collapsed list", async () => {
    const { renderSecondLook } = await import(
      "../../src/publisher/review-publisher.js"
    );
    expect(renderSecondLook([])).toBeNull();
    const block = renderSecondLook([
      {
        path: "a.ts",
        line: 3,
        findingType: "bug",
        severity: "medium",
        category: "correctness",
        title: "Maybe a race",
        body: "Two writers could interleave.",
        fixPrompt: "x",
      },
    ]);
    expect(block).toContain(
      "<summary>Worth a second look (1, not confirmed)</summary>",
    );
    expect(block).toContain(
      "- `a.ts:3` **Maybe a race**: Two writers could interleave.",
    );
  });
});
