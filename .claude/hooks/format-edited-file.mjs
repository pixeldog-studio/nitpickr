// PostToolUse hook: format and safe-fix the file Claude just edited with Biome.
// Never blocks the edit; lint problems still surface in `pnpm check`.
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";

const FORMATTABLE = /\.(?:[cm]?[jt]s|json)$/;

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
}

let filePath;
try {
  filePath = JSON.parse(raw).tool_input?.file_path;
} catch {
  // Not a hook payload; nothing to format.
}
const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

if (typeof filePath === "string" && FORMATTABLE.test(filePath)) {
  const inProject = !relative(projectDir, resolve(filePath)).startsWith("..");
  if (inProject) {
    spawnSync(
      "pnpm",
      [
        "exec",
        "biome",
        "check",
        "--write",
        "--no-errors-on-unmatched",
        filePath,
      ],
      { cwd: projectDir, stdio: "ignore" },
    );
  }
}
