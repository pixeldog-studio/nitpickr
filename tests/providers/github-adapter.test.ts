import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  classifyInteraction,
  GitHubAdapter,
  type GitHubApiClient,
} from "../../src/providers/github/github-adapter.js";

class FakeGitHubApiClient implements GitHubApiClient {
  readonly reactions: Array<{
    installationId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: "eyes";
  }> = [];

  async getPullRequest() {
    return {
      id: 101,
      number: 42,
      title: "Improve queue fairness",
      state: "open" as const,
      draft: false,
      user: {
        login: "ruben",
      },
      base: {
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ref: "main",
      },
      head: {
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ref: "feature/queue",
      },
    };
  }

  async listPullRequestFiles() {
    return [
      {
        filename: "src/queue/queue-scheduler.ts",
        status: "modified" as const,
        additions: 24,
        deletions: 2,
        patch: "@@ -1,4 +1,6 @@\n+new lines",
      },
    ];
  }

  async listIssueComments() {
    return [
      {
        id: 9001,
        body: "@nitpickr review",
        user: {
          login: "maintainer",
        },
        created_at: "2026-03-09T10:00:00.000Z",
      },
    ];
  }

  async listReviewComments() {
    return [
      {
        id: 8080,
        body: "This should preserve insertion order.",
        user: {
          login: "reviewer",
        },
        path: "src/queue/queue-scheduler.ts",
        line: 18,
        created_at: "2026-03-09T10:01:00.000Z",
      },
    ];
  }

  async comparePullRequestRange() {
    return [
      {
        filename: "src/api/server.ts",
        status: "modified" as const,
        additions: 5,
        deletions: 1,
        patch: "@@ -1,1 +1,2 @@\n+guard",
      },
    ];
  }

  async getFileContent(): Promise<string | null> {
    return null;
  }

  async listNitpickrReviewThreads() {
    return [
      {
        threadId: "thread_1",
        providerCommentId: "6001",
        path: "src/api/server.ts",
        line: 27,
        fingerprint: "fp_1",
        isResolved: false,
        body: [
          "⚠️ 🧩 **Guard the parse**",
          "**Where:** `src/api/server.ts:27`",
          "",
          "The webhook parser should reject invalid payloads before queueing work.",
          "",
          "<!-- nitpickr:fingerprint:fp_1 -->",
          "<details>",
          "<summary>🤖 AI prompt</summary>",
          "",
          "```text",
          "In `src/api/server.ts` around line 27, add an early validation guard before queueing.",
          "```",
          "",
          "</details>",
        ].join("\n"),
        reactionSummary: {
          positiveCount: 0,
          negativeCount: 0,
        },
      },
    ];
  }

  async resolveReviewThread() {}

  async createIssueCommentReaction(input: {
    installationId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: "eyes";
  }) {
    this.reactions.push(input);
  }

  async createIssueComment() {}

  async replyToReviewComment() {}
}

const pullRequestPayload = {
  action: "opened",
  installation: {
    id: 123456,
  },
  repository: {
    id: 99,
    name: "nitpickr",
    owner: {
      login: "rubenspessoa",
    },
    default_branch: "main",
  },
  pull_request: {
    id: 101,
    number: 42,
    title: "Improve queue fairness",
    state: "open",
    draft: false,
    user: {
      login: "ruben",
    },
    base: {
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ref: "main",
    },
    head: {
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ref: "feature/queue",
    },
  },
};

describe("GitHubAdapter", () => {
  it("verifies webhook signatures", async () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
      },
    });
    const payload = JSON.stringify(pullRequestPayload);
    const signature = createHmac("sha256", "super-secret")
      .update(payload)
      .digest("hex");

    await expect(
      adapter.verifyWebhookSignature(payload, `sha256=${signature}`),
    ).resolves.toBe(true);
    await expect(
      adapter.verifyWebhookSignature(payload, "sha256=bad"),
    ).resolves.toBe(false);
  });

  it("normalizes pull request events into review requests", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
      },
    });

    const event = adapter.normalizeWebhookEvent(
      "pull_request",
      pullRequestPayload,
    );

    expect(event.kind).toBe("review_requested");
    if (event.kind !== "review_requested") {
      throw new Error("Expected a review request event.");
    }

    expect(event.repository.owner).toBe("rubenspessoa");
    expect(event.trigger.type).toBe("pr_opened");
    expect(event.mode).toBe("full");
  });

  it("keeps synchronize pull request events in quick mode", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
      },
    });

    const event = adapter.normalizeWebhookEvent("pull_request", {
      ...pullRequestPayload,
      action: "synchronize",
    });

    expect(event.kind).toBe("review_requested");
    if (event.kind !== "review_requested") {
      throw new Error("Expected a review request event.");
    }

    expect(event.trigger.type).toBe("pr_synchronized");
    expect(event.mode).toBe("quick");
  });

  it("ignores unsupported pull request actions instead of throwing", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
      },
    });

    const event = adapter.normalizeWebhookEvent("pull_request", {
      ...pullRequestPayload,
      action: "edited",
    });

    expect(event).toEqual({
      kind: "ignored",
      reason: "Unsupported pull_request payload.",
    });
  });

  it("normalizes manual commands from issue comments", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("issue_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 5001,
        body: "@nitpickr full review",
        user: {
          login: "maintainer",
        },
      },
    });

    expect(event.kind).toBe("review_requested");
    if (event.kind !== "review_requested") {
      throw new Error("Expected a review request event.");
    }

    expect(event.trigger.type).toBe("manual_command");
    if (event.trigger.type !== "manual_command") {
      throw new Error("Expected a manual command trigger.");
    }

    expect(event.trigger.command).toBe("full_review");
    expect(event.mode).toBe("full");
  });

  it("normalizes edited issue comments into manual review requests", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("issue_comment", {
      action: "edited",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 5002,
        body: "@nitpickr review",
        user: {
          login: "maintainer",
        },
      },
      changes: { body: { from: "looks good" } },
    });

    expect(event.kind).toBe("review_requested");
    if (event.kind !== "review_requested") {
      throw new Error("Expected a review request event.");
    }

    expect(event.trigger.type).toBe("manual_command");
    if (event.trigger.type !== "manual_command") {
      throw new Error("Expected a manual command trigger.");
    }

    expect(event.trigger.command).toBe("review");
    expect(event.mode).toBe("quick");
  });

  it("ignores an edit to a comment that already had the command", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });
    const event = adapter.normalizeWebhookEvent("issue_comment", {
      action: "edited",
      installation: { id: 123456 },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: { login: "rubenspessoa" },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 5002,
        body: "@nitpickr review please",
        user: { login: "maintainer" },
      },
      changes: { body: { from: "@nitpickr review plz" } },
    });
    expect(event.kind).toBe("ignored");
  });

  it("accepts flexible manual command formatting", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("issue_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 5003,
        body: "please @getnitpickr: full-review",
        user: {
          login: "maintainer",
        },
      },
    });

    expect(event.kind).toBe("review_requested");
    if (event.kind !== "review_requested") {
      throw new Error("Expected a review request event.");
    }

    expect(event.trigger.type).toBe("manual_command");
    if (event.trigger.type !== "manual_command") {
      throw new Error("Expected a manual command trigger.");
    }

    expect(event.trigger.command).toBe("full_review");
    expect(event.mode).toBe("full");
  });

  it("normalizes issue comment interaction commands into interaction requests", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("issue_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 5003,
        body: "@getnitpickr status",
        user: {
          login: "maintainer",
        },
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        kind: "interaction_requested",
        pullNumber: 42,
        command: "status",
      }),
    );
  });

  it("captures learn interaction arguments from issue comments", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("issue_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 5004,
        body: "@getnitpickr learn prefer explicit guards in API handlers",
        user: {
          login: "maintainer",
        },
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        kind: "interaction_requested",
        pullNumber: 42,
        command: "learn",
        source: expect.objectContaining({
          argumentText: "prefer explicit guards in API handlers",
        }),
      }),
    );
  });

  it("normalizes review-thread replies into interaction requests", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("pull_request_review_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      pull_request: {
        number: 42,
      },
      comment: {
        id: 7001,
        body: "why",
        in_reply_to_id: 6001,
        path: "src/api/server.ts",
        line: 27,
        user: {
          login: "maintainer",
        },
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        kind: "interaction_requested",
        pullNumber: 42,
        command: "why",
        replyTargetCommentId: 6001,
      }),
    );
  });

  it("captures interaction arguments from review-thread replies", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("pull_request_review_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      pull_request: {
        number: 42,
      },
      comment: {
        id: 7002,
        body: "fix add an explicit guard before parsing",
        in_reply_to_id: 6001,
        path: "src/api/server.ts",
        line: 27,
        user: {
          login: "maintainer",
        },
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        kind: "interaction_requested",
        pullNumber: 42,
        command: "ask",
        replyTargetCommentId: 6001,
        source: expect.objectContaining({
          argumentText: "fix add an explicit guard before parsing",
        }),
      }),
    );
  });

  it("turns free-form mentions into questions", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const event = adapter.normalizeWebhookEvent("issue_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 5004,
        body: "@nitpickr ship it",
        user: {
          login: "maintainer",
        },
      },
    });

    expect(event).toEqual(
      expect.objectContaining({
        kind: "interaction_requested",
        command: "ask",
        source: expect.objectContaining({ argumentText: "ship it" }),
      }),
    );
  });

  it("ignores comments written by the bot itself", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 1,
        privateKey: "key",
        webhookSecret: "secret",
        webhookUrl: "https://example.com/webhooks/github",
        botLogins: ["nitpickrai"],
      },
    });
    const event = adapter.normalizeWebhookEvent("pull_request_review_comment", {
      action: "created",
      installation: { id: 123456 },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: { login: "rubenspessoa" },
        default_branch: "main",
      },
      pull_request: { number: 42 },
      comment: {
        id: 7001,
        body: "Fair point. I re-checked it and the finding was wrong.",
        in_reply_to_id: 7000,
        user: { login: "nitpickrai[bot]" },
      },
    });

    expect(event).toMatchObject({ kind: "ignored" });
  });

  it("reacts to issue comments that mention the bot", async () => {
    const apiClient = new FakeGitHubApiClient();
    const adapter = new GitHubAdapter({
      apiClient,
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["nitpickr", "getnitpickr"],
      },
    });

    const reaction = await adapter.reactToMention("issue_comment", {
      action: "created",
      installation: {
        id: 123456,
      },
      repository: {
        id: 99,
        name: "nitpickr",
        owner: {
          login: "rubenspessoa",
        },
        default_branch: "main",
      },
      issue: {
        number: 42,
        pull_request: {
          url: "https://api.github.com/repos/rubenspessoa/nitpickr/pulls/42",
        },
      },
      comment: {
        id: 7001,
        body: "hey @getnitpickr can you review this?",
        user: {
          login: "maintainer",
        },
      },
    });

    expect(reaction).toEqual({
      commentId: 7001,
      content: "eyes",
    });
    expect(apiClient.reactions).toEqual([
      {
        installationId: "123456",
        owner: "rubenspessoa",
        repo: "nitpickr",
        commentId: 7001,
        content: "eyes",
      },
    ]);
  });

  it("loads normalized change request context from the GitHub API", async () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
      },
    });

    const context = await adapter.fetchChangeRequestContext({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
      tenantId: "tenant_1",
      repositoryId: "repo_1",
    });

    expect(context.changeRequest.number).toBe(42);
    expect(context.files[0]?.path).toBe("src/queue/queue-scheduler.ts");
    expect(context.comments).toHaveLength(2);
  });

  it("loads latest-push delta files from the compare API", async () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
      },
    });

    const files = await adapter.comparePullRequestRange({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(files).toEqual([
      {
        path: "src/api/server.ts",
        status: "modified",
        additions: 5,
        deletions: 1,
        patch: "@@ -1,1 +1,2 @@\n+guard",
        previousPath: null,
      },
    ]);
  });

  it("lists and resolves nitpickr review threads", async () => {
    const apiClient = new FakeGitHubApiClient();
    const adapter = new GitHubAdapter({
      apiClient,
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
        botLogins: ["getnitpickr"],
      },
    });

    const threads = await adapter.listNitpickrReviewThreads({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      pullNumber: 42,
    });

    expect(threads).toEqual([
      {
        threadId: "thread_1",
        providerCommentId: "6001",
        path: "src/api/server.ts",
        line: 27,
        fingerprint: "fp_1",
        isResolved: false,
        body: [
          "⚠️ 🧩 **Guard the parse**",
          "**Where:** `src/api/server.ts:27`",
          "",
          "The webhook parser should reject invalid payloads before queueing work.",
          "",
          "<!-- nitpickr:fingerprint:fp_1 -->",
          "<details>",
          "<summary>🤖 AI prompt</summary>",
          "",
          "```text",
          "In `src/api/server.ts` around line 27, add an early validation guard before queueing.",
          "```",
          "",
          "</details>",
        ].join("\n"),
        reactionSummary: {
          positiveCount: 0,
          negativeCount: 0,
        },
      },
    ]);

    await expect(
      adapter.resolveReviewThread({
        installationId: "123456",
        threadId: "thread_1",
      }),
    ).resolves.toBeUndefined();
  });

  it("ignores malformed webhook payloads", () => {
    const adapter = new GitHubAdapter({
      apiClient: new FakeGitHubApiClient(),
      appConfig: {
        appId: 123456,
        privateKey: "test",
        webhookSecret: "super-secret",
        webhookUrl: "https://nitpickr.example.com/webhooks/github",
      },
    });

    expect(
      adapter.normalizeWebhookEvent("pull_request", {
        action: "opened",
      }),
    ).toEqual({
      kind: "ignored",
      reason: "Unsupported pull_request payload.",
    });
  });
});

describe("classifyInteraction", () => {
  const bots = ["nitpickrai"];
  it.each([
    ["@nitpickrai why", false, "why", null],
    [
      "@nitpickrai why does the retry sleep 5s?",
      false,
      "ask",
      "why does the retry sleep 5s?",
    ],
    [
      "@nitpickrai help me understand the queue",
      false,
      "ask",
      "help me understand the queue",
    ],
    [
      "@nitpickrai learn prefer explicit guards in API handlers",
      false,
      "learn",
      "prefer explicit guards in API handlers",
    ],
    ["@nitpickrai", false, "help", null],
    [
      "In retry.ts:\n@nitpickrai is this safe?",
      false,
      "ask",
      "In retry.ts:\nis this safe?",
    ],
    [
      "Why is this a problem? input is validated upstream",
      true,
      "ask",
      "Why is this a problem? input is validated upstream",
    ],
    ["reconsider", true, "reconsider", null],
  ])("%s", (body, inThread, command, argumentText) => {
    expect(classifyInteraction(body, bots, { inThread })).toEqual({
      command,
      argumentText,
    });
  });

  it.each([
    ["Thanks @nitpickrai!", false],
    ["> @nitpickrai why\nagreed with the above", false],
    ["```\n@nitpickrai review\n```", false],
    ["@alice can you take this?", true],
    ["thanks, done", true],
  ])("ignores %s", (body, inThread) => {
    expect(classifyInteraction(body, bots, { inThread })).toBeNull();
  });
});
