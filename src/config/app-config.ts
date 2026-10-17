import { z } from "zod";

const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
const nodeEnvironmentSchema = z.enum(["development", "test", "production"]);
const promptOptimizationModeSchema = z.enum(["off", "balanced"]);
export type PromptOptimizationMode = z.infer<
  typeof promptOptimizationModeSchema
>;
const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/** Sentinel for NITPICKR_EMBEDDING_MODEL that disables memory embeddings. */
export const EMBEDDING_MODEL_DISABLED = "off";
/** Ollama's OpenAI-compatible endpoint on the same machine. */
export const DEFAULT_MODEL_BASE_URL = "http://localhost:11434/v1";
/** Runs in-process via transformers.js; see LocalMemoryEmbedder. */
export const DEFAULT_EMBEDDING_MODEL = "nomic-ai/nomic-embed-text-v1.5";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;
export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 300_000;
export const DEFAULT_MODEL_MAX_CONCURRENT_REQUESTS = 4;
export const DEFAULT_REVIEW_CHUNK_MAX_TOTAL_CHARS = 200_000;
/** Findings adversarially verified per review (one model call each). */
export const DEFAULT_VERIFIER_MAX_FINDINGS = 6;

const bootstrapEnvironmentSchema = z.object({
  NODE_ENV: nodeEnvironmentSchema.optional(),
  PORT: z.string().optional(),
  DATABASE_URL: z.string().url(),
  NITPICKR_MODEL_BASE_URL: z.string().url().optional(),
  NITPICKR_MODEL_API_KEY: z.string().min(1).optional(),
  NITPICKR_REVIEW_MODEL: z.string().min(1).optional(),
  NITPICKR_MEMORY_MODEL: z.string().min(1).optional(),
  NITPICKR_MODEL_REASONING_EFFORT: reasoningEffortSchema.optional(),
  NITPICKR_MODEL_REQUEST_TIMEOUT_MS: z.string().optional(),
  NITPICKR_EMBEDDING_MODEL: z.string().min(1).optional(),
  NITPICKR_EMBEDDING_CACHE_DIR: z.string().min(1).optional(),
  NITPICKR_EMBEDDING_DIMENSIONS: z.string().optional(),
  NITPICKR_MODEL_MAX_CONCURRENT_REQUESTS: z.string().optional(),
  NITPICKR_REVIEW_CHUNK_MAX_TOTAL_CHARS: z.string().optional(),
  NITPICKR_VERIFIER_MAX_FINDINGS: z.string().optional(),
  NITPICKR_INLINE_POLICY: z.enum(["all", "confirmed"]).optional(),
  GITHUB_API_BASE_URL: z.string().url().optional(),
  GITHUB_BOT_LOGINS: z.string().min(1).optional(),
  NITPICKR_BASE_URL: z.string().url().optional(),
  NITPICKR_WEBHOOK_URL: z.string().url().optional(),
  NITPICKR_SECRET_KEY: z.string().min(1).optional(),
  NITPICKR_LOG_LEVEL: logLevelSchema.optional(),
  NITPICKR_WORKER_CONCURRENCY: z.string().optional(),
  NITPICKR_WORKER_POLL_INTERVAL_MS: z.string().optional(),
  NITPICKR_JOB_STALE_AFTER_MS: z.string().optional(),
  NITPICKR_WORKER_HEARTBEAT_INTERVAL_MS: z.string().optional(),
  NITPICKR_READY_WORKER_STALE_AFTER_MS: z.string().optional(),
  NITPICKR_REPOSITORY_ALLOWLIST: z.string().min(1).optional(),
  NITPICKR_PROMPT_OPTIMIZATION_MODE: promptOptimizationModeSchema.optional(),
  DISCORD_WEBHOOK_URL: z.string().url().optional(),
});

const runtimeSecretEnvironmentSchema = z.object({
  GITHUB_APP_ID: z.string().regex(/^\d+$/),
  GITHUB_BOT_LOGINS: z.string().min(1).optional(),
  GITHUB_PRIVATE_KEY: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
});

type BootstrapEnvironment = z.infer<typeof bootstrapEnvironmentSchema>;
export type BotLogins = [string, ...string[]];
const defaultBotLogins: BotLogins = ["nitpickr", "getnitpickr"];

export interface RuntimeSecrets {
  githubAppId: number;
  githubPrivateKey: string;
  githubWebhookSecret: string;
  githubBotLogins?: BotLogins;
}

/**
 * Settings for the local model server (Ollama, llama-server, LM Studio, …),
 * reached over the `/v1/chat/completions` protocol they all speak.
 */
export interface ModelSettings {
  baseUrl: string;
  /** Bearer token for servers that require one; `null` sends no auth header. */
  apiKey: string | null;
  /** Chat model used for reviews; `null` until configured (setup required). */
  reviewModel: string | null;
  /** Sent as `reasoning_effort` when set; omitted from requests otherwise. */
  reasoningEffort: ReasoningEffort | null;
  /** Chat model used by the memory classifier; defaults to the review model. */
  memoryModel: string | null;
  /** In-process embedding model for memory recall; `null` disables embeddings. */
  embeddingModel: string | null;
  /** Cache directory for embedding model files; `null` uses the library default. */
  embeddingCacheDir: string | null;
  /** Vector width stored in the `memories.embedding` column. */
  embeddingDimensions: number;
  /** Per-request timeout for every model call. */
  requestTimeoutMs: number;
  /** Max in-flight model requests within one review (chunk fan-out). */
  maxConcurrentRequests: number;
  /** Total prompt characters (patch + file content) packed per review chunk. */
  reviewChunkMaxTotalChars: number;
  /** null = verifier off (`NITPICKR_VERIFIER_MAX_FINDINGS=off`). */
  verifierMaxFindings: number | null;
  /** Which findings become inline comments (see ReviewEngineOptions). */
  inlinePolicy: "all" | "confirmed";
}

export interface BootstrapConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  baseUrl: string;
  secretKey: string | null;
  models: ModelSettings;
  github: {
    apiBaseUrl: string;
    botLogins: BotLogins;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  worker: {
    concurrency: number;
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
  };
  jobs: {
    staleAfterMs: number;
  };
  ready: {
    workerStaleAfterMs: number;
  };
  review: {
    promptOptimizationMode: PromptOptimizationMode;
  };
  repositoryAllowlist: string[] | null;
  discordWebhookUrl: string | null;
}

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  baseUrl: string;
  databaseUrl: string;
  runtimeSecretSource: "environment" | "persisted_store";
  models: ModelSettings;
  github: {
    appId: number;
    apiBaseUrl: string;
    botLogins: BotLogins;
    privateKey: string;
    webhookSecret: string;
    webhookUrl: string;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  worker: {
    concurrency: number;
    pollIntervalMs: number;
    heartbeatIntervalMs: number;
  };
  jobs: {
    staleAfterMs: number;
  };
  ready: {
    workerStaleAfterMs: number;
  };
  review: {
    promptOptimizationMode: PromptOptimizationMode;
  };
  repositoryAllowlist: string[] | null;
  discordWebhookUrl: string | null;
}

function parseInteger(
  value: string | undefined,
  fieldName: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return parsed;
}

function toBotLogins(entries: string[]): BotLogins {
  const uniqueEntries = [...new Set(entries)];
  const [firstLogin, ...remainingLogins] = uniqueEntries;

  if (!firstLogin) {
    throw new Error("GITHUB_BOT_LOGINS must contain at least one login.");
  }

  return [firstLogin, ...remainingLogins];
}

function parseBotLogins(value: string | undefined): BotLogins {
  if (value === undefined) {
    return defaultBotLogins;
  }

  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  if (parsed.length === 0) {
    throw new Error("GITHUB_BOT_LOGINS must contain at least one login.");
  }

  return toBotLogins(parsed);
}

function parseRepositoryAllowlist(value: string | undefined): string[] | null {
  if (value === undefined) {
    return null;
  }

  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.length > 0 ? [...new Set(entries)] : null;
}

/**
 * Renamed when nitpickr went local-models-only. An unmigrated .env (old names
 * set, no NITPICKR_REVIEW_MODEL) fails loudly; once the new names are set, an
 * unrelated OPENAI_API_KEY exported for other tools is simply ignored.
 */
const RENAMED_MODEL_VARIABLES: Record<string, string> = {
  OPENAI_BASE_URL: "NITPICKR_MODEL_BASE_URL",
  OPENAI_API_KEY: "NITPICKR_MODEL_API_KEY (optional; local servers need none)",
  OPENAI_MODEL: "NITPICKR_REVIEW_MODEL",
  OPENAI_MEMORY_MODEL: "NITPICKR_MEMORY_MODEL",
  OPENAI_REASONING_EFFORT: "NITPICKR_MODEL_REASONING_EFFORT",
  OPENAI_REQUEST_TIMEOUT_MS: "NITPICKR_MODEL_REQUEST_TIMEOUT_MS",
  OPENAI_EMBEDDING_MODEL:
    "NITPICKR_EMBEDDING_MODEL (now a Hugging Face model id run in-process)",
};

function rejectRenamedModelVariables(
  input: Record<string, string | undefined>,
): void {
  if (input.NITPICKR_REVIEW_MODEL !== undefined) {
    return;
  }
  const stale = Object.keys(RENAMED_MODEL_VARIABLES).filter(
    (name) => input[name] !== undefined,
  );
  if (stale.length > 0) {
    throw new Error(
      `Unsupported environment variables: ${stale
        .map((name) => `${name} → use ${RENAMED_MODEL_VARIABLES[name]}`)
        .join("; ")}.`,
    );
  }
}

function parseModelSettings(parsed: BootstrapEnvironment): ModelSettings {
  const embeddingModel =
    parsed.NITPICKR_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  const reviewModel = parsed.NITPICKR_REVIEW_MODEL ?? null;
  return {
    baseUrl: parsed.NITPICKR_MODEL_BASE_URL ?? DEFAULT_MODEL_BASE_URL,
    apiKey: parsed.NITPICKR_MODEL_API_KEY ?? null,
    reviewModel,
    reasoningEffort: parsed.NITPICKR_MODEL_REASONING_EFFORT ?? null,
    memoryModel: parsed.NITPICKR_MEMORY_MODEL ?? reviewModel,
    embeddingModel:
      embeddingModel.toLowerCase() === EMBEDDING_MODEL_DISABLED
        ? null
        : embeddingModel,
    embeddingCacheDir: parsed.NITPICKR_EMBEDDING_CACHE_DIR ?? null,
    embeddingDimensions: parseInteger(
      parsed.NITPICKR_EMBEDDING_DIMENSIONS,
      "NITPICKR_EMBEDDING_DIMENSIONS",
      DEFAULT_EMBEDDING_DIMENSIONS,
    ),
    requestTimeoutMs: parseInteger(
      parsed.NITPICKR_MODEL_REQUEST_TIMEOUT_MS,
      "NITPICKR_MODEL_REQUEST_TIMEOUT_MS",
      DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    ),
    maxConcurrentRequests: parseInteger(
      parsed.NITPICKR_MODEL_MAX_CONCURRENT_REQUESTS,
      "NITPICKR_MODEL_MAX_CONCURRENT_REQUESTS",
      DEFAULT_MODEL_MAX_CONCURRENT_REQUESTS,
    ),
    reviewChunkMaxTotalChars: parseInteger(
      parsed.NITPICKR_REVIEW_CHUNK_MAX_TOTAL_CHARS,
      "NITPICKR_REVIEW_CHUNK_MAX_TOTAL_CHARS",
      DEFAULT_REVIEW_CHUNK_MAX_TOTAL_CHARS,
    ),
    inlinePolicy: parsed.NITPICKR_INLINE_POLICY ?? "all",
    verifierMaxFindings:
      parsed.NITPICKR_VERIFIER_MAX_FINDINGS?.trim().toLowerCase() === "off"
        ? null
        : parseInteger(
            parsed.NITPICKR_VERIFIER_MAX_FINDINGS,
            "NITPICKR_VERIFIER_MAX_FINDINGS",
            DEFAULT_VERIFIER_MAX_FINDINGS,
          ),
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function deriveBaseUrl(parsed: BootstrapEnvironment, port: number): string {
  if (parsed.NITPICKR_BASE_URL) {
    return normalizeBaseUrl(parsed.NITPICKR_BASE_URL);
  }

  if (parsed.NITPICKR_WEBHOOK_URL) {
    if (!parsed.NITPICKR_WEBHOOK_URL.endsWith("/webhooks/github")) {
      throw new Error(
        "NITPICKR_WEBHOOK_URL must end with /webhooks/github for the GitHub App webhook.",
      );
    }

    return normalizeBaseUrl(
      parsed.NITPICKR_WEBHOOK_URL.slice(0, -"/webhooks/github".length),
    );
  }

  if ((parsed.NODE_ENV ?? "development") !== "production") {
    return `http://localhost:${port}`;
  }

  throw new Error(
    "NITPICKR_BASE_URL is required in production when NITPICKR_WEBHOOK_URL is not provided.",
  );
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function normalizeRuntimeSecrets(
  parsed: z.infer<typeof runtimeSecretEnvironmentSchema>,
): RuntimeSecrets {
  const runtimeSecrets: RuntimeSecrets = {
    githubAppId: Number.parseInt(parsed.GITHUB_APP_ID, 10),
    githubPrivateKey: normalizePrivateKey(parsed.GITHUB_PRIVATE_KEY),
    githubWebhookSecret: parsed.GITHUB_WEBHOOK_SECRET,
  };

  if (parsed.GITHUB_BOT_LOGINS) {
    runtimeSecrets.githubBotLogins = parseBotLogins(parsed.GITHUB_BOT_LOGINS);
  }

  return runtimeSecrets;
}

export function parseBootstrapConfig(
  input: Record<string, string | undefined>,
): BootstrapConfig {
  rejectRenamedModelVariables(input);
  const parsed = bootstrapEnvironmentSchema.parse(input);
  const port = parseInteger(parsed.PORT, "PORT", 3000);

  return {
    nodeEnv: parsed.NODE_ENV ?? "development",
    port,
    databaseUrl: parsed.DATABASE_URL,
    baseUrl: deriveBaseUrl(parsed, port),
    secretKey: parsed.NITPICKR_SECRET_KEY ?? null,
    models: parseModelSettings(parsed),
    github: {
      apiBaseUrl: parsed.GITHUB_API_BASE_URL ?? "https://api.github.com",
      botLogins: parseBotLogins(parsed.GITHUB_BOT_LOGINS),
    },
    logging: {
      level: parsed.NITPICKR_LOG_LEVEL ?? "info",
    },
    worker: {
      concurrency: parseInteger(
        parsed.NITPICKR_WORKER_CONCURRENCY,
        "NITPICKR_WORKER_CONCURRENCY",
        4,
      ),
      pollIntervalMs: parseInteger(
        parsed.NITPICKR_WORKER_POLL_INTERVAL_MS,
        "NITPICKR_WORKER_POLL_INTERVAL_MS",
        5000,
      ),
      heartbeatIntervalMs: parseInteger(
        parsed.NITPICKR_WORKER_HEARTBEAT_INTERVAL_MS,
        "NITPICKR_WORKER_HEARTBEAT_INTERVAL_MS",
        5000,
      ),
    },
    jobs: {
      staleAfterMs: parseInteger(
        parsed.NITPICKR_JOB_STALE_AFTER_MS,
        "NITPICKR_JOB_STALE_AFTER_MS",
        120_000,
      ),
    },
    ready: {
      workerStaleAfterMs: parseInteger(
        parsed.NITPICKR_READY_WORKER_STALE_AFTER_MS,
        "NITPICKR_READY_WORKER_STALE_AFTER_MS",
        20_000,
      ),
    },
    review: {
      // Balanced is the safe default: reduce token usage while preserving core context.
      promptOptimizationMode:
        parsed.NITPICKR_PROMPT_OPTIMIZATION_MODE ?? "balanced",
    },
    repositoryAllowlist: parseRepositoryAllowlist(
      parsed.NITPICKR_REPOSITORY_ALLOWLIST,
    ),
    discordWebhookUrl: parsed.DISCORD_WEBHOOK_URL ?? null,
  };
}

export function parseRuntimeSecretsFromEnvironment(
  input: Record<string, string | undefined>,
): RuntimeSecrets | null {
  const result = runtimeSecretEnvironmentSchema.safeParse(input);
  if (!result.success) {
    return null;
  }

  return normalizeRuntimeSecrets(result.data);
}

export function buildAppConfig(
  bootstrap: BootstrapConfig,
  secrets: RuntimeSecrets,
  runtimeSecretSource: AppConfig["runtimeSecretSource"] = "persisted_store",
): AppConfig {
  return {
    nodeEnv: bootstrap.nodeEnv,
    port: bootstrap.port,
    baseUrl: bootstrap.baseUrl,
    databaseUrl: bootstrap.databaseUrl,
    runtimeSecretSource,
    models: bootstrap.models,
    github: {
      appId: secrets.githubAppId,
      apiBaseUrl: bootstrap.github.apiBaseUrl,
      botLogins: secrets.githubBotLogins ?? bootstrap.github.botLogins,
      privateKey: secrets.githubPrivateKey,
      webhookSecret: secrets.githubWebhookSecret,
      webhookUrl: `${bootstrap.baseUrl}/webhooks/github`,
    },
    logging: bootstrap.logging,
    worker: bootstrap.worker,
    jobs: bootstrap.jobs,
    ready: bootstrap.ready,
    review: bootstrap.review,
    repositoryAllowlist: bootstrap.repositoryAllowlist,
    discordWebhookUrl: bootstrap.discordWebhookUrl,
  };
}

export function parseAppConfig(
  input: Record<string, string | undefined>,
): AppConfig {
  const runtimeSecrets = runtimeSecretEnvironmentSchema.safeParse(input);
  if (!runtimeSecrets.success) {
    throw runtimeSecrets.error;
  }

  return buildAppConfig(
    parseBootstrapConfig(input),
    normalizeRuntimeSecrets(runtimeSecrets.data),
    "environment",
  );
}
