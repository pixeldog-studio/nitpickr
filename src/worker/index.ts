import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { env } from "node:process";

import * as Sentry from "@sentry/node";

import { buildRuntime } from "../runtime/build-runtime.js";
import { WorkerRunner } from "./worker-runner.js";

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function main(): Promise<void> {
  const runtime = buildRuntime(env);
  const logger = runtime.logger.child({
    component: "worker",
  });
  // Unique per process start. In a container the pid is always 1, so a
  // pid-based id survives restarts: the new worker's heartbeat then vouches
  // for the old one and its orphaned running job is never recovered.
  const workerId = `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  let previousSetupStatusSignature: string | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down worker.", { signal, workerId });
    await Sentry.close(2000);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));

  logger.info("Starting worker loop.", {
    pollIntervalMs: runtime.config.worker.pollIntervalMs,
    perTenantCap: runtime.config.worker.concurrency,
  });
  while (!shuttingDown) {
    const freshWorkerIds =
      await runtime.workerHeartbeatService.listFreshWorkerIds(
        runtime.config.ready.workerStaleAfterMs,
      );
    const recoveredJobs = await runtime.queueScheduler.recoverStaleRunningJobs({
      activeWorkerIds: freshWorkerIds,
      staleStartedBefore: new Date(
        Date.now() - runtime.config.jobs.staleAfterMs,
      ),
    });
    if (recoveredJobs > 0) {
      logger.warn("Recovered stale worker jobs.", {
        workerId,
        recoveredJobs,
      });
    }

    const operationalRuntime = await runtime.getOperationalRuntime();
    if (!operationalRuntime) {
      const setupStatus = await runtime.runtimeConfigService.getSetupStatus();
      const setupStatusSignature = JSON.stringify(setupStatus);
      await runtime.workerHeartbeatService.recordHeartbeat({
        workerId,
        status: "setup_required",
      });
      if (previousSetupStatusSignature !== setupStatusSignature) {
        previousSetupStatusSignature = setupStatusSignature;
        logger.warn("Worker is idle until nitpickr setup completes.", {
          workerId,
          setupState: setupStatus.state,
          modelConfigured: setupStatus.modelConfigured,
          githubAppConfigured: setupStatus.githubAppConfigured,
        });
      } else {
        logger.debug("Worker remains idle while setup is incomplete.", {
          workerId,
          setupState: setupStatus.state,
        });
      }
      await sleep(runtime.config.worker.pollIntervalMs);
      continue;
    }

    if (previousSetupStatusSignature !== null) {
      previousSetupStatusSignature = null;
      logger.info("Worker resumed after setup completion.", {
        workerId,
      });
    }

    await runtime.workerHeartbeatService.recordHeartbeat({
      workerId,
      status: "ready",
    });
    const runner = new WorkerRunner({
      logger,
      repositoryAllowlist: runtime.config.repositoryAllowlist,
      promptOptimizationMode:
        operationalRuntime.config.review.promptOptimizationMode,
      queueScheduler: runtime.queueScheduler,
      githubAdapter: operationalRuntime.githubAdapter,
      instructionBundleLoader: operationalRuntime.instructionBundleLoader,
      memoryService: runtime.memoryService,
      discussionAcknowledgmentStore: runtime.discussionAcknowledgmentStore,
      feedbackService: runtime.feedbackService,
      reviewPlanner: runtime.reviewPlanner,
      reviewLifecycle: runtime.reviewLifecycle,
      reviewEngine: operationalRuntime.reviewEngine,
      conversationResponder: operationalRuntime.conversationResponder,
      botLogin: operationalRuntime.config.github.botLogins[0],
      publisher: operationalRuntime.publisher,
      statusPublisher: operationalRuntime.reviewStatusPublisher,
    });
    const processed = await runner.runOnce({
      workerId,
      perTenantCap: runtime.config.worker.concurrency,
    });

    if (!processed) {
      await sleep(runtime.config.worker.pollIntervalMs);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
