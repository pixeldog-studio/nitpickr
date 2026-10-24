import { describe, expect, it } from "vitest";

import {
  buildAppConfig,
  parseAppConfig,
  parseBootstrapConfig,
  parseRuntimeSecretsFromEnvironment,
} from "../../src/config/app-config.js";

describe("parseAppConfig", () => {
  it("parses valid environment variables", () => {
    const config = parseAppConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
      NITPICKR_REVIEW_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
      GITHUB_APP_ID: "123456",
      GITHUB_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      NITPICKR_WEBHOOK_URL: "https://nitpickr.example.com/webhooks/github",
    });

    expect(config.port).toBe(3000);
    expect(config.worker.concurrency).toBe(4);
    expect(config.github.appId).toBe(123456);
    expect(config.models.reviewModel).toBe("qwen3.6:35b-a3b-coding-nvfp4");
    expect(config.models.memoryModel).toBe("qwen3.6:35b-a3b-coding-nvfp4");
    expect(config.models.apiKey).toBeNull();
    expect(config.models.embeddingModel).toBe("nomic-ai/nomic-embed-text-v1.5");
    expect(config.models.embeddingDimensions).toBe(768);
    expect(config.github.apiBaseUrl).toBe("https://api.github.com");
    expect(config.models.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.github.botLogins).toEqual(["nitpickr", "getnitpickr"]);
    expect(config.review.promptOptimizationMode).toBe("balanced");
  });

  it("parses custom provider base URLs", () => {
    const config = parseAppConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
      NITPICKR_MODEL_BASE_URL: "http://model-stub:4020/v1",
      NITPICKR_MODEL_API_KEY: "local-token",
      NITPICKR_REVIEW_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
      GITHUB_APP_ID: "123456",
      GITHUB_API_BASE_URL: "http://github-stub:4010",
      GITHUB_BOT_LOGINS: "getnitpickr,nitpickr",
      GITHUB_PRIVATE_KEY:
        "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      NITPICKR_WEBHOOK_URL: "https://nitpickr.example.com/webhooks/github",
    });

    expect(config.models.baseUrl).toBe("http://model-stub:4020/v1");
    expect(config.models.apiKey).toBe("local-token");
    expect(config.github.apiBaseUrl).toBe("http://github-stub:4010");
    expect(config.github.botLogins).toEqual(["getnitpickr", "nitpickr"]);
  });

  it("rejects missing required variables", () => {
    expect(() =>
      parseAppConfig({
        DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
      }),
    ).toThrow(/GITHUB_APP_ID/i);
  });

  it("rejects an unmigrated .env that still uses OPENAI_* names", () => {
    expect(() =>
      parseBootstrapConfig({
        DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
        OPENAI_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
        OPENAI_BASE_URL: "http://localhost:11434/v1",
      }),
    ).toThrow(/OPENAI_MODEL → use NITPICKR_REVIEW_MODEL/);
  });

  it("ignores an unrelated OPENAI_API_KEY once NITPICKR_REVIEW_MODEL is set", () => {
    const config = parseBootstrapConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
      OPENAI_API_KEY: "sk-for-another-tool",
      NITPICKR_REVIEW_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
    });

    expect(config.models.apiKey).toBeNull();
  });

  it("leaves the review model unset until configured", () => {
    const config = parseBootstrapConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
    });

    expect(config.models.reviewModel).toBeNull();
    expect(config.models.memoryModel).toBeNull();
  });

  it("rejects invalid numeric configuration", () => {
    expect(() =>
      parseAppConfig({
        DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
        NITPICKR_REVIEW_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
        GITHUB_APP_ID: "123456",
        GITHUB_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        GITHUB_WEBHOOK_SECRET: "webhook-secret",
        NITPICKR_WEBHOOK_URL: "https://nitpickr.example.com/webhooks/github",
        PORT: "bad",
      }),
    ).toThrow(/PORT/i);
  });
});

describe("parseBootstrapConfig", () => {
  it("defaults prompt optimization mode to balanced when unset", () => {
    const config = parseBootstrapConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
    });

    expect(config.review.promptOptimizationMode).toBe("balanced");
  });

  it("uses a non-empty default bot login list when unset", () => {
    const config = parseBootstrapConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
    });

    expect(config.github.botLogins).toEqual(["nitpickr", "getnitpickr"]);
  });

  it("parses Railway-style bootstrap settings", () => {
    const config = parseBootstrapConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
      NITPICKR_BASE_URL: "https://nitpickr.up.railway.app",
      NITPICKR_SECRET_KEY: "super-secret-key",
      DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/a/b",
      NITPICKR_REPOSITORY_ALLOWLIST:
        "example-owner/nitpickr,example-owner/demo",
      NITPICKR_PROMPT_OPTIMIZATION_MODE: "off",
    });

    expect(config.baseUrl).toBe("https://nitpickr.up.railway.app");
    expect(config.discordWebhookUrl).toBe(
      "https://discord.com/api/webhooks/a/b",
    );
    expect(config.repositoryAllowlist).toEqual([
      "example-owner/nitpickr",
      "example-owner/demo",
    ]);
    expect(config.review.promptOptimizationMode).toBe("off");
  });

  it("accepts balanced prompt optimization mode", () => {
    const config = parseBootstrapConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
      NITPICKR_PROMPT_OPTIMIZATION_MODE: "balanced",
    });

    expect(config.review.promptOptimizationMode).toBe("balanced");
  });

  it("derives a base URL from the legacy webhook URL", () => {
    const config = parseBootstrapConfig({
      DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
      NITPICKR_WEBHOOK_URL: "https://nitpickr.example.com/webhooks/github",
    });

    expect(config.baseUrl).toBe("https://nitpickr.example.com");
  });

  it("rejects invalid prompt optimization mode values", () => {
    expect(() =>
      parseBootstrapConfig({
        DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
        NITPICKR_PROMPT_OPTIMIZATION_MODE: "aggressive",
      }),
    ).toThrow(/NITPICKR_PROMPT_OPTIMIZATION_MODE/i);
  });
});

describe("parseRuntimeSecretsFromEnvironment", () => {
  it("returns null when runtime secrets are incomplete", () => {
    expect(
      parseRuntimeSecretsFromEnvironment({
        NITPICKR_REVIEW_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
        GITHUB_APP_ID: "123456",
      }),
    ).toBeNull();
  });

  it("parses and normalizes runtime bot logins", () => {
    expect(
      parseRuntimeSecretsFromEnvironment({
        NITPICKR_REVIEW_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
        GITHUB_APP_ID: "123456",
        GITHUB_BOT_LOGINS: "GetNitpickr, nitpickr",
        GITHUB_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        GITHUB_WEBHOOK_SECRET: "webhook-secret",
      }),
    ).toMatchObject({
      githubBotLogins: ["getnitpickr", "nitpickr"],
    });
  });

  it("rejects bot login values that normalize to an empty list", () => {
    expect(() =>
      parseRuntimeSecretsFromEnvironment({
        NITPICKR_REVIEW_MODEL: "qwen3.6:35b-a3b-coding-nvfp4",
        GITHUB_APP_ID: "123456",
        GITHUB_BOT_LOGINS: " , ",
        GITHUB_PRIVATE_KEY:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        GITHUB_WEBHOOK_SECRET: "webhook-secret",
      }),
    ).toThrow(/GITHUB_BOT_LOGINS/i);
  });
});

describe("buildAppConfig", () => {
  it("combines bootstrap config and stored runtime secrets", () => {
    const config = buildAppConfig(
      parseBootstrapConfig({
        DATABASE_URL: "postgres://nitpickr:nitpickr@localhost:5432/nitpickr",
        NITPICKR_BASE_URL: "https://nitpickr.up.railway.app",
        NITPICKR_SECRET_KEY: "super-secret-key",
        NITPICKR_WORKER_HEARTBEAT_INTERVAL_MS: "3000",
      }),
      {
        githubAppId: 123456,
        githubPrivateKey:
          "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
        githubWebhookSecret: "webhook-secret",
        githubBotLogins: ["getnitpickr"],
      },
    );

    expect(config.github.webhookUrl).toBe(
      "https://nitpickr.up.railway.app/webhooks/github",
    );
    expect(config.runtimeSecretSource).toBe("persisted_store");
    expect(config.worker.heartbeatIntervalMs).toBe(3000);
  });
});
