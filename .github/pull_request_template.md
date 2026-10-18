## Ticket

<!-- FRO-123 link, or "no ticket (chore)" -->

## What changed

<!-- One paragraph: the change and why. List follow-ups deliberately left out, and known limits. -->

## Evidence

<!-- Paste the tail of the repo verify command (see AGENTS.md): `pnpm check` (N tests passed). If prompts, review behavior or scoring changed, add `pnpm eval:reviews` before/after. UI change: attach screenshots (light/dark). -->

## Gate receipt

<!-- Paste the rendered receipt from the quality-gate skill (.hq/receipt.json): every check + exit code, every acceptance criterion met/unmet. -->

## Review focus / risks

<!-- Where to look hardest: migrations, concurrency, payments, auth, anything uncertain. -->

---

- [ ] Verify command passes locally
- [ ] `pnpm eval:reviews` run if prompts, review behavior or scoring changed
- [ ] Tests, fixtures, snapshots and lint/type configs untouched (or explained above and reviewed by reward-hack-reviewer)
- [ ] No secrets, no new vendors/packages beyond what the ticket names
