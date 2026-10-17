import { type Logger, noopLogger } from "../logging/logger.js";
import type { buildRuntime } from "../runtime/build-runtime.js";
import {
  type GitHubWebhookHandler,
  GitHubWebhookService,
} from "./github-webhook-service.js";

type AppRuntime = ReturnType<typeof buildRuntime>;
type OperationalRuntime = Awaited<
  ReturnType<AppRuntime["getOperationalRuntime"]>
>;

export function createSetupAwareGitHubWebhookHandler(input: {
  logger?: Logger;
  runtime: Pick<
    AppRuntime,
    | "config"
    | "getOperationalRuntime"
    | "queueScheduler"
    | "webhookEventService"
  >;
  createWebhookService?: (
    operationalRuntime: NonNullable<OperationalRuntime>,
  ) => GitHubWebhookHandler;
}): GitHubWebhookHandler {
  const logger = (input.logger ?? noopLogger).child({
    component: "setup-aware-webhook-handler",
  });
  let cachedService: GitHubWebhookHandler | null = null;

  const createWebhookService =
    input.createWebhookService ??
    ((operationalRuntime) =>
      new GitHubWebhookService(
        operationalRuntime.githubAdapter,
        input.runtime.queueScheduler,
        input.runtime.webhookEventService,
        logger,
        {
          repositoryAllowlist: input.runtime.config.repositoryAllowlist,
          statusPublisher: operationalRuntime.reviewStatusPublisher,
        },
      ));

  return {
    async verifySignature(rawBody, signature) {
      if (cachedService) {
        return await cachedService.verifySignature(rawBody, signature);
      }

      const operationalRuntime = await input.runtime.getOperationalRuntime();
      if (!operationalRuntime) {
        return "setup_required";
      }

      cachedService = createWebhookService(operationalRuntime);
      return await cachedService.verifySignature(rawBody, signature);
    },
    async handle(request) {
      if (cachedService) {
        return cachedService.handle(request);
      }

      const operationalRuntime = await input.runtime.getOperationalRuntime();
      if (!operationalRuntime) {
        return {
          statusCode: 503,
          accepted: false,
          message: "Nitpickr setup is incomplete.",
        };
      }

      cachedService = createWebhookService(operationalRuntime);
      return cachedService.handle(request);
    },
  };
}
