import { cwd, env, exit } from "node:process";

import {
  parseBootstrapConfig as parseCliBootstrapConfig,
  type ReasoningEffort,
} from "../config/app-config.js";
import { createPostgresClient } from "../runtime/postgres.js";
import { flagBoolean, flagInteger, flagString, parseArgs } from "./args.js";
import { DoctorCommand } from "./doctor-command.js";
import { EvalCaptureCommand } from "./eval-capture-command.js";
import { EvalLiveReviewsCommand } from "./eval-live-reviews-command.js";
import { EvalReviewsCommand } from "./eval-reviews-command.js";
import { runMigrationsWithAdvisoryLock } from "./migrate-command.js";
import { SetupCommand } from "./setup-command.js";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === "setup") {
    const setup = new SetupCommand();
    await setup.run({
      cwd: cwd(),
      values: {
        reviewModel: env.NITPICKR_REVIEW_MODEL ?? "",
        databaseUrl: env.DATABASE_URL ?? "",
        githubAppId: env.GITHUB_APP_ID ?? "",
        githubPrivateKey: env.GITHUB_PRIVATE_KEY ?? "",
        githubWebhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
        webhookUrl: env.NITPICKR_WEBHOOK_URL ?? "",
      },
    });
    return;
  }

  if (command === "doctor") {
    const doctor = new DoctorCommand();
    const result = doctor.run(env);
    if (!result.ok) {
      throw new Error(result.errors.join("\n"));
    }
    return;
  }

  if (command === "eval:reviews") {
    const args = parseArgs(process.argv.slice(3));
    if (flagBoolean(args, "live")) {
      // Live mode: run fixtures against the local model server.
      // Defaults come from NITPICKR_MODEL_* / NITPICKR_REVIEW_MODEL in `.env`.
      const bootstrap = parseCliBootstrapConfig({
        ...env,
        DATABASE_URL: env.DATABASE_URL ?? "postgres://unused@localhost/unused",
      });
      const reasoningFlag = flagString(args, "reasoning-effort");
      if (
        reasoningFlag !== undefined &&
        !["unset", "none", "minimal", "low", "medium", "high"].includes(
          reasoningFlag,
        )
      ) {
        throw new Error(
          "--reasoning-effort must be one of unset|none|minimal|low|medium|high.",
        );
      }
      const model = flagString(args, "model") ?? bootstrap.models.reviewModel;
      if (!model) {
        throw new Error("Set NITPICKR_REVIEW_MODEL or pass --model.");
      }
      const evaluation = new EvalLiveReviewsCommand();
      const timeoutMs =
        flagInteger(args, "timeout-ms") ?? bootstrap.models.requestTimeoutMs;
      await evaluation.run({
        cwd: cwd(),
        apiKey: flagString(args, "api-key") ?? bootstrap.models.apiKey,
        baseUrl: flagString(args, "base-url") ?? bootstrap.models.baseUrl,
        model,
        reasoningEffort:
          reasoningFlag === undefined
            ? bootstrap.models.reasoningEffort
            : reasoningFlag === "unset"
              ? null
              : (reasoningFlag as ReasoningEffort),
        timeoutMs,
        engineOptions: {
          maxConcurrentModelRequests: bootstrap.models.maxConcurrentRequests,
          maxTotalCharactersPerChunk: bootstrap.models.reviewChunkMaxTotalChars,
          verifier:
            bootstrap.models.verifierMaxFindings === null
              ? null
              : { maxFindings: bootstrap.models.verifierMaxFindings },
        },
        startedAt: new Date().toISOString(),
        ...(flagString(args, "commit")
          ? { gitCommit: flagString(args, "commit") as string }
          : {}),
        ...(flagString(args, "fixtures")
          ? { fixtureDirectory: flagString(args, "fixtures") as string }
          : {}),
        ...(flagString(args, "out")
          ? { outFile: flagString(args, "out") as string }
          : {}),
        ...(flagString(args, "filter")
          ? { filter: flagString(args, "filter") as string }
          : {}),
      });
      return;
    }

    const evaluation = new EvalReviewsCommand();
    await evaluation.run({
      cwd: cwd(),
    });
    return;
  }

  if (command === "eval:capture") {
    const args = parseArgs(process.argv.slice(3));
    const reference = args.positionals[0];
    if (!reference) {
      throw new Error(
        "Usage: nitpickr eval:capture owner/repo#123 [--out tests/fixtures/review-evals/live] (needs GITHUB_TOKEN)",
      );
    }
    const token = flagString(args, "token") ?? env.GITHUB_TOKEN;
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN is required (e.g. GITHUB_TOKEN=$(gh auth token)).",
      );
    }
    await new EvalCaptureCommand().run({
      reference,
      token,
      outDirectory:
        flagString(args, "out") ?? `${cwd()}/tests/fixtures/review-evals/live`,
      ...(env.GITHUB_API_BASE_URL
        ? { apiBaseUrl: env.GITHUB_API_BASE_URL }
        : {}),
    });
    return;
  }

  if (command === "migrate") {
    // CLI bootstrap commands intentionally use bootstrap-only config because
    // migrations run before runtime secrets are guaranteed to exist.
    const config = parseCliBootstrapConfig(env);
    const sql = createPostgresClient(config.databaseUrl);
    try {
      await runMigrationsWithAdvisoryLock(sql, {
        embeddingDimensions: config.models.embeddingDimensions,
      });
    } finally {
      await sql.end();
    }
    return;
  }

  throw new Error(`Unknown nitpickr CLI command: ${command ?? "(missing)"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  exit(1);
});
