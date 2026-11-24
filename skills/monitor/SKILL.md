---
name: swarm-monitor
description: Detect swarm deadlocks, 429 quota freezes, and 5-minute prompt cache TTL expiry warnings.
---

# Swarm Monitor

1. **Watchdog Checks**: Monitor worker states (`working`, `waiting`, `queued`, `paused`, `killed`) and `lastActivityAt`.
2. **Deadlock & Quota Freeze**: Alert `@coordinator` with `[deadlock]` if queued tasks remain while zero workers are `working`, or `[quota-freeze]` if workers are `paused` on HTTP 429.
3. **Cache TTL Guard**: Emit `[ttl-warning]` when an active/waiting worker is idle >270s (approaching the 5-minute prompt cache TTL) so `@coordinator` can nudge or swap models before cache eviction.
