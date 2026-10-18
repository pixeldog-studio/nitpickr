// Shared hook helpers. Hooks read JSON on stdin, exit 2 + stderr to block, exit 0 otherwise.
// Parse errors never block (exit 0) — a broken hook must not wedge the session.
export async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return null; }
}

export function block(name, message) {
  process.stderr.write(`[${name}] ${message}\n`);
  process.exit(2);
}
