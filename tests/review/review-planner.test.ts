import { describe, expect, it } from "vitest";

import { defaultRepositoryConfig } from "../../src/config/repository-config-loader.js";
import { ReviewPlanner } from "../../src/review/review-planner.js";

describe("ReviewPlanner", () => {
  it("filters ignored files and caps the review set", () => {
    const planner = new ReviewPlanner();

    const plan = planner.plan({
      mode: "quick",
      config: {
        ...defaultRepositoryConfig,
        source: null,
        review: {
          ...defaultRepositoryConfig.review,
          ignorePaths: ["dist/**"],
          maxFiles: 1,
        },
      },
      files: [
        {
          path: "dist/generated.js",
          additions: 10,
          deletions: 0,
          patch: "@@ -0,0 +1 @@\n+generated",
        },
        {
          path: "src/api/server.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const x = 1;",
        },
        {
          path: "src/worker/index.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const y = 1;",
        },
      ],
    });

    expect(plan.files.map((file) => file.path)).toEqual(["src/api/server.ts"]);
    expect(plan.commentBudget).toBe(
      defaultRepositoryConfig.review.maxAutoComments,
    );
  });

  it("uses the smaller automatic comment budget for quick reviews", () => {
    const planner = new ReviewPlanner();

    const plan = planner.plan({
      mode: "quick",
      config: {
        ...defaultRepositoryConfig,
        source: null,
        review: {
          ...defaultRepositoryConfig.review,
          maxComments: 8,
          maxAutoComments: 3,
        },
      },
      files: [
        {
          path: "src/api/server.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const x = 1;",
        },
      ],
    });

    expect(plan.commentBudget).toBe(3);
  });

  it("uses the full comment budget for manual full reviews", () => {
    const planner = new ReviewPlanner();

    const plan = planner.plan({
      mode: "full",
      config: {
        ...defaultRepositoryConfig,
        source: null,
        review: {
          ...defaultRepositoryConfig.review,
          maxComments: 8,
          maxAutoComments: 3,
        },
      },
      files: [
        {
          path: "src/api/server.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const x = 1;",
        },
      ],
    });

    expect(plan.commentBudget).toBe(8);
  });

  it("switches to summary-only mode for summary requests", () => {
    const planner = new ReviewPlanner();

    const plan = planner.plan({
      mode: "summary",
      config: {
        ...defaultRepositoryConfig,
        source: null,
      },
      files: [
        {
          path: "src/api/server.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const x = 1;",
        },
      ],
    });

    expect(plan.summaryOnly).toBe(true);
    expect(plan.commentBudget).toBe(0);
  });

  it("returns a skip reason when no files are reviewable", () => {
    const planner = new ReviewPlanner();

    const plan = planner.plan({
      mode: "quick",
      config: {
        ...defaultRepositoryConfig,
        source: null,
        review: {
          ...defaultRepositoryConfig.review,
          ignorePaths: ["src/**"],
        },
      },
      files: [
        {
          path: "src/api/server.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const x = 1;",
        },
      ],
    });

    expect(plan.files).toEqual([]);
    expect(plan.skipReason).toMatch(/no reviewable files/i);
  });

  it("switches oversized automatic reviews into summary-only mode with a reason", () => {
    const planner = new ReviewPlanner();

    const plan = planner.plan({
      mode: "quick",
      config: {
        ...defaultRepositoryConfig,
        source: null,
        review: {
          ...defaultRepositoryConfig.review,
          summaryOnlyThreshold: 1,
        },
      },
      files: [
        {
          path: "src/api/server.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const x = 1;",
        },
        {
          path: "src/worker/index.ts",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,1 +1,2 @@\n export {}\n+const y = 1;",
        },
      ],
    });

    expect(plan.summaryOnly).toBe(true);
    expect(plan.commentBudget).toBe(0);
    expect(plan.summaryOnlyReason).toMatch(/summary-only/i);
  });
});

describe("generated files", () => {
  it("skips lockfiles, snapshots and minified bundles", async () => {
    const { isGeneratedFile } = await import(
      "../../src/review/review-planner.js"
    );
    expect(isGeneratedFile("pnpm-lock.yaml")).toBe(true);
    expect(
      isGeneratedFile(
        "ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
      ),
    ).toBe(true);
    expect(isGeneratedFile("tests/__snapshots__/a.test.ts.snap")).toBe(true);
    expect(isGeneratedFile("public/app.min.js")).toBe(true);
    expect(isGeneratedFile("src/lockfile-parser.ts")).toBe(false);
  });
});
