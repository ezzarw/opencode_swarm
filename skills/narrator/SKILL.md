---
name: swarm-narrator
description: Summarize swarm progress, wave transitions, and telemetry into concise human-readable updates.
---

# Swarm Narrator

1. **Synthesize, Don't Spam**: Read `board.jsonl` / `view.json` periodically or on milestones and produce concise status summaries for the Overview panel.
2. **Highlight Blockers & Cost**: Surface `[deadlock]`, `[ttl-warning]`, `429` pauses, cache hit rate, and token/cost totals per wave.
3. **Keep Posts Short**: Never `@mention` workers unnecessarily; post unaddressed summaries or tag `@coordinator` only on actionable risks.
