import { describe, expect, it } from "vitest";

import { GitHubWebhookService } from "../../src/api/github-webhook-service.js";
import type { GitHubNormalizedEvent } from "../../src/providers/github/github-adapter.js";
import type {
  EnqueueJobInput,
  QueueJob,
} from "../../src/queue/queue-scheduler.js";

class FakeLogger {
  readonly entries: Array<{
    level: string;
    message: string;
    fields: Record<string, unknown>;
  }> = [];

  debug(message: string, fields: Record<string, unknown> = {}) {
    this.entries.push({ level: "debug", message, fields });
  }

  info(message: string, fields: Record<string, unknown> = {}) {
    this.entries.push({ level: "info", message, fields });
  }

  warn(message: string, fields: Record<string, unknown> = {}) {
    this.entries.push({ level: "warn", message, fields });
  }

  error(message: string, fields: Record<string, unknown> = {}) {
    this.entries.push({ level: "error", message, fields });
  }

  child(fields: Record<string, unknown>) {
    return {
      debug: (message: string, entryFields: Record<string, unknown> = {}) =>
        this.debug(message, { ...fields, ...entryFields }),
      info: (message: string, entryFields: Record<string, unknown> = {}) =>
        this.info(message, { ...fields, ...entryFields }),
      warn: (message: string, entryFields: Record<string, unknown> = {}) =>
        this.warn(message, { ...fields, ...entryFields }),
      error: (message: string, entryFields: Record<string, unknown> = {}) =>
        this.error(message, { ...fields, ...entryFields }),
      child: (childFields: Record<string, unknown>) =>
        this.child({ ...fields, ...childFields }),
    };
  }
}

class FakeQueueScheduler {
  readonly calls: EnqueueJobInput[] = [];

  async enqueue(input: EnqueueJobInput): Promise<QueueJob> {
    this.calls.push(input);
    return {
      id: "job_1",
      type: input.type,
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      changeRequestId: input.changeRequestId,
      dedupeKey: input.dedupeKey,
      priority: input.priority,
      status: "queued",
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      payload: input.payload,
      createdAt: new Date("2026-03-09T10:00:00.000Z"),
      scheduledAt: new Date("2026-03-09T10:00:00.000Z"),
      startedAt: null,
      completedAt: null,
      workerId: null,
      lastError: null,
    };
  }
}

class FakeWebhookEventService {
  received: string[] = [];
  queued: string[] = [];
  ignored: string[] = [];
  failed: string[] = [];
  duplicates = new Set<string>();
  markFailedError: Error | null = null;
  beginDeliveryError: Error | null = null;

  async beginDelivery(input: { deliveryId: string }) {
    if (this.beginDeliveryError) {
      throw this.beginDeliveryError;
    }
    this.received.push(input.deliveryId);
    return this.duplicates.has(input.deliveryId) ? "duplicate" : "new";
  }

  async markQueued(input: { deliveryId: string }) {
    this.queued.push(input.deliveryId);
  }

  async markIgnored(input: { deliveryId: string }) {
    this.ignored.push(input.deliveryId);
  }

  async markFailed(input: { deliveryId: string }) {
    if (this.markFailedError) {
      throw this.markFailedError;
    }
    this.failed.push(input.deliveryId);
  }
}

class FakeGitHubAdapter {
  signatureValid = true;
  normalizeWebhookEventCalls = 0;
  reactToMentionCalls = 0;
  mentionReaction: {
    commentId: number;
    content: "eyes";
  } | null = null;
  mentionReactionError: Error | null = null;
  normalizedEvent: GitHubNormalizedEvent = {
    kind: "review_requested",
    installationId: "123456",
    repository: {
      installationId: "123456",
      repositoryId: "github:99",
      providerRepositoryId: 99,
      owner: "rubenspessoa",
      name: "nitpickr",
      defaultBranch: "main",
    },
    pullNumber: 42,
    trigger: {
      type: "pr_opened",
      actorLogin: "ruben",
    },
    mode: "full",
    actorLogin: "ruben",
  };

  async verifyWebhookSignature(): Promise<boolean> {
    return this.signatureValid;
  }

  normalizeWebhookEvent(): GitHubNormalizedEvent {
    this.normalizeWebhookEventCalls += 1;
    return this.normalizedEvent;
  }

  async reactToMention() {
    this.reactToMentionCalls += 1;
    if (this.mentionReactionError) {
      throw this.mentionReactionError;
    }

    return this.mentionReaction;
  }
}

describe("GitHubWebhookService", () => {
  it("ignores events from repositories outside the allowlist without side effects", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      new FakeLogger(),
      { repositoryAllowlist: ["rubenspessoa/nitpickr-ollama-test"] },
    );

    const result = await service.handle({
      deliveryId: "delivery-outside",
      eventName: "issue_comment",
      signature: "sha256=test",
      rawBody: "{}",
      payload: { repository: { full_name: "rubenspessoa/ai-automation" } },
    });

    expect(result).toEqual({
      statusCode: 202,
      accepted: false,
      message:
        "Repository rubenspessoa/ai-automation is not in NITPICKR_REPOSITORY_ALLOWLIST.",
    });
    expect(adapter.reactToMentionCalls).toBe(0);
    expect(adapter.normalizeWebhookEventCalls).toBe(0);
    expect(queue.calls).toHaveLength(0);
    expect(webhookEvents.ignored).toEqual(["delivery-outside"]);
  });

  it("queues events from allowlisted repositories, ignoring case", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      new FakeWebhookEventService(),
      new FakeLogger(),
      { repositoryAllowlist: ["RubensPessoa/Nitpickr"] },
    );

    const result = await service.handle({
      deliveryId: "delivery-inside",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: { repository: { full_name: "rubenspessoa/nitpickr" } },
    });

    expect(result.accepted).toBe(true);
    expect(queue.calls).toHaveLength(1);
  });

  it("enqueues review jobs for supported GitHub events", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-1",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(202);
    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]?.type).toBe("review_requested");
    expect(queue.calls[0]?.tenantId).toBe("github-installation:123456");
    expect(queue.calls[0]?.payload.trigger).toEqual({
      type: "pr_opened",
      actorLogin: "ruben",
    });
    expect(webhookEvents.queued).toEqual(["delivery-1"]);
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "Queued GitHub review job.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-1",
        deliveryId: "delivery-1",
        eventName: "pull_request",
        installationId: "123456",
        repositoryId: "github:99",
        pullNumber: 42,
        mode: "full",
      },
    });
  });

  it("keys automatic review jobs by head commit", async () => {
    const adapter = new FakeGitHubAdapter();
    const headSha = "a".repeat(40);
    adapter.normalizedEvent = {
      ...adapter.normalizedEvent,
      kind: "review_requested",
      trigger: { type: "pr_synchronized", actorLogin: "ruben" },
      mode: "quick",
      headSha,
    } as GitHubNormalizedEvent;
    const queue = new FakeQueueScheduler();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      new FakeWebhookEventService(),
      new FakeLogger(),
    );

    await service.handle({
      deliveryId: "delivery-sync",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(queue.calls[0]?.dedupeKey).toBe(`github:99:42:quick:${headSha}`);
    expect(queue.calls[0]?.payload.headSha).toBe(headSha);
  });

  it("reacts to issue comment mentions before queueing work", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.mentionReaction = {
      commentId: 9001,
      content: "eyes",
    };
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-2",
      eventName: "issue_comment",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(202);
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "Reacted to GitHub bot mention.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-2",
        deliveryId: "delivery-2",
        eventName: "issue_comment",
        commentId: 9001,
        content: "eyes",
      },
    });
  });

  it("enqueues interaction jobs for supported reviewer chat commands", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.normalizedEvent = {
      kind: "interaction_requested",
      installationId: "123456",
      repository: {
        installationId: "123456",
        repositoryId: "github:99",
        providerRepositoryId: 99,
        owner: "rubenspessoa",
        name: "nitpickr",
        defaultBranch: "main",
      },
      pullNumber: 42,
      actorLogin: "maintainer",
      command: "status",
      source: {
        kind: "issue_comment",
        commentId: 9001,
        body: "@getnitpickr status",
        argumentText: null,
      },
    };
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-interaction",
      eventName: "issue_comment",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(202);
    expect(queue.calls[0]).toEqual(
      expect.objectContaining({
        type: "interaction_requested",
        payload: expect.objectContaining({
          command: "status",
          source: expect.objectContaining({
            kind: "issue_comment",
            commentId: 9001,
          }),
        }),
      }),
    );
  });

  it("logs mention reaction failures without rejecting the webhook", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.mentionReactionError = new Error("reaction failed");
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-3",
      eventName: "issue_comment",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(202);
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "Failed to react to GitHub bot mention.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-3",
        deliveryId: "delivery-3",
        eventName: "issue_comment",
        error: "reaction failed",
      },
    });
  });

  it("catches synchronous mention reaction failures without rejecting the webhook", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.reactToMention = () => {
      throw new Error("sync reaction failed");
    };
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-sync-reaction",
      eventName: "issue_comment",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(202);
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "Failed to react to GitHub bot mention.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-sync-reaction",
        deliveryId: "delivery-sync-reaction",
        eventName: "issue_comment",
        error: "sync reaction failed",
      },
    });
  });

  it("rejects invalid signatures", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.signatureValid = false;
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-4",
      eventName: "pull_request",
      signature: "sha256=bad",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(401);
    expect(queue.calls).toEqual([]);
    expect(webhookEvents.received).toEqual([]);
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "Rejected GitHub webhook with invalid signature.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-4",
        deliveryId: "delivery-4",
        eventName: "pull_request",
      },
    });
  });

  it("ignores unsupported events without queueing work", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.normalizedEvent = {
      kind: "ignored",
      reason: "unsupported",
    };
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-5",
      eventName: "issue_comment",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(202);
    expect(result.accepted).toBe(false);
    expect(queue.calls).toEqual([]);
    expect(webhookEvents.ignored).toEqual(["delivery-5"]);
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "Ignored GitHub webhook event.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-5",
        deliveryId: "delivery-5",
        eventName: "issue_comment",
        reason: "unsupported",
      },
    });
  });

  it("dedupes repeated webhook deliveries before queueing", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    webhookEvents.duplicates.add("delivery-dup");
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-dup",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(202);
    expect(result.accepted).toBe(false);
    expect(result.message).toBe("Duplicate GitHub webhook delivery ignored.");
    expect(queue.calls).toEqual([]);
    expect(webhookEvents.ignored).toEqual([]);
    expect(adapter.reactToMentionCalls).toBe(0);
    expect(adapter.normalizeWebhookEventCalls).toBe(0);
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "Ignored duplicate GitHub webhook delivery.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-dup",
        deliveryId: "delivery-dup",
        eventName: "pull_request",
      },
    });
  });

  it("returns a controlled failure when delivery registration throws", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    webhookEvents.beginDeliveryError = new Error("db unavailable");
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-store-fail",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result).toEqual({
      statusCode: 500,
      accepted: false,
      message: "Failed to process GitHub webhook event.",
    });
    expect(queue.calls).toEqual([]);
    expect(adapter.reactToMentionCalls).toBe(0);
    expect(adapter.normalizeWebhookEventCalls).toBe(0);
    expect(logger.entries).toContainEqual({
      level: "error",
      message: "GitHub webhook delivery registration failed.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-store-fail",
        deliveryId: "delivery-store-fail",
        eventName: "pull_request",
        error: "db unavailable",
        alertable: true,
        monitoringKey: "webhook_delivery_registration_failure",
      },
    });
  });

  it("awaits asynchronous signature verification before accepting the webhook", async () => {
    const adapter = new FakeGitHubAdapter();
    adapter.verifyWebhookSignature = async () =>
      await new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 0);
      });
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-async-signature",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(401);
    expect(queue.calls).toEqual([]);
    expect(webhookEvents.received).toEqual([]);
  });

  it("logs webhook event persistence failures without swallowing the original webhook error", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const webhookEvents = new FakeWebhookEventService();
    webhookEvents.markFailedError = new Error("db write failed");
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    adapter.normalizeWebhookEvent = () => {
      throw new Error("boom");
    };

    const result = await service.handle({
      deliveryId: "delivery-fail",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(500);
    expect(result.accepted).toBe(false);
    expect(result.message).toBe("Failed to process GitHub webhook event.");
    expect(logger.entries).toContainEqual({
      level: "error",
      message: "Failed to persist GitHub webhook event status.",
      fields: {
        component: "github-webhook",
        deliveryId: "delivery-fail",
        status: "failed",
        alertable: true,
        monitoringKey: "webhook_event_persistence_failure",
        error: "db write failed",
      },
    });
    expect(logger.entries).toContainEqual({
      level: "error",
      message: "GitHub webhook event normalization failed.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-fail",
        deliveryId: "delivery-fail",
        eventName: "pull_request",
        error: "boom",
      },
    });
  });

  it("logs queueing failures with queue-specific context", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    queue.enqueue = async () => {
      throw new Error("queue unavailable");
    };
    const webhookEvents = new FakeWebhookEventService();
    const logger = new FakeLogger();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    const result = await service.handle({
      deliveryId: "delivery-queue-fail",
      eventName: "pull_request",
      signature: "sha256=test",
      rawBody: "{}",
      payload: {},
    });

    expect(result.statusCode).toBe(500);
    expect(result.accepted).toBe(false);
    expect(webhookEvents.failed).toEqual(["delivery-queue-fail"]);
    expect(logger.entries).toContainEqual({
      level: "error",
      message: "GitHub webhook queueing failed.",
      fields: {
        component: "github-webhook",
        correlationId: "delivery-queue-fail",
        deliveryId: "delivery-queue-fail",
        eventName: "pull_request",
        repositoryId: "github:99",
        pullNumber: 42,
        error: "queue unavailable",
      },
    });
  });

  it("requires a delivery id for webhook processing", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const logger = new FakeLogger();
    const webhookEvents = new FakeWebhookEventService();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    await expect(() =>
      service.handle({
        deliveryId: "",
        eventName: "pull_request",
        signature: "sha256=test",
        rawBody: "{}",
        payload: {},
      }),
    ).rejects.toThrow(/deliveryId/i);
  });

  it("rejects webhook payloads that are not JSON objects", async () => {
    const adapter = new FakeGitHubAdapter();
    const queue = new FakeQueueScheduler();
    const logger = new FakeLogger();
    const webhookEvents = new FakeWebhookEventService();
    const service = new GitHubWebhookService(
      adapter,
      queue,
      webhookEvents,
      logger,
    );

    await expect(() =>
      service.handle({
        deliveryId: "delivery-bad-payload",
        eventName: "pull_request",
        signature: "sha256=test",
        rawBody: "[]",
        payload: [],
      }),
    ).rejects.toThrow(/payload/i);
  });
});
