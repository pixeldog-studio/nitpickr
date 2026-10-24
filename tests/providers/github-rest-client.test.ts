import { describe, expect, it } from "vitest";

import { GitHubRestClient } from "../../src/providers/github/github-rest-client.js";

describe("GitHubRestClient", () => {
  it("fetches a pull request", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify({
            id: 101,
            number: 42,
            title: "Improve queue fairness",
            state: "open",
            draft: false,
            user: { login: "ruben" },
            base: {
              sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              ref: "main",
            },
            head: {
              sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              ref: "feature",
            },
          }),
          { status: 200 },
        ),
    );

    const pullRequest = (await client.getPullRequest({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
    })) as { number: number };

    expect(pullRequest.number).toBe(42);
  });

  it("lists pull request files", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify([
            {
              filename: "src/queue/queue-scheduler.ts",
              status: "modified",
              additions: 4,
              deletions: 1,
              patch: "@@ -1 +1 @@\n+stable ordering",
            },
          ]),
          { status: 200 },
        ),
    );

    const files = (await client.listPullRequestFiles({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
    })) as Array<{ filename: string }>;

    expect(files[0]?.filename).toBe("src/queue/queue-scheduler.ts");
  });

  it("reads repository file contents", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify({
            type: "file",
            content: Buffer.from("review: {}\n", "utf8").toString("base64"),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    );

    const contents = await client.readTextFile({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      path: ".nitpickr.yml",
      ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(contents).toContain("review:");
  });

  it("skips file contents that contain NUL bytes", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify({
            type: "file",
            content: Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01]).toString(
              "base64",
            ),
            encoding: "base64",
          }),
          { status: 200 },
        ),
    );

    const contents = await client.getFileContent({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      path: "assets/logo.png",
      ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(contents).toBeNull();
  });

  it("lists files in a repository directory", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify([
            {
              type: "file",
              path: ".nitpickr/review.md",
            },
            {
              type: "file",
              path: ".nitpickr/api.md",
            },
          ]),
          { status: 200 },
        ),
    );

    const files = await client.listFiles({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      path: ".nitpickr",
      ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(files).toEqual([".nitpickr/review.md", ".nitpickr/api.md"]);
  });

  it("returns an empty file list when a repository directory does not exist", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify({
            message: "Not Found",
          }),
          { status: 404 },
        ),
    );

    const files = await client.listFiles({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      path: ".nitpickr",
      ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(files).toEqual([]);
  });

  it("publishes a pull request review", async () => {
    let capturedBody = "";
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async (_input, init) => {
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: 777 }), { status: 200 });
      },
    );

    const result = await client.publishPullRequestReview({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
      body: "summary",
      comments: [
        {
          path: "src/queue/queue-scheduler.ts",
          line: 18,
          side: "RIGHT",
          body: "comment",
        },
      ],
    });

    expect(result.reviewId).toBe("777");
    expect(capturedBody).toContain("summary");
    expect(capturedBody).toContain('"side":"RIGHT"');
  });

  it("lists pull request reviews for idempotent publish checks", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 777,
              body: "<!-- nitpickr:review-run:review_run_1 -->\nsummary",
              state: "COMMENTED",
            },
          ]),
          { status: 200 },
        ),
    );

    const reviews = await client.listPullRequestReviews({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
    });

    expect(reviews).toEqual([
      {
        id: 777,
        body: "<!-- nitpickr:review-run:review_run_1 -->\nsummary",
        state: "COMMENTED",
      },
    ]);
  });

  it("creates and updates check runs for review state updates", async () => {
    let requestedUrl = "";
    let capturedBody = "";
    let method = "";
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async (input, init) => {
        requestedUrl = String(input);
        method = String(init?.method ?? "GET");
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: 88 }), { status: 201 });
      },
    );

    const created = await client.createCheckRun({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "nitpickr / review",
      externalId: "review_run_1",
      status: "in_progress",
      title: "nitpickr review is running",
      summary: "nitpickr review is running.",
    });

    expect(created).toEqual({
      checkRunId: "88",
    });
    expect(method).toBe("POST");
    expect(requestedUrl).toBe(
      "https://api.github.com/repos/example-owner/nitpickr/check-runs",
    );
    expect(capturedBody).toContain('"name":"nitpickr / review"');
    expect(capturedBody).toContain('"status":"in_progress"');
    expect(capturedBody).toContain('"external_id":"review_run_1"');

    await client.updateCheckRun({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      checkRunId: "88",
      status: "completed",
      conclusion: "success",
      title: "nitpickr review completed",
      summary: "2 findings published.",
    });

    expect(method).toBe("PATCH");
    expect(requestedUrl).toBe(
      "https://api.github.com/repos/example-owner/nitpickr/check-runs/88",
    );
    expect(capturedBody).toContain('"status":"completed"');
    expect(capturedBody).toContain('"conclusion":"success"');
  });

  it("reacts to issue comments", async () => {
    let requestedUrl = "";
    let capturedBody = "";
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async (input, init) => {
        requestedUrl = String(input);
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: 55 }), { status: 201 });
      },
    );

    await client.createIssueCommentReaction({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      commentId: 9001,
      content: "eyes",
    });

    expect(requestedUrl).toBe(
      "https://api.github.com/repos/example-owner/nitpickr/issues/comments/9001/reactions",
    );
    expect(capturedBody).toBe('{"content":"eyes"}');
  });

  it("compares two heads to get the latest push delta", async () => {
    let requestedUrl = "";
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            files: [
              {
                filename: "src/api/server.ts",
                status: "modified",
                additions: 5,
                deletions: 1,
                patch: "@@ -1,1 +1,2 @@\n+guard",
              },
            ],
          }),
          { status: 200 },
        );
      },
    );

    const files = await client.comparePullRequestRange({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });

    expect(files).toEqual([
      {
        filename: "src/api/server.ts",
        status: "modified",
        additions: 5,
        deletions: 1,
        patch: "@@ -1,1 +1,2 @@\n+guard",
      },
    ]);
    expect(requestedUrl).toBe(
      "https://api.github.com/repos/example-owner/nitpickr/compare/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    );
  });

  it("keeps outdated threads using their original line", async () => {
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async () =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread_outdated",
                        isResolved: false,
                        isOutdated: true,
                        comments: {
                          nodes: [
                            {
                              id: "comment_9",
                              databaseId: 9001,
                              body: "Missing timeout\n<!-- nitpickr:fingerprint:fp_9 -->",
                              author: { login: "getnitpickr" },
                              path: "src/users.ts",
                              line: null,
                              originalLine: 5,
                              reactionGroups: [],
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
          { status: 200 },
        ),
    );

    const threads = await client.listNitpickrReviewThreads({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
      botLogins: ["getnitpickr"],
    });

    expect(threads).toEqual([
      expect.objectContaining({
        threadId: "thread_outdated",
        line: 5,
        isOutdated: true,
        isResolved: false,
      }),
    ]);
  });

  it("lists nitpickr review threads and resolves them through GraphQL", async () => {
    const requestedBodies: string[] = [];
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async (_input, init) => {
        const body = String(init?.body ?? "");
        requestedBodies.push(body);
        if (body.includes("reviewThreads")) {
          return new Response(
            JSON.stringify({
              data: {
                repository: {
                  pullRequest: {
                    reviewThreads: {
                      nodes: [
                        {
                          id: "thread_1",
                          isResolved: false,
                          comments: {
                            nodes: [
                              {
                                id: "comment_1",
                                databaseId: 6001,
                                body: [
                                  "nitpickr comment",
                                  "<!-- nitpickr:fingerprint:fp_1 -->",
                                ].join("\n"),
                                author: {
                                  login: "getnitpickr",
                                },
                                path: "src/api/server.ts",
                                line: 27,
                                reactionGroups: [
                                  {
                                    content: "THUMBS_UP",
                                    users: {
                                      totalCount: 2,
                                    },
                                  },
                                  {
                                    content: "HEART",
                                    users: {
                                      totalCount: 1,
                                    },
                                  },
                                  {
                                    content: "CONFUSED",
                                    users: {
                                      totalCount: 1,
                                      nodes: [{ login: "maintainer" }],
                                    },
                                  },
                                ],
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            { status: 200 },
          );
        }

        return new Response(
          JSON.stringify({
            data: {
              resolveReviewThread: {
                thread: {
                  id: "thread_1",
                  isResolved: true,
                },
              },
            },
          }),
          { status: 200 },
        );
      },
    );

    const threads = await client.listNitpickrReviewThreads({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
      botLogins: ["getnitpickr"],
    });

    expect(threads).toEqual([
      {
        threadId: "thread_1",
        providerCommentId: "6001",
        path: "src/api/server.ts",
        line: 27,
        fingerprint: "fp_1",
        isResolved: false,
        isOutdated: false,
        body: ["nitpickr comment", "<!-- nitpickr:fingerprint:fp_1 -->"].join(
          "\n",
        ),
        reactionSummary: {
          positiveCount: 3,
          negativeCount: 1,
          negativeReactors: ["maintainer"],
        },
      },
    ]);

    await client.resolveReviewThread({
      installationId: "123456",
      threadId: "thread_1",
    });

    expect(requestedBodies[0]).toContain("reviewThreads");
    expect(requestedBodies[1]).toContain("resolveReviewThread");
  });

  it("uses a custom GitHub API base URL when configured", async () => {
    let requestedUrl = "";
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async (input) => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            id: 101,
            number: 42,
            title: "Improve queue fairness",
            state: "open",
            draft: false,
            user: { login: "ruben" },
            base: {
              sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              ref: "main",
            },
            head: {
              sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              ref: "feature",
            },
          }),
          { status: 200 },
        );
      },
      {
        baseUrl: "http://github-stub:4010/",
      },
    );

    await client.getPullRequest({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
    });

    expect(requestedUrl).toBe(
      "http://github-stub:4010/repos/example-owner/nitpickr/pulls/42",
    );
  });

  it("creates issue comments and review comment replies", async () => {
    const requestedUrls: string[] = [];
    const requestedBodies: string[] = [];
    const client = new GitHubRestClient(
      {
        async getInstallationAccessToken() {
          return "ghs_token";
        },
      },
      async (input, init) => {
        requestedUrls.push(String(input));
        requestedBodies.push(String(init?.body ?? ""));

        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
      },
    );

    await client.createIssueComment({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      issueNumber: 42,
      body: "status reply",
    });
    await client.replyToReviewComment({
      installationId: "123456",
      owner: "example-owner",
      repo: "nitpickr",
      pullNumber: 42,
      commentId: 7001,
      body: "thread reply",
    });

    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/example-owner/nitpickr/issues/42/comments",
      "https://api.github.com/repos/example-owner/nitpickr/pulls/42/comments",
    ]);
    expect(requestedBodies).toEqual([
      JSON.stringify({
        body: "status reply",
      }),
      JSON.stringify({
        body: "thread reply",
        in_reply_to: 7001,
      }),
    ]);
  });
});
