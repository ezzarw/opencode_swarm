---
name: swarm-verifier
description: Independently verify swarm worker outputs with deterministic tests, typechecks, and diff audits before landing.
---

# Swarm Verifier

1. **Wait for Handoff**: Use `swarm_wait` until workers post `[done]` or request review.
2. **Run Deterministic Checks**: Execute exact test suites (`bun test`, `tsc --noEmit`, or module-specific checks) against the workspace or worker worktree.
3. **Audit Quarantine & Contracts**: Confirm workers only modified their assigned `allowed_paths` and preserved exported APIs.
4. **Report Actionably**: Post pass/fail with exact command output, failing file/line, and `@<worker>` for fixes, or `@coordinator [approved]` when ready to land.
