import { describe, expect, it } from "vitest";

import { ReviewStatusPublisher } from "../../src/publisher/review-status-publisher.js";

class FakeReviewStatusClient {
  readonly calls: Array<Record<string, unknown>> = [];

  async createCheckRun(input: Record<string, unknown>): Promise<{
    checkRunId: string;
  }> {
    this.calls.push({
      type: "create",
      ...input,
    });
    return {
      checkRunId: "check-run-1",
    };
  }

  async updateCheckRun(input: Record<string, unknown>): Promise<void> {
    this.calls.push({
      type: "update",
      ...input,
    });
  }
}

describe("ReviewStatusPublisher", () => {
  it("creates a running check run and returns its id", async () => {
    const client = new FakeReviewStatusClient();
    const publisher = new ReviewStatusPublisher(client);

    const checkRunId = await publisher.markPending({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reviewRunId: "review_run_1",
      description: "nitpickr review is running.",
    });

    expect(checkRunId).toBe("check-run-1");
    expect(client.calls).toEqual([
      {
        type: "create",
        installationId: "123456",
        repository: {
          owner: "rubenspessoa",
          name: "nitpickr",
        },
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        name: "nitpickr / review",
        externalId: "review_run_1",
        status: "in_progress",
        title: "nitpickr review is running",
        summary: "nitpickr review is running.",
      },
    ]);
  });

  it("updates completed check runs for published and skipped reviews", async () => {
    const client = new FakeReviewStatusClient();
    const publisher = new ReviewStatusPublisher(client);

    await publisher.markPublished({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      checkRunId: "check-run-1",
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reviewRunId: "review_run_1",
      description: "nitpickr review completed successfully.",
      summary: "2 findings published.",
    });
    await publisher.markSkipped({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      checkRunId: "check-run-2",
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reviewRunId: "review_run_2",
      description: "nitpickr skipped inline review for this change.",
      summary: "Summary-only fallback applied.",
    });

    expect(client.calls).toEqual([
      {
        type: "update",
        installationId: "123456",
        repository: {
          owner: "rubenspessoa",
          name: "nitpickr",
        },
        checkRunId: "check-run-1",
        status: "completed",
        conclusion: "success",
        title: "nitpickr review completed",
        summary: "2 findings published.",
      },
      {
        type: "update",
        installationId: "123456",
        repository: {
          owner: "rubenspessoa",
          name: "nitpickr",
        },
        checkRunId: "check-run-2",
        status: "completed",
        conclusion: "neutral",
        title: "nitpickr review skipped",
        summary: "Summary-only fallback applied.",
      },
    ]);
  });

  it("creates or updates failed check runs depending on whether a run id already exists", async () => {
    const client = new FakeReviewStatusClient();
    const publisher = new ReviewStatusPublisher(client);

    await publisher.markFailed({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reviewRunId: "review_run_1",
      description: "nitpickr publish failure.",
      summary: "GitHub returned 502 while publishing review comments.",
      retryable: true,
    });
    await publisher.markFailed({
      installationId: "123456",
      repository: {
        owner: "rubenspessoa",
        name: "nitpickr",
      },
      checkRunId: "check-run-2",
      sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      reviewRunId: "review_run_2",
      description: "nitpickr malformed model output.",
      summary: "The model returned invalid structured fields.",
      retryable: false,
    });

    expect(client.calls).toEqual([
      {
        type: "create",
        installationId: "123456",
        repository: {
          owner: "rubenspessoa",
          name: "nitpickr",
        },
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        name: "nitpickr / review",
        externalId: "review_run_1",
        status: "completed",
        conclusion: "neutral",
        title: "nitpickr review retry scheduled",
        summary: "GitHub returned 502 while publishing review comments.",
      },
      {
        type: "update",
        installationId: "123456",
        repository: {
          owner: "rubenspessoa",
          name: "nitpickr",
        },
        checkRunId: "check-run-2",
        status: "completed",
        conclusion: "failure",
        title: "nitpickr review failed",
        summary: "The model returned invalid structured fields.",
      },
    ]);
  });
});

describe("queued review checks", () => {
  const repository = { owner: "o", name: "r" };

  it("creates a queued check and later moves the same check to in progress", async () => {
    const client = new FakeReviewStatusClient();
    const publisher = new ReviewStatusPublisher(client);
    const queued = await publisher.markQueued({
      installationId: "1",
      repository,
      sha: "a".repeat(40),
      externalId: "job_1",
    });
    const running = await publisher.markPending({
      installationId: "1",
      repository,
      sha: "a".repeat(40),
      reviewRunId: "run_1",
      description: "nitpickr review is running.",
      checkRunId: queued,
    });
    expect(running).toBe(queued);
    expect(client.calls.map((call) => [call.type, call.status])).toEqual([
      ["create", "queued"],
      ["update", "in_progress"],
    ]);
  });

  it("closes a superseded check as neutral", async () => {
    const client = new FakeReviewStatusClient();
    await new ReviewStatusPublisher(client).markSuperseded({
      installationId: "1",
      repository,
      checkRunId: "check-run-1",
    });
    expect(client.calls[0]).toMatchObject({
      type: "update",
      status: "completed",
      conclusion: "neutral",
      title: "Superseded by a newer push",
    });
  });
});
