import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { BotLogins } from "../../config/app-config.js";
import { parseChangeRequest, type ReviewTrigger } from "../../domain/types.js";
import type { ReviewerChatCommand } from "../../review/reviewer-chat-service.js";

const repositorySchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  owner: z.object({
    login: z.string().min(1),
  }),
  default_branch: z.string().min(1),
});

const pullRequestSchema = z.object({
  id: z.number().int().positive(),
  number: z.number().int().positive(),
  title: z.string().min(1),
  state: z.enum(["open", "closed"]),
  draft: z.boolean(),
  user: z.object({
    login: z.string().min(1),
  }),
  base: z.object({
    sha: z.string().min(1),
    ref: z.string().min(1),
  }),
  head: z.object({
    sha: z.string().min(1),
    ref: z.string().min(1),
  }),
});

const pullRequestEventSchema = z.object({
  action: z.enum(["opened", "synchronize", "ready_for_review"]),
  installation: z.object({
    id: z.number().int().positive(),
  }),
  repository: repositorySchema,
  pull_request: pullRequestSchema,
});

const issueCommentEventSchema = z.object({
  action: z.enum(["created", "edited"]),
  installation: z.object({
    id: z.number().int().positive(),
  }),
  repository: repositorySchema,
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z
      .object({
        url: z.string().url(),
      })
      .optional(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string().min(1),
    user: z.object({
      login: z.string().min(1),
    }),
  }),
});

const pullRequestReviewCommentEventSchema = z.object({
  action: z.enum(["created", "edited"]),
  installation: z.object({
    id: z.number().int().positive(),
  }),
  repository: repositorySchema,
  pull_request: z.object({
    number: z.number().int().positive(),
  }),
  comment: z.object({
    id: z.number().int().positive(),
    body: z.string().min(1),
    in_reply_to_id: z.number().int().positive().nullable().optional(),
    path: z.string().min(1).nullable().optional(),
    line: z.number().int().positive().nullable().optional(),
    user: z.object({
      login: z.string().min(1),
    }),
  }),
});

export interface GitHubAppConfig {
  appId: number;
  botLogins?: BotLogins;
  privateKey: string;
  webhookSecret: string;
  webhookUrl: string;
}

export interface GitHubApiClient {
  getPullRequest(input: {
    installationId: string;
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<z.infer<typeof pullRequestSchema>>;
  listPullRequestFiles(input: {
    installationId: string;
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<
    Array<{
      filename: string;
      status: "added" | "modified" | "removed" | "renamed";
      additions: number;
      deletions: number;
      patch?: string;
      previous_filename?: string;
    }>
  >;
  listIssueComments(input: {
    installationId: string;
    owner: string;
    repo: string;
    issueNumber: number;
  }): Promise<
    Array<{
      id: number;
      body: string;
      user: {
        login: string;
      };
      created_at: string;
    }>
  >;
  listReviewComments(input: {
    installationId: string;
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<
    Array<{
      id: number;
      body: string;
      user: {
        login: string;
      };
      path?: string;
      line?: number;
      created_at: string;
    }>
  >;
  comparePullRequestRange(input: {
    installationId: string;
    owner: string;
    repo: string;
    baseSha: string;
    headSha: string;
  }): Promise<
    Array<{
      filename: string;
      status: "added" | "modified" | "removed" | "renamed";
      additions: number;
      deletions: number;
      patch?: string;
      previous_filename?: string;
    }>
  >;
  getFileContent(input: {
    installationId: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<string | null>;
  listNitpickrReviewThreads(input: {
    installationId: string;
    owner: string;
    repo: string;
    pullNumber: number;
    botLogins: string[];
  }): Promise<
    Array<{
      threadId: string;
      providerCommentId: string;
      path: string;
      line: number;
      fingerprint: string;
      isResolved: boolean;
      isOutdated?: boolean;
      body: string;
      reactionSummary: {
        positiveCount: number;
        negativeCount: number;
      };
    }>
  >;
  resolveReviewThread(input: {
    installationId: string;
    threadId: string;
  }): Promise<void>;
  createIssueCommentReaction(input: {
    installationId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: "eyes";
  }): Promise<void>;
  createIssueComment(input: {
    installationId: string;
    owner: string;
    repo: string;
    issueNumber: number;
    body: string;
  }): Promise<void>;
  replyToReviewComment(input: {
    installationId: string;
    owner: string;
    repo: string;
    pullNumber: number;
    commentId: number;
    body: string;
  }): Promise<void>;
}

type NormalizedReviewMode = "quick" | "full" | "summary";

interface ParsedInteractionCommand {
  command: ReviewerChatCommand;
  argumentText: string | null;
}

const manualCommandDefinitions: Array<{
  canonicalCommand:
    | "review"
    | "full_review"
    | "summary"
    | "recheck"
    | "ignore_this";
  triggerCommand:
    | "review"
    | "full_review"
    | "summary"
    | "recheck"
    | "ignore_this";
  mode: NormalizedReviewMode;
}> = [
  {
    canonicalCommand: "review",
    triggerCommand: "review",
    mode: "quick",
  },
  {
    canonicalCommand: "full_review",
    triggerCommand: "full_review",
    mode: "full",
  },
  {
    canonicalCommand: "summary",
    triggerCommand: "summary",
    mode: "summary",
  },
  {
    canonicalCommand: "recheck",
    triggerCommand: "recheck",
    mode: "quick",
  },
  {
    canonicalCommand: "ignore_this",
    triggerCommand: "ignore_this",
    mode: "quick",
  },
];

const interactionCommands = [
  "why",
  "teach",
  "reconsider",
  "fix",
  "learn",
  "status",
] as const;

const supportedCommandSuffixes = [
  "review",
  "full review",
  "summary",
  "recheck",
  "ignore this",
  ...interactionCommands,
] as const;

interface NormalizedRepositoryRef {
  installationId: string;
  repositoryId: string;
  providerRepositoryId: number;
  owner: string;
  name: string;
  defaultBranch: string;
}

export type GitHubNormalizedEvent =
  | {
      kind: "review_requested";
      installationId: string;
      repository: NormalizedRepositoryRef;
      pullNumber: number;
      trigger: ReviewTrigger;
      mode: NormalizedReviewMode;
      actorLogin: string;
      /** Head commit for pull_request events; comment commands have none. */
      headSha?: string;
    }
  | {
      kind: "interaction_requested";
      installationId: string;
      repository: NormalizedRepositoryRef;
      pullNumber: number;
      actorLogin: string;
      command: ReviewerChatCommand;
      replyTargetCommentId?: number;
      source:
        | {
            kind: "issue_comment";
            commentId: number;
            body: string;
            argumentText: string | null;
          }
        | {
            kind: "review_comment";
            commentId: number;
            body: string;
            argumentText: string | null;
            path: string | null;
            line: number | null;
          };
    }
  | {
      kind: "ignored";
      reason: string;
    };

export interface GitHubChangeRequestContext {
  tenantId: string;
  installationId: string;
  repositoryId: string;
  repository: {
    owner: string;
    name: string;
  };
  changeRequest: ReturnType<typeof parseChangeRequest>;
  files: Array<{
    path: string;
    status: "added" | "modified" | "removed" | "renamed";
    additions: number;
    deletions: number;
    patch: string | null;
    previousPath: string | null;
  }>;
  comments: Array<{
    id: string;
    authorLogin: string;
    body: string;
    path: string | null;
    line: number | null;
    createdAt: string;
  }>;
}

export interface GitHubAdapterOptions {
  apiClient: GitHubApiClient;
  appConfig: GitHubAppConfig;
}

function normalizeRepository(
  repository: z.infer<typeof repositorySchema>,
  installationId: number,
): NormalizedRepositoryRef {
  return {
    installationId: String(installationId),
    repositoryId: `github:${repository.id}`,
    providerRepositoryId: repository.id,
    owner: repository.owner.login,
    name: repository.name,
    defaultBranch: repository.default_branch,
  };
}

function extractMentionCommand(
  body: string,
  botLogins: string[],
): string | null {
  const normalized = body.trim().toLowerCase().replace(/\s+/g, " ");

  for (const botLogin of botLogins) {
    const escapedBotLogin = botLogin
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionPattern = new RegExp(
      `(?:^|\\s)@${escapedBotLogin}(?:\\s+|\\s*[:,-]\\s*)(.+)`,
    );
    const match = mentionPattern.exec(normalized);
    if (match?.[1]) {
      return match[1].trim().replace(/^\/+/, "");
    }
  }

  return null;
}

function canonicalizeCommand(commandText: string | null): string | null {
  if (!commandText) {
    return null;
  }

  return commandText.replace(/[-\s]+/g, "_").replace(/_+/g, "_");
}

function parseManualCommand(
  body: string,
  botLogins: string[],
  actorLogin: string,
): { trigger: ReviewTrigger; mode: NormalizedReviewMode } | null {
  const canonicalCommand = canonicalizeCommand(
    extractMentionCommand(body, botLogins),
  );
  const definition = manualCommandDefinitions.find(
    (candidate) => candidate.canonicalCommand === canonicalCommand,
  );
  if (!definition) {
    return null;
  }

  return {
    trigger: {
      type: "manual_command",
      command: definition.triggerCommand,
      actorLogin,
    },
    mode: definition.mode,
  };
}

function parseInteractionCommand(
  body: string,
  botLogins: string[],
  input: {
    requireMention: boolean;
  },
): ParsedInteractionCommand | null {
  const normalized = body.trim().toLowerCase().replace(/\s+/g, " ");
  const mentionCommand = extractMentionCommand(normalized, botLogins);
  const rawCommandText =
    mentionCommand ??
    (input.requireMention ? null : normalized.replace(/^\/+/, "").trim());
  const canonicalCommand = canonicalizeCommand(rawCommandText);

  if (!canonicalCommand) {
    return null;
  }

  const match = new RegExp(
    `^(${interactionCommands.join("|")})(?:_+(.+))?$`,
  ).exec(canonicalCommand);
  if (!match?.[1]) {
    return null;
  }

  const argumentText =
    rawCommandText
      ?.slice(match[1].length)
      .trim()
      .replace(/^[:,-]\s*/, "") ?? "";

  return {
    command: match[1] as ReviewerChatCommand,
    argumentText: argumentText.length > 0 ? argumentText : null,
  };
}

function containsBotMention(body: string, botLogins: string[]): boolean {
  const normalized = body.trim().toLowerCase().replace(/\s+/g, " ");

  return botLogins.some((botLogin) => {
    const escapedBotLogin = botLogin
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mentionPattern = new RegExp(
      `(?:^|\\s)@${escapedBotLogin}(?=$|\\s|[:,-])`,
    );

    return mentionPattern.test(normalized);
  });
}

export class GitHubAdapter {
  readonly #apiClient: GitHubApiClient;
  readonly #appConfig: GitHubAppConfig;
  readonly #botLogins: BotLogins;

  constructor(options: GitHubAdapterOptions) {
    this.#apiClient = options.apiClient;
    this.#appConfig = options.appConfig;
    this.#botLogins = options.appConfig.botLogins ?? [
      "nitpickr",
      "getnitpickr",
    ];
  }

  async verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
  ): Promise<boolean> {
    if (!signatureHeader.startsWith("sha256=")) {
      return false;
    }

    const expected = createHmac("sha256", this.#appConfig.webhookSecret)
      .update(rawBody)
      .digest("hex");

    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(signatureHeader.slice("sha256=".length));

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, actualBuffer);
  }

  normalizeWebhookEvent(
    eventName: string,
    payload: unknown,
  ): GitHubNormalizedEvent {
    if (eventName === "pull_request") {
      const parsedResult = pullRequestEventSchema.safeParse(payload);
      if (!parsedResult.success) {
        return {
          kind: "ignored",
          reason: "Unsupported pull_request payload.",
        };
      }
      const parsed = parsedResult.data;
      const repository = normalizeRepository(
        parsed.repository,
        parsed.installation.id,
      );

      const trigger: ReviewTrigger =
        parsed.action === "opened"
          ? {
              type: "pr_opened",
              actorLogin: parsed.pull_request.user.login,
            }
          : parsed.action === "synchronize"
            ? {
                type: "pr_synchronized",
                actorLogin: parsed.pull_request.user.login,
              }
            : {
                type: "pr_ready_for_review",
                actorLogin: parsed.pull_request.user.login,
              };

      return {
        kind: "review_requested",
        installationId: repository.installationId,
        repository,
        pullNumber: parsed.pull_request.number,
        trigger,
        mode: parsed.action === "synchronize" ? "quick" : "full",
        actorLogin: parsed.pull_request.user.login,
        headSha: parsed.pull_request.head.sha,
      };
    }

    if (eventName === "issue_comment") {
      const parsedResult = issueCommentEventSchema.safeParse(payload);
      if (!parsedResult.success) {
        return {
          kind: "ignored",
          reason: "Unsupported issue_comment payload.",
        };
      }
      const parsed = parsedResult.data;
      if (!parsed.issue.pull_request) {
        return {
          kind: "ignored",
          reason: "Issue comment is not attached to a pull request.",
        };
      }

      const command = parseManualCommand(
        parsed.comment.body,
        this.#botLogins,
        parsed.comment.user.login,
      );
      if (command) {
        return {
          kind: "review_requested",
          installationId: String(parsed.installation.id),
          repository: normalizeRepository(
            parsed.repository,
            parsed.installation.id,
          ),
          pullNumber: parsed.issue.number,
          trigger: command.trigger,
          mode: command.mode,
          actorLogin: parsed.comment.user.login,
        };
      }

      const interaction = parseInteractionCommand(
        parsed.comment.body,
        this.#botLogins,
        {
          requireMention: true,
        },
      );
      if (interaction) {
        return {
          kind: "interaction_requested",
          installationId: String(parsed.installation.id),
          repository: normalizeRepository(
            parsed.repository,
            parsed.installation.id,
          ),
          pullNumber: parsed.issue.number,
          actorLogin: parsed.comment.user.login,
          command: interaction.command,
          source: {
            kind: "issue_comment",
            commentId: parsed.comment.id,
            body: parsed.comment.body,
            argumentText: interaction.argumentText,
          },
        };
      }

      return {
        kind: "ignored",
        reason: `Comment did not contain a recognized nitpickr command. Supported commands: ${this.#supportedCommandExamples().join(", ")}.`,
      };
    }

    if (eventName === "pull_request_review_comment") {
      const parsedResult =
        pullRequestReviewCommentEventSchema.safeParse(payload);
      if (!parsedResult.success) {
        return {
          kind: "ignored",
          reason: "Unsupported pull_request_review_comment payload.",
        };
      }

      const parsed = parsedResult.data;
      if (!parsed.comment.in_reply_to_id) {
        return {
          kind: "ignored",
          reason: "Review comment is not a reply to an existing thread.",
        };
      }

      const interaction = parseInteractionCommand(
        parsed.comment.body,
        this.#botLogins,
        {
          requireMention: false,
        },
      );
      if (!interaction) {
        return {
          kind: "ignored",
          reason: `Comment did not contain a recognized nitpickr command. Supported commands: ${this.#supportedCommandExamples().join(", ")}.`,
        };
      }

      return {
        kind: "interaction_requested",
        installationId: String(parsed.installation.id),
        repository: normalizeRepository(
          parsed.repository,
          parsed.installation.id,
        ),
        pullNumber: parsed.pull_request.number,
        actorLogin: parsed.comment.user.login,
        command: interaction.command,
        replyTargetCommentId: parsed.comment.in_reply_to_id,
        source: {
          kind: "review_comment",
          commentId: parsed.comment.id,
          body: parsed.comment.body,
          argumentText: interaction.argumentText,
          path: parsed.comment.path ?? null,
          line: parsed.comment.line ?? null,
        },
      };
    }

    return {
      kind: "ignored",
      reason: `Unsupported GitHub event: ${eventName}`,
    };
  }

  async reactToMention(
    eventName: string,
    payload: unknown,
  ): Promise<{ commentId: number; content: "eyes" } | null> {
    if (eventName !== "issue_comment") {
      return null;
    }

    const parsedResult = issueCommentEventSchema.safeParse(payload);
    if (!parsedResult.success) {
      return null;
    }

    const parsed = parsedResult.data;
    if (!parsed.issue.pull_request) {
      return null;
    }
    if (!containsBotMention(parsed.comment.body, this.#botLogins)) {
      return null;
    }

    await this.#apiClient.createIssueCommentReaction({
      installationId: String(parsed.installation.id),
      owner: parsed.repository.owner.login,
      repo: parsed.repository.name,
      commentId: parsed.comment.id,
      content: "eyes",
    });

    return {
      commentId: parsed.comment.id,
      content: "eyes",
    };
  }

  #supportedCommandExamples(): string[] {
    return this.#botLogins.flatMap((botLogin) =>
      supportedCommandSuffixes.map((suffix) => `@${botLogin} ${suffix}`),
    );
  }

  async fetchChangeRequestContext(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    tenantId: string;
    repositoryId: string;
  }): Promise<GitHubChangeRequestContext> {
    const pullRequest = await this.#apiClient.getPullRequest({
      installationId: input.installationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      pullNumber: input.pullNumber,
    });

    const [files, issueComments, reviewComments] = await Promise.all([
      this.#apiClient.listPullRequestFiles({
        installationId: input.installationId,
        owner: input.repository.owner,
        repo: input.repository.name,
        pullNumber: input.pullNumber,
      }),
      this.#apiClient.listIssueComments({
        installationId: input.installationId,
        owner: input.repository.owner,
        repo: input.repository.name,
        issueNumber: input.pullNumber,
      }),
      this.#apiClient.listReviewComments({
        installationId: input.installationId,
        owner: input.repository.owner,
        repo: input.repository.name,
        pullNumber: input.pullNumber,
      }),
    ]);

    return {
      tenantId: input.tenantId,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      repository: input.repository,
      changeRequest: parseChangeRequest({
        id: `github:${input.repository.owner}/${input.repository.name}#${pullRequest.number}`,
        tenantId: input.tenantId,
        installationId: input.installationId,
        repositoryId: input.repositoryId,
        provider: "github",
        number: pullRequest.number,
        title: pullRequest.title,
        baseSha: pullRequest.base.sha,
        headSha: pullRequest.head.sha,
        status:
          pullRequest.state === "closed"
            ? "closed"
            : pullRequest.draft
              ? "draft"
              : "open",
        authorLogin: pullRequest.user.login,
      }),
      files: files.map((file) => ({
        path: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? null,
        previousPath: file.previous_filename ?? null,
      })),
      comments: [
        ...issueComments.map((comment) => ({
          id: `issue:${comment.id}`,
          authorLogin: comment.user.login,
          body: comment.body,
          path: null,
          line: null,
          createdAt: comment.created_at,
        })),
        ...reviewComments.map((comment) => ({
          id: `review:${comment.id}`,
          authorLogin: comment.user.login,
          body: comment.body,
          path: comment.path ?? null,
          line: comment.line ?? null,
          createdAt: comment.created_at,
        })),
      ],
    };
  }

  async comparePullRequestRange(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    baseSha: string;
    headSha: string;
  }): Promise<
    Array<{
      path: string;
      status: "added" | "modified" | "removed" | "renamed";
      additions: number;
      deletions: number;
      patch: string | null;
      previousPath: string | null;
    }>
  > {
    const files = await this.#apiClient.comparePullRequestRange({
      installationId: input.installationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      baseSha: input.baseSha,
      headSha: input.headSha,
    });

    return files.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch ?? null,
      previousPath: file.previous_filename ?? null,
    }));
  }

  async getFileContent(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    path: string;
    ref: string;
  }): Promise<string | null> {
    return this.#apiClient.getFileContent({
      installationId: input.installationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      path: input.path,
      ref: input.ref,
    });
  }

  async listNitpickrReviewThreads(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
  }): Promise<
    Array<{
      threadId: string;
      providerCommentId: string;
      path: string;
      line: number;
      fingerprint: string;
      isResolved: boolean;
      isOutdated?: boolean;
      body: string;
      reactionSummary: {
        positiveCount: number;
        negativeCount: number;
      };
    }>
  > {
    return this.#apiClient.listNitpickrReviewThreads({
      installationId: input.installationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      pullNumber: input.pullNumber,
      botLogins: this.#botLogins,
    });
  }

  async resolveReviewThread(input: {
    installationId: string;
    threadId: string;
  }): Promise<void> {
    await this.#apiClient.resolveReviewThread({
      installationId: input.installationId,
      threadId: input.threadId,
    });
  }

  async createIssueComment(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    body: string;
  }): Promise<void> {
    await this.#apiClient.createIssueComment({
      installationId: input.installationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      issueNumber: input.pullNumber,
      body: input.body,
    });
  }

  async createIssueCommentReaction(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    commentId: number;
    content: "eyes";
  }): Promise<void> {
    await this.#apiClient.createIssueCommentReaction({
      installationId: input.installationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      commentId: input.commentId,
      content: input.content,
    });
  }

  async replyToReviewComment(input: {
    installationId: string;
    repository: {
      owner: string;
      name: string;
    };
    pullNumber: number;
    commentId: number;
    body: string;
  }): Promise<void> {
    await this.#apiClient.replyToReviewComment({
      installationId: input.installationId,
      owner: input.repository.owner,
      repo: input.repository.name,
      pullNumber: input.pullNumber,
      commentId: input.commentId,
      body: input.body,
    });
  }
}
