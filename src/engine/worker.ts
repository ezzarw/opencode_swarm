import {
  SwarmBoard,
  type BoardMessage,
  type MemberRole,
  type MemberState,
  type SwarmSummary,
  type UsageStats,
} from "./board.ts"
import { checkToolQuarantine } from "./quarantine.ts"
import { scheduleWaves, type WaveTask } from "./wave-scheduler.ts"
import { cleanupWorktree, createWorktree, landWorktree, type LandResult } from "./worktree.ts"

export interface LlmGenerateOptions {
  model?: string
  provider?: string
  system?: string
  signal?: AbortSignal
}

export interface LlmGenerateResult {
  text: string
  usage?: Partial<UsageStats>
}

export type LlmGenerateFn = (prompt: string, opts: LlmGenerateOptions) => Promise<LlmGenerateResult>

export type ToolDispatchFn = (
  name: string,
  args: Record<string, unknown>,
  context: { workerName: string; worktree?: string; workspaceRoot: string },
) => Promise<unknown>

export interface ModelInfo {
  id: string
  provider?: string
  name?: string
}

export type ListModelsFn = () => Promise<ModelInfo[]> | ModelInfo[]

export interface ReActPayload {
  thought?: string
  tool_calls?: Array<{ name: string; args?: Record<string, unknown> }>
  final_response?: string
}

export interface SpawnWorkerOptions {
  name: string
  brief: string
  role?: MemberRole
  model?: string
  provider?: string
  allowedPaths?: string[]
  worktree?: boolean | string
  channel?: string
  wave?: number
  dependsOn?: string[]
  maxSteps?: number
  retryPauseMs?: number
}

export interface SpawnBatchOptions {
  name: string
  brief: string
  tasks?: string[]
  n?: number
  role?: MemberRole
  model?: string
  provider?: string
  allowedPaths?: string[]
  worktree?: boolean
  channel?: string
  wave?: number
  dependsOn?: string[]
  autoWaves?: boolean
  filesByTask?: Record<string, string[]>
}

export interface SwarmManagerOptions {
  dataDir?: string
  workspaceRoot?: string
  llmGenerate: LlmGenerateFn
  toolDispatch?: ToolDispatchFn
  listModels?: ListModelsFn
  defaultModel?: string
  defaultProvider?: string
  requireVerifierOnLand?: boolean
}

function isRateLimitError(err: unknown): boolean {
  if (!err) return false
  const msg = err instanceof Error ? err.message : String(err)
  return /\b429\b|rate.?limit|too many requests|quota/i.test(msg)
}

export function parseReActResponse(raw: string): ReActPayload {
  const trimmed = raw.trim()
  // Try direct JSON or fenced ```json block
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed
  try {
    const parsed = JSON.parse(candidate) as ReActPayload
    if (parsed && typeof parsed === "object") {
      return parsed
    }
  } catch {
    // Fallback: treat plain text as final_response
  }
  return { final_response: trimmed }
}

interface WorkerRuntime {
  name: string
  abort: AbortController
  donePromise: Promise<void>
  resolveIdle?: () => void
  history: Array<{ role: "user" | "assistant"; content: string }>
}

export class SwarmEngine {
  readonly board: SwarmBoard
  readonly workspaceRoot: string
  private readonly llmGenerate: LlmGenerateFn
  private readonly toolDispatch?: ToolDispatchFn
  private readonly modelsProvider?: ListModelsFn
  private readonly defaultModel?: string
  private readonly defaultProvider?: string
  private readonly requireVerifierOnLand: boolean

  private runtimes = new Map<string, WorkerRuntime>()
  private idleWaiters = new Map<string, Set<() => void>>()

  constructor(board: SwarmBoard, opts: SwarmManagerOptions) {
    this.board = board
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd()
    this.llmGenerate = opts.llmGenerate
    this.toolDispatch = opts.toolDispatch
    this.modelsProvider = opts.listModels
    this.defaultModel = opts.defaultModel
    this.defaultProvider = opts.defaultProvider
    this.requireVerifierOnLand = opts.requireVerifierOnLand ?? false
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelsProvider) {
      return await this.modelsProvider()
    }
    if (this.defaultModel) {
      return [{ id: this.defaultModel, provider: this.defaultProvider, name: this.defaultModel }]
    }
    return []
  }

  spawnWorker(opts: SpawnWorkerOptions): MemberState {
    if (this.runtimes.has(opts.name)) {
      throw new Error(`Worker "${opts.name}" already exists`)
    }

    let worktreePath: string | undefined
    let branch: string | undefined
    if (opts.worktree === true) {
      const wt = createWorktree(this.workspaceRoot, opts.name)
      worktreePath = wt.path
      branch = wt.branch
    } else if (typeof opts.worktree === "string") {
      worktreePath = opts.worktree
    }

    const initialStatus =
      (opts.wave && opts.wave > 1) || (opts.dependsOn && opts.dependsOn.length > 0) ? "queued" : "working"

    const member = this.board.upsertMember({
      name: opts.name,
      role: opts.role ?? "worker",
      model: opts.model ?? this.defaultModel,
      provider: opts.provider ?? this.defaultProvider,
      status: initialStatus,
      wave: opts.wave ?? 1,
      dependsOn: opts.dependsOn,
      allowedPaths: opts.allowedPaths,
      worktree: worktreePath,
      branch,
      channels: opts.channel ? [opts.channel] : ["#general"],
      activity: initialStatus === "queued" ? "Queued for wave" : "Starting",
    })

    this.board.postMessage("coordinator", `@${opts.name} ${opts.brief}`, {
      channel: opts.channel,
      kind: "brief",
    })

    const abort = new AbortController()
    const runtime: WorkerRuntime = {
      name: opts.name,
      abort,
      donePromise: Promise.resolve(),
      history: [],
    }
    runtime.donePromise = this.runWorkerLoop(runtime, opts)
    this.runtimes.set(opts.name, runtime)

    return member
  }

  spawnBatch(opts: SpawnBatchOptions): MemberState[] {
    const names: Array<{ name: string; target?: string }> = []
    if (opts.tasks && opts.tasks.length > 0) {
      opts.tasks.forEach((t, idx) => {
        names.push({ name: `${opts.name}-${idx + 1}`, target: t })
      })
    } else if (opts.n && opts.n > 1) {
      for (let i = 1; i <= opts.n; i++) {
        names.push({ name: `${opts.name}-${i}` })
      }
    } else {
      names.push({ name: opts.name })
    }

    let waveByTask: Record<string, number> = {}
    if (opts.autoWaves) {
      const waveTasks: WaveTask[] = names.map((item) => ({
        name: item.name,
        files: item.target ? (opts.filesByTask?.[item.target] ?? [item.target]) : undefined,
        dependsOn: opts.dependsOn,
        wave: opts.wave,
      }))
      const scheduled = scheduleWaves(waveTasks, { rootDir: this.workspaceRoot })
      waveByTask = scheduled.taskWave
      this.board.writePlan(scheduled)
    }

    return names.map((item) => {
      const brief = item.target ? `${opts.brief}\n\nAssigned target: ${item.target}` : opts.brief
      return this.spawnWorker({
        name: item.name,
        brief,
        role: opts.role,
        model: opts.model,
        provider: opts.provider,
        allowedPaths: opts.allowedPaths ?? (item.target ? [item.target] : undefined),
        worktree: opts.worktree,
        channel: opts.channel,
        wave: waveByTask[item.name] ?? opts.wave,
        dependsOn: opts.dependsOn,
      })
    })
  }

  private notifyIdleWaiters(name: string): void {
    const waiters = this.idleWaiters.get(name)
    if (!waiters) return
    for (const resolve of waiters) resolve()
    waiters.clear()
  }

  private async waitForDependencies(runtime: WorkerRuntime, opts: SpawnWorkerOptions): Promise<boolean> {
    const deps = opts.dependsOn ?? []
    const myWave = opts.wave ?? 1
    if (deps.length === 0 && myWave <= 1) return true

    while (!runtime.abort.signal.aborted) {
      const member = this.board.getMember(runtime.name)
      if (!member || member.status === "killed") return false

      const allMembers = this.board.listMembers()
      const prevWaveBusy =
        myWave > 1 &&
        allMembers.some(
          (m) =>
            m.name !== runtime.name &&
            (m.wave ?? 1) < myWave &&
            (m.status === "working" || m.status === "queued" || m.status === "paused"),
        )

      const depsBusy = deps.some((d) => {
        const depMember = this.board.getMember(d)
        return depMember && (depMember.status === "working" || depMember.status === "queued" || depMember.status === "paused")
      })

      if (!prevWaveBusy && !depsBusy) {
        return true
      }

      this.board.updateMember(runtime.name, { status: "queued", activity: "Waiting for wave/dependencies" })
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100)
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        runtime.abort.signal.addEventListener("abort", onAbort, { once: true })
      })
    }
    return false
  }

  private async runWorkerLoop(runtime: WorkerRuntime, opts: SpawnWorkerOptions): Promise<void> {
    const maxSteps = opts.maxSteps ?? 25
    const ready = await this.waitForDependencies(runtime, opts)
    if (!ready) return

    this.board.updateMember(runtime.name, { status: "working", activity: "Running" })
    runtime.history.push({ role: "user", content: opts.brief })

    let steps = 0
    while (!runtime.abort.signal.aborted && steps < maxSteps) {
      const member = this.board.getMember(runtime.name)
      if (!member || member.status === "killed") break

      if (member.status === "waiting") {
        this.notifyIdleWaiters(runtime.name)
        const msgs = await this.board.waitForMessage(runtime.name, {
          since: member.lastReadSeq,
          mentionsOnly: true,
          signal: runtime.abort.signal,
        })
        if (runtime.abort.signal.aborted) break
        const latest = this.board.getMember(runtime.name)
        if (!latest || latest.status === "killed") break

        if (msgs.length > 0) {
          latest.lastReadSeq = Math.max(latest.lastReadSeq, msgs[msgs.length - 1].seq)
          const deltaText = msgs.map((m) => `#${m.seq} ${m.agent} (${m.channel}): ${m.text}`).join("\n")
          runtime.history.push({ role: "user", content: `New board messages:\n${deltaText}` })
        }
        this.board.updateMember(runtime.name, { status: "working", activity: "Woke on mention" })
      }

      const currentMember = this.board.getMember(runtime.name)
      if (!currentMember || currentMember.status === "killed") break

      const prompt = this.buildPrompt(runtime.name, currentMember, runtime.history)
      let res: LlmGenerateResult
      try {
        res = await this.llmGenerate(prompt, {
          model: currentMember.model,
          provider: currentMember.provider,
          system: `You are ${runtime.name} (${currentMember.role}) in an OpenCode swarm. Respond in JSON: {"thought": string, "tool_calls": [{"name": string, "args": object}], "final_response"?: string}.`,
          signal: runtime.abort.signal,
        })
      } catch (err) {
        if (runtime.abort.signal.aborted) break
        if (isRateLimitError(err)) {
          this.board.updateMember(runtime.name, {
            status: "paused",
            failure: err instanceof Error ? err.message : String(err),
            activity: "Rate limited (429)",
          })
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, opts.retryPauseMs ?? 500)
            runtime.abort.signal.addEventListener("abort", () => {
              clearTimeout(timer)
              resolve()
            }, { once: true })
          })
          if (!runtime.abort.signal.aborted) {
            this.board.updateMember(runtime.name, { status: "working", failure: undefined, activity: "Resuming after 429" })
          }
          continue
        }
        this.board.updateMember(runtime.name, {
          status: "waiting",
          failure: err instanceof Error ? err.message : String(err),
          activity: "Error",
        })
        this.notifyIdleWaiters(runtime.name)
        continue
      }

      if (res.usage) {
        this.board.recordUsage(runtime.name, res.usage)
      }

      steps += 1
      this.board.updateMember(runtime.name, { steps })
      runtime.history.push({ role: "assistant", content: res.text })

      const parsed = parseReActResponse(res.text)
      if (parsed.tool_calls && parsed.tool_calls.length > 0) {
        const results: string[] = []
        let wentToSleep = false

        for (const call of parsed.tool_calls) {
          const toolArgs = call.args ?? {}
          if (call.name === "post_message") {
            const msg = this.board.postMessage(runtime.name, String(toolArgs.text ?? ""), {
              channel: typeof toolArgs.channel === "string" ? toolArgs.channel : undefined,
            })
            results.push(`post_message -> seq #${msg.seq}`)
          } else if (call.name === "read_board") {
            const msgs = this.board.readMessages({
              since: typeof toolArgs.since === "number" ? toolArgs.since : undefined,
              limit: typeof toolArgs.limit === "number" ? toolArgs.limit : undefined,
              channel: typeof toolArgs.channel === "string" ? toolArgs.channel : undefined,
              member: runtime.name,
            })
            results.push(`read_board -> ${JSON.stringify(msgs)}`)
          } else if (call.name === "swarm_wait") {
            wentToSleep = true
            this.board.updateMember(runtime.name, { status: "waiting", activity: "Waiting on board" })
            results.push("swarm_wait -> entering 0-token sleep")
          } else {
            const q = checkToolQuarantine(
              currentMember.allowedPaths,
              call.name,
              toolArgs,
              currentMember.worktree ?? this.workspaceRoot,
            )
            if (!q.allowed) {
              results.push(`${call.name} BLOCKED: ${q.reason}`)
            } else if (this.toolDispatch) {
              try {
                const out = await this.toolDispatch(call.name, toolArgs, {
                  workerName: runtime.name,
                  worktree: currentMember.worktree,
                  workspaceRoot: currentMember.worktree ?? this.workspaceRoot,
                })
                results.push(`${call.name} -> ${typeof out === "string" ? out : JSON.stringify(out)}`)
              } catch (toolErr) {
                results.push(`${call.name} ERROR: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`)
              }
            } else {
              results.push(`${call.name} -> no tool dispatcher configured`)
            }
          }
        }

        runtime.history.push({ role: "user", content: `Tool results:\n${results.join("\n")}` })
        if (wentToSleep) continue
      }

      if (parsed.final_response !== undefined) {
        if (parsed.final_response.trim()) {
          this.board.postMessage(runtime.name, parsed.final_response.trim(), {
            channel: opts.channel,
            kind: "result",
          })
        }
        this.board.updateMember(runtime.name, { status: "waiting", activity: "Idle (waiting)" })
        this.notifyIdleWaiters(runtime.name)
      }
    }

    const endMember = this.board.getMember(runtime.name)
    if (endMember && endMember.status !== "killed") {
      this.board.updateMember(runtime.name, { status: "waiting", activity: "Idle" })
    }
    this.notifyIdleWaiters(runtime.name)
  }

  private buildPrompt(
    name: string,
    member: MemberState,
    history: Array<{ role: "user" | "assistant"; content: string }>,
  ): string {
    const recent = history.slice(-12).map((h) => `[${h.role.toUpperCase()}]\n${h.content}`).join("\n\n")
    const quarantineNote = member.allowedPaths?.length
      ? `Allowed paths: ${member.allowedPaths.join(", ")}`
      : "No path quarantine"
    return `Worker: ${name}\n${quarantineNote}\n\n${recent}`
  }

  async join(names: string[], timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    await Promise.all(
      names.map(async (name) => {
        const m = this.board.getMember(name)
        if (!m || m.status === "waiting" || m.status === "killed") return
        const remaining = Math.max(1, deadline - Date.now())
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining)
          let set = this.idleWaiters.get(name)
          if (!set) {
            set = new Set()
            this.idleWaiters.set(name, set)
          }
          const done = () => {
            clearTimeout(timer)
            resolve()
          }
          set.add(done)
        })
      }),
    )
  }

  swapModel(name: string, model: string, provider?: string): MemberState {
    const member = this.board.getMember(name)
    if (!member) {
      throw new Error(`Unknown member: ${name}`)
    }
    const updated = this.board.updateMember(name, {
      model,
      provider: provider ?? member.provider,
    })!
    this.board.postMessage("coordinator", `@${name} model switched to ${model}${provider ? ` (${provider})` : ""}`, {
      kind: "system",
    })
    return updated
  }

  land(name: string, opts?: { verifierApproved?: boolean; targetBranch?: string }): LandResult {
    const member = this.board.getMember(name)
    if (!member) {
      return { ok: false, reason: "not_found", message: `Unknown member: ${name}` }
    }
    if (!member.worktree) {
      return { ok: false, reason: "not_found", message: `Member ${name} has no worktree` }
    }
    return landWorktree(this.workspaceRoot, member.worktree, {
      requireVerifier: this.requireVerifierOnLand,
      verifierApproved: opts?.verifierApproved,
      targetBranch: opts?.targetBranch,
    })
  }

  killWorker(name: string, opts?: { force?: boolean }): { ok: boolean; reason?: string } {
    const member = this.board.getMember(name)
    if (!member) {
      return { ok: false, reason: `Unknown member: ${name}` }
    }

    if (member.worktree) {
      const cleaned = cleanupWorktree(this.workspaceRoot, member.worktree, {
        force: opts?.force,
        deleteBranch: true,
      })
      if (!cleaned.ok) {
        return cleaned
      }
    }

    const runtime = this.runtimes.get(name)
    if (runtime) {
      runtime.abort.abort()
      this.runtimes.delete(name)
    }

    this.board.updateMember(name, { status: "killed", activity: "Killed" })
    this.board.wakeMember(name)
    this.notifyIdleWaiters(name)
    return { ok: true }
  }

  async shutdown(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      runtime.abort.abort()
    }
    this.runtimes.clear()
    for (const m of this.board.listMembers()) {
      this.board.wakeMember(m.name)
      this.notifyIdleWaiters(m.name)
    }
  }
}

export class SwarmManager {
  private engines = new Map<string, SwarmEngine>()
  private readonly opts: SwarmManagerOptions

  constructor(opts: SwarmManagerOptions) {
    this.opts = opts
  }

  getEngine(swarmId = "default"): SwarmEngine {
    let engine = this.engines.get(swarmId)
    if (!engine) {
      const board = new SwarmBoard(swarmId, { dataDir: this.opts.dataDir })
      engine = new SwarmEngine(board, this.opts)
      this.engines.set(swarmId, engine)
    }
    return engine
  }

  listSwarms(): SwarmSummary[] {
    return SwarmBoard.listSwarms(this.opts.dataDir)
  }

  async shutdownAll(): Promise<void> {
    for (const engine of this.engines.values()) {
      await engine.shutdown()
    }
    this.engines.clear()
  }
}
