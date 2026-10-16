import { describe, expect, it } from "vitest";

import { findRelatedCode, symbolsNear } from "../../src/review/related-code.js";

const handler = [
  'import { deleteProject } from "../db/projects";',
  "",
  "export async function handle(request: Request) {",
  "  const user = await getSessionUser(request);",
  "  await deleteProject(request.params.id);",
  "  return new Response(null, { status: 204 });",
  "}",
].join("\n");

const repository = [
  "export async function deleteProject(id: string) {",
  "  // Callers must check ownership first.",
  '  await db.query("delete from projects where id = $1", [id]);',
  "}",
].join("\n");

const router = [
  'import { handle } from "./handler";',
  "app.delete('/projects/:id', requireOwner, (req) => handle(req));",
].join("\n");

describe("related code", () => {
  it("finds the names on the flagged lines, calls first", () => {
    const symbols = symbolsNear(handler, 5, 0);
    expect(symbols[0]).toBe("deleteProject");
    expect(symbols).not.toContain("await");
  });

  it("includes definitions and call sites from other PR files", () => {
    const related = findRelatedCode({
      finding: { path: "src/api/handler.ts", line: 5 },
      files: [
        { path: "src/api/handler.ts", fileContent: handler },
        { path: "src/db/projects.ts", fileContent: repository },
        { path: "src/api/router.ts", fileContent: router },
      ],
    });

    expect(
      related.map((entry) => [entry.path, entry.kind, entry.symbol]),
    ).toContainEqual(["src/db/projects.ts", "definition", "deleteProject"]);
    expect(
      related.find((entry) => entry.path === "src/db/projects.ts")?.text,
    ).toContain("2:   // Callers must check ownership first.");
  });

  it("returns nothing without the file content", () => {
    expect(
      findRelatedCode({
        finding: { path: "a.ts", line: 1 },
        files: [{ path: "a.ts" }],
      }),
    ).toEqual([]);
  });
});
