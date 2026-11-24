import type { SwarmBoard } from "./board.ts"

export interface MonitorOptions {
  /** Idle threshold before `[ttl-warning]` is emitted (default 270_000 ms = 4.5 min for 5-min cache TTL). */
  ttlWarningMs?: number
  /** Polling interval in ms when `start()` is used (default 15_000 ms). */
  checkIntervalMs?: number
  /** Custom clock for deterministic testing. */
  now?: () => number
}

export interface MonitorCheckResult {
  deadlocked: boolean
  quotaFrozen: boolean
  ttlWarnings: string[]
}

export class SwarmMonitor {
  private readonly board: SwarmBoard
  private readonly ttlWarningMs: number
  private readonly checkIntervalMs: number
  private readonly now: () => number

  private timer?: ReturnType<typeof setInterval>
  private warnedTtlAt = new Map<string, number>()
  private deadlockReportedHead = -1

  constructor(board: SwarmBoard, opts?: MonitorOptions) {
    this.board = board
    this.ttlWarningMs = opts?.ttlWarningMs ?? 270_000
    this.checkIntervalMs = opts?.checkIntervalMs ?? 15_000
    this.now = opts?.now ?? (() => Date.now())
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.runCheckOnce()
    }, this.checkIntervalMs)
    if (typeof this.timer.unref === "function") {
      this.timer.unref()
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  runCheckOnce(): MonitorCheckResult {
    const members = this.board.listMembers().filter((m) => m.role !== "coordinator" && m.role !== "monitor")
    const active = members.filter((m) => m.status !== "killed")
    const currentNow = this.now()
    const head = this.board.getHead()

    const ttlWarnings: string[] = []
    for (const m of active) {
      const idleMs = currentNow - m.lastActivityAt
      if (idleMs >= this.ttlWarningMs) {
        const lastWarnedForActivity = this.warnedTtlAt.get(m.name)
        if (lastWarnedForActivity !== m.lastActivityAt) {
          this.warnedTtlAt.set(m.name, m.lastActivityAt)
          ttlWarnings.push(m.name)
          this.board.postMessage(
            "monitor",
            `[ttl-warning] @coordinator @${m.name} idle for ${Math.round(idleMs / 1000)}s (approaching 5m prompt cache TTL).`,
            { kind: "alert" },
          )
        }
      }
    }

    const working = active.filter((m) => m.status === "working")
    const paused = active.filter((m) => m.status === "paused")
    const waitingOrQueued = active.filter((m) => m.status === "waiting" || m.status === "queued")

    let deadlocked = false
    let quotaFrozen = false

    if (active.length > 0 && working.length === 0) {
      if (paused.length > 0 && waitingOrQueued.length + paused.length === active.length) {
        quotaFrozen = true
        if (this.deadlockReportedHead !== head) {
          this.deadlockReportedHead = head
          this.board.postMessage(
            "monitor",
            `[quota-freeze] @coordinator All active workers are paused/waiting (${paused.map((p) => p.name).join(", ")} hit 429/quota).`,
            { kind: "alert" },
          )
        }
      } else if (waitingOrQueued.some((m) => m.status === "queued")) {
        deadlocked = true
        if (this.deadlockReportedHead !== head) {
          this.deadlockReportedHead = head
          this.board.postMessage(
            "monitor",
            `[deadlock] @coordinator No workers are running, but queued tasks remain (${waitingOrQueued.filter((m) => m.status === "queued").map((m) => m.name).join(", ")}).`,
            { kind: "alert" },
          )
        }
      }
    }

    return { deadlocked, quotaFrozen, ttlWarnings }
  }
}
