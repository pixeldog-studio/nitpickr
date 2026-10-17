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

  // Beat on a timer, not once per loop: a review holds the loop for many
  // minutes, and a worker that looks dead mid-review would have its job
  // treated as orphaned. A fresh heartbeat now always means "alive".
  // Repeats whatever status the loop last reported (ready / setup_required).
  let heartbeatStatus: "ready" | "setup_required" = "ready";
  const beat = () =>
    runtime.workerHeartbeatService
      .recordHeartbeat({ workerId, status: heartbeatStatus })
      .catch((error: unknown) => {
        logger.warn("Worker heartbeat failed.", {
          workerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  const heartbeatTimer = setInterval(
    () => void beat(),
    runtime.config.worker.heartbeatIntervalMs,
  );
  heartbeatTimer.unref();

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    logger.info("Shutting down worker.", { signal, workerId });
    // Flush first, then hand the job back and exit at once: the review is
    // still running in this process, so the gap between requeue and exit
    // (where it could still publish or complete the job) must stay tiny.
    await Sentry.close(2000);
    try {
      const requeued = await runtime.queueScheduler.requeueWorkerJobs(workerId);
      if (requeued > 0) {
        logger.info("Requeued in-flight jobs on shutdown.", {
          workerId,
          requeued,
        });
      }
    } catch (error) {
      logger.warn("Failed to requeue in-flight jobs on shutdown.", {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      heartbeatStatus = "setup_required";
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

    heartbeatStatus = "ready";
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
