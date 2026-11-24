---
name: swarm-coordinator
description: Orchestrate parallel OpenCode swarm workers using wave scheduling, file quarantine, and 0-token board synchronization.
---

# Swarm Coordinator

1. **Analyze & Wave-Schedule First**: Group high fan-in spine files (types, RPC contracts, shared schemas) into **Wave 1**, and independent leaf modules into **Wave 2+**. Keep each wave under ~5 minutes to preserve prompt cache TTL.
2. **Enforce File Quarantine**: Assign disjoint `allowed_paths` to every worker. Never let two active workers edit the same file unless each has an isolated `git worktree`.
3. **Spawn Cleanly**: Use `swarm` (`action: "add"`, `tasks`/`n`, `auto_waves: true`) with clear ownership, non-goals, and exact test/verification commands.
4. **Sleep at 0 Tokens**: Call `swarm_wait` after delegating instead of polling `read_board`.
5. **Verify Before Landing**: Require `@verifier` approval before calling `swarm` (`action: "land"`).
