import { z } from "zod";

import { type Logger, noopLogger } from "../logging/logger.js";
import { captureError } from "../observability/sentry.js";
import type {
  GitHubAdapter,
  GitHubNormalizedEvent,
} from "../providers/github/github-adapter.js";
import type { ReviewStatusPublisher } from "../publisher/review-status-publisher.js";
import type {
  EnqueueJobInput,
  QueueJob,
  QueueScheduler,
} from "../queue/queue-scheduler.js";
import type { WebhookEventService } from "./webhook-event-service.js";

const webhookRequestSchema = z.object({
  deliveryId: z.string().min(1),
  eventName: z.string().min(1),
  signature: z.string().min(1),
  rawBody: z.string(),
  payload: z.object({}).passthrough(),
});

export interface GitHubWebhookResult {
  statusCode: number;
  accepted: boolean;
  message: string;
}

export interface GitHubWebhookRequest {
  deliveryId: string;
  eventName: string;
  signature: string;
  rawBody: string;
  payload: unknown;
}

export type GitHubWebhookSignatureVerificationResult =
  | boolean
  | "setup_required";

export interface GitHubWebhookHandler {
  verifySignature(
    rawBody: string,
    signature: string,
  ): Promise<GitHubWebhookSignatureVerificationResult>;
  handle(input: GitHubWebhookRequest): Promise<GitHubWebhookResult>;
}

type WebhookEventTracker = Pick<
  WebhookEventService,
  "beginDelivery" | "markFailed" | "markIgnored" | "markQueued"
>;

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function repositoryFullName(payload: Record<string, unknown>): string | null {
  const repository = payload.repository;
  if (typeof repository !== "object" || repository === null) {
    return null;
  }
  const fullName = (repository as { full_name?: unknown }).full_name;
  return typeof fullName === "string" ? fullName : null;
}

function buildChangeRequestId(
  repositoryId: string | undefined,
  pullNumber: number | undefined,
): string | undefined {
  if (!repositoryId || pullNumber === undefined) {
    return undefined;
  }

  return `${repositoryId}:${pullNumber}`;
}

function buildReviewStatusFields(
  event: Extract<
    GitHubNormalizedEvent,
    { kind: "review_requested" | "interaction_requested" }
  >,
): {
  repositoryId: string;
  changeRequestId?: string;
} {
  const changeRequestId = buildChangeRequestId(
    event.repository.repositoryId,
    event.pullNumber,
  );

  return {
    repositoryId: event.repository.repositoryId,
    ...(changeRequestId ? { changeRequestId } : {}),
  };
}

function buildReviewJobInput(
  event: Extract<GitHubNormalizedEvent, { kind: "review_requested" }>,
  correlationId: string,
): EnqueueJobInput {
  return {
    type: "review_requested",
    tenantId: `github-installation:${event.installationId}`,
    repositoryId: event.repository.repositoryId,
    changeRequestId: `${event.repository.repositoryId}:${event.pullNumber}`,
    // Automatic reviews are keyed by commit so a push is never swallowed by a
    // still-running review of an older commit.
    dedupeKey: `${event.repository.repositoryId}:${event.pullNumber}:${event.mode}${
      event.headSha === undefined ? "" : `:${event.headSha}`
    }`,
    priority: event.trigger.type === "manual_command" ? 100 : 50,
    payload: {
      correlationId,
      installationId: event.installationId,
      repository: {
        owner: event.repository.owner,
        name: event.repository.name,
      },
      pullNumber: event.pullNumber,
      mode: event.mode,
      trigger: event.trigger,
      ...(event.headSha === undefined ? {} : { headSha: event.headSha }),
    },
  };
}

function buildInteractionJobInput(
  event: Extract<GitHubNormalizedEvent, { kind: "interaction_requested" }>,
  correlationId: string,
): EnqueueJobInput {
  return {
    type: "interaction_requested",
    tenantId: `github-installation:${event.installationId}`,
    repositoryId: event.repository.repositoryId,
    changeRequestId: `${event.repository.repositoryId}:${event.pullNumber}`,
    dedupeKey: `${event.repository.repositoryId}:${event.pullNumber}:${event.command}:${event.source.commentId}`,
    priority: 80,
    payload: {
      correlationId,
      installationId: event.installationId,
      repository: {
        owner: event.repository.owner,
        name: event.repository.name,
      },
      pullNumber: event.pullNumber,
      actorLogin: event.actorLogin,
      command: event.command,
      ...(event.replyTargetCommentId === undefined
        ? {}
        : { replyTargetCommentId: event.replyTargetCommentId }),
      source: event.source,
    },
  };
}

export class GitHubWebhookService implements GitHubWebhookHandler {
  readonly #adapter: Pick<
    GitHubAdapter,
    "verifyWebhookSignature" | "normalizeWebhookEvent" | "reactToMention"
  >;
  readonly #queueScheduler: Pick<QueueScheduler, "enqueue"> &
    Partial<Pick<QueueScheduler, "attachCheckRun">>;
  readonly #statusPublisher: Pick<
    ReviewStatusPublisher,
    "markQueued" | "markClosed"
  > | null;
  readonly #logger: Logger;
  readonly #webhookEventService: WebhookEventTracker;
  /** Lower-cased `owner/name` entries; `null` allows every repository. */
  readonly #repositoryAllowlist: Set<string> | null;

  constructor(
    adapter: Pick<
      GitHubAdapter,
      "verifyWebhookSignature" | "normalizeWebhookEvent" | "reactToMention"
    >,
    queueScheduler: Pick<QueueScheduler, "enqueue"> &
      Partial<Pick<QueueScheduler, "attachCheckRun">>,
    webhookEventService: WebhookEventTracker,
    logger: Logger = noopLogger,
    options: {
      repositoryAllowlist?: string[] | null;
      statusPublisher?: Pick<
        ReviewStatusPublisher,
        "markQueued" | "markClosed"
      > | null;
    } = {},
  ) {
    this.#adapter = adapter;
    this.#queueScheduler = queueScheduler;
    this.#statusPublisher = options.statusPublisher ?? null;
    this.#logger = logger.child({
      component: "github-webhook",
    });
    this.#webhookEventService = webhookEventService;
    this.#repositoryAllowlist = options.repositoryAllowlist
      ? new Set(options.repositoryAllowlist.map((entry) => entry.toLowerCase()))
      : null;
  }

  /**
   * Put a queued "nitpickr / review" check on the commit right away, so the
   * PR shows nitpickr is coming even while earlier reviews hold the model.
   * Only for a job this delivery created; a deduped job already has one.
   */
  async #showQueued(
    job: QueueJob,
    event: Extract<GitHubNormalizedEvent, { kind: "review_requested" }>,
    deliveryId: string | undefined,
    logger: Logger,
  ): Promise<void> {
    const headSha = job.payload.headSha;
    if (
      this.#statusPublisher === null ||
      !this.#queueScheduler.attachCheckRun ||
      job.status !== "queued" ||
      typeof headSha !== "string" ||
      headSha.length === 0 ||
      (deliveryId !== undefined && job.payload.correlationId !== deliveryId)
    ) {
      return;
    }
    let checkRunId: string | null = null;
    try {
      checkRunId = await this.#statusPublisher.markQueued({
        installationId: event.installationId,
        repository: {
          owner: event.repository.owner,
          name: event.repository.name,
        },
        sha: headSha,
        externalId: job.id,
      });
      const attached = await this.#queueScheduler.attachCheckRun(
        job.id,
        checkRunId,
      );
      if (!attached) {
        // A worker took the job (and opened its own check) or a newer push
        // canceled it while this check was being created.
        await this.#statusPublisher.markClosed({
          installationId: event.installationId,
          repository: {
            owner: event.repository.owner,
            name: event.repository.name,
          },
          checkRunId,
          conclusion: "neutral",
          title: "Handled by another nitpickr check",
          summary:
            "This review already started or was replaced by a newer push.",
        });
      }
    } catch (error) {
      logger.warn("Failed to publish queued review status.", {
        jobId: job.id,
        error: toErrorMessage(error, "Unknown status failure."),
      });
      if (checkRunId !== null) {
        // Created but not attached: the worker can't find it, so close it.
        await this.#statusPublisher
          .markClosed({
            installationId: event.installationId,
            repository: {
              owner: event.repository.owner,
              name: event.repository.name,
            },
            checkRunId,
            conclusion: "neutral",
            title: "Handled by another nitpickr check",
            summary:
              "nitpickr could not track this check; see the review's own check.",
          })
          .catch(() => {});
      }
    }
  }

  async verifySignature(rawBody: string, signature: string): Promise<boolean> {
    return await this.#adapter.verifyWebhookSignature(rawBody, signature);
  }

  async #updateWebhookEventStatus(
    deliveryId: string | undefined,
    status: "failed" | "ignored" | "queued",
    fields: {
      repositoryId?: string;
      changeRequestId?: string;
      errorMessage?: string;
    } = {},
  ): Promise<void> {
    if (!deliveryId) {
      return;
    }

    try {
      if (status === "failed") {
        await this.#webhookEventService.markFailed({
          deliveryId,
          errorMessage: fields.errorMessage ?? "Unknown webhook failure.",
        });
        return;
      }

      if (status === "ignored") {
        await this.#webhookEventService.markIgnored({
          deliveryId,
          ...(fields.repositoryId ? { repositoryId: fields.repositoryId } : {}),
          ...(fields.changeRequestId
            ? { changeRequestId: fields.changeRequestId }
            : {}),
        });
        return;
      }

      await this.#webhookEventService.markQueued({
        deliveryId,
        ...(fields.repositoryId ? { repositoryId: fields.repositoryId } : {}),
        ...(fields.changeRequestId
          ? { changeRequestId: fields.changeRequestId }
          : {}),
      });
    } catch (error) {
      this.#logger.error("Failed to persist GitHub webhook event status.", {
        deliveryId,
        status,
        alertable: true,
        monitoringKey: "webhook_event_persistence_failure",
        error:
          error instanceof Error
            ? error.message
            : "Unknown webhook event persistence failure.",
      });
    }
  }

  async handle(input: GitHubWebhookRequest): Promise<GitHubWebhookResult> {
    const parsed = webhookRequestSchema.parse(input);
    const requestLogger = this.#logger.child({
      correlationId: parsed.deliveryId,
      deliveryId: parsed.deliveryId,
      eventName: parsed.eventName,
    });
    // Signature validation is async through the GitHub adapter and must stay awaited.
    const signatureValid = await this.verifySignature(
      parsed.rawBody,
      parsed.signature,
    );
    if (!signatureValid) {
      requestLogger.warn("Rejected GitHub webhook with invalid signature.", {
        eventName: parsed.eventName,
      });
      return {
        statusCode: 401,
        accepted: false,
        message: "Invalid GitHub webhook signature.",
      };
    }

    // Register the delivery before any reactions, normalization, or queue
    // work so duplicates are rejected before the handler produces side effects.
    let delivery: Awaited<ReturnType<WebhookEventTracker["beginDelivery"]>>;
    try {
      delivery = await this.#webhookEventService.beginDelivery({
        deliveryId: parsed.deliveryId,
        provider: "github",
        eventName: parsed.eventName,
        payload: parsed.payload,
      });
    } catch (error) {
      requestLogger.error("GitHub webhook delivery registration failed.", {
        alertable: true,
        monitoringKey: "webhook_delivery_registration_failure",
        error: toErrorMessage(error, "Unknown delivery registration failure."),
      });
      captureError(error, {
        tags: { area: "webhook_delivery_registration" },
        extra: {
          deliveryId: parsed.deliveryId,
          eventName: parsed.eventName,
        },
      });
      return {
        statusCode: 500,
        accepted: false,
        message: "Failed to process GitHub webhook event.",
      };
    }

    if (delivery === "duplicate") {
      requestLogger.warn("Ignored duplicate GitHub webhook delivery.", {});
      return {
        statusCode: 202,
        accepted: false,
        message: "Duplicate GitHub webhook delivery ignored.",
      };
    }

    // Checked before reacting to mentions so non-allowlisted repositories see
    // no side effects at all. Events without a repository fall through to
    // normalization, which ignores them.
    const repository = repositoryFullName(parsed.payload);
    if (
      this.#repositoryAllowlist &&
      repository !== null &&
      !this.#repositoryAllowlist.has(repository.toLowerCase())
    ) {
      const reason = `Repository ${repository} is not in NITPICKR_REPOSITORY_ALLOWLIST.`;
      await this.#updateWebhookEventStatus(parsed.deliveryId, "ignored");
      requestLogger.info("Ignored GitHub webhook event.", { reason });
      return { statusCode: 202, accepted: false, message: reason };
    }

    try {
      const reaction = await Promise.resolve().then(() =>
        this.#adapter.reactToMention(parsed.eventName, parsed.payload),
      );
      if (reaction) {
        requestLogger.info("Reacted to GitHub bot mention.", {
          commentId: reaction.commentId,
          content: reaction.content,
        });
      }
    } catch (error) {
      requestLogger.warn("Failed to react to GitHub bot mention.", {
        error:
          error instanceof Error ? error.message : "Unknown reaction failure.",
      });
    }

    let normalized: ReturnType<GitHubAdapter["normalizeWebhookEvent"]>;
    try {
      normalized = this.#adapter.normalizeWebhookEvent(
        parsed.eventName,
        parsed.payload,
      );
    } catch (error) {
      await this.#updateWebhookEventStatus(parsed.deliveryId, "failed", {
        errorMessage: toErrorMessage(
          error,
          "Unknown webhook normalization failure.",
        ),
      });
      requestLogger.error("GitHub webhook event normalization failed.", {
        error: toErrorMessage(error, "Unknown webhook normalization failure."),
      });
      return {
        statusCode: 500,
        accepted: false,
        message: "Failed to process GitHub webhook event.",
      };
    }

    if (normalized.kind === "ignored") {
      await this.#updateWebhookEventStatus(parsed.deliveryId, "ignored");
      requestLogger.info("Ignored GitHub webhook event.", {
        reason: normalized.reason,
      });
      return {
        statusCode: 202,
        accepted: false,
        message: normalized.reason,
      };
    }

    try {
      const job = await this.#queueScheduler.enqueue(
        normalized.kind === "review_requested"
          ? buildReviewJobInput(normalized, parsed.deliveryId)
          : buildInteractionJobInput(normalized, parsed.deliveryId),
      );
      if (normalized.kind === "review_requested") {
        await this.#showQueued(
          job,
          normalized,
          parsed.deliveryId,
          requestLogger,
        );
      }
      await this.#updateWebhookEventStatus(parsed.deliveryId, "queued", {
        ...buildReviewStatusFields(normalized),
      });
      requestLogger.info(
        normalized.kind === "review_requested"
          ? "Queued GitHub review job."
          : "Queued GitHub interaction job.",
        {
          installationId: normalized.installationId,
          repositoryId: normalized.repository.repositoryId,
          pullNumber: normalized.pullNumber,
          ...(normalized.kind === "review_requested"
            ? { mode: normalized.mode }
            : { command: normalized.command }),
        },
      );
      return {
        statusCode: 202,
        accepted: true,
        message:
          normalized.kind === "review_requested"
            ? "Review job queued."
            : "Interaction job queued.",
      };
    } catch (error) {
      await this.#updateWebhookEventStatus(parsed.deliveryId, "failed", {
        ...buildReviewStatusFields(normalized),
        errorMessage: toErrorMessage(
          error,
          "Unknown webhook queueing failure.",
        ),
      });
      requestLogger.error("GitHub webhook queueing failed.", {
        repositoryId: normalized.repository.repositoryId,
        pullNumber: normalized.pullNumber,
        error: toErrorMessage(error, "Unknown webhook queueing failure."),
      });
      captureError(error, {
        tags: { area: "webhook_queueing" },
        extra: {
          deliveryId: parsed.deliveryId,
          eventName: parsed.eventName,
          repositoryId: normalized.repository.repositoryId,
          pullNumber: normalized.pullNumber,
        },
      });
      return {
        statusCode: 500,
        accepted: false,
        message: "Failed to process GitHub webhook event.",
      };
    }
  }
}
