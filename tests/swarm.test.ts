import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
  SwarmBoard,
  matchesMention,
  normalizeChannel,
  parseMentions,
} from "../src/engine/board.ts"
import { scheduleWaves, analyzeDependencies, scanImports } from "../src/engine/wave-scheduler.ts"
import {
  createWorktree,
  getWorktreeStatus,
  landWorktree,
  cleanupWorktree,
} from "../src/engine/worktree.ts"
import { checkToolQuarantine, isPathAllowed } from "../src/engine/quarantine.ts"
import { SwarmEngine, SwarmManager, parseReActResponse } from "../src/engine/worker.ts"
import { SwarmMonitor } from "../src/engine/monitor.ts"
import { SwarmRpc } from "../src/rpc.ts"
import swarmPlugin from "../src/index.ts"

function makeTempDir(prefix = "opencode-swarm-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Swarm Test"], { cwd: dir, stdio: "ignore" })
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Repo\n", "utf8")
  fs.writeFileSync(path.join(dir, ".gitignore"), ".opencode-swarm/\n", "utf8")
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: dir, stdio: "ignore" })
  execFileSync("git", ["commit", "-m", "initial commit"], { cwd: dir, stdio: "ignore" })
}

describe("board.ts", () => {
  let tmpDir: string
  let board: SwarmBoard

  beforeEach(() => {
    tmpDir = makeTempDir("swarm-board-")
    board = new SwarmBoard("test-swarm", { dataDir: tmpDir, title: "Test Swarm" })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("appends messages with monotonic seq and persists board.jsonl", () => {
    const m1 = board.postMessage("coordinator", "first message")
    const m2 = board.postMessage("worker-1", "second message")
    expect(m1.seq).toBe(1)
    expect(m2.seq).toBe(2)
    expect(board.getHead()).toBe(2)

    const reloaded = new SwarmBoard("test-swarm", { dataDir: tmpDir })
    expect(reloaded.getHead()).toBe(2)
    expect(reloaded.readMessages().length).toBe(2)
  })

  test("parses and matches @mention, @prefix, @all, and @#channel", () => {
    expect(parseMentions("@worker-1 @#backend hello @all")).toEqual({
      names: ["worker-1"],
      channels: ["#backend"],
      all: true,
    })

    expect(matchesMention("@worker-1 check this", "worker-1", ["#general"])).toBe(true)
    expect(matchesMention("@worker-1 check this", "worker-2", ["#general"])).toBe(false)
    expect(matchesMention("@worker batch update", "worker-1", ["#general"])).toBe(true)
    expect(matchesMention("@worker batch update", "worker-2", ["#general"])).toBe(true)
    expect(matchesMention("@all standup", "verifier", ["#general"])).toBe(true)
    expect(matchesMention("@#backend deploy ready", "api-dev", ["#backend"])).toBe(true)
    expect(matchesMention("@#backend deploy ready", "ui-dev", ["#frontend"])).toBe(false)
  })

  test("enforces Channel ACL (create, subscribe, unsubscribe, archive) and visibleUnread", () => {
    board.upsertMember({ name: "api-dev", role: "worker", channels: ["#general"] })
    board.upsertMember({ name: "ui-dev", role: "worker", channels: ["#general"] })

    const backend = board.createChannel("backend", { description: "Backend channel" })
    expect(backend.name).toBe("#backend")
    expect(normalizeChannel("Backend")).toBe("#backend")

    board.subscribeChannel("api-dev", "#backend")
    expect(board.effectiveChannels("api-dev")).toContain("#backend")
    expect(board.effectiveChannels("ui-dev")).not.toContain("#backend")

    board.postMessage("coordinator", "secret backend task", { channel: "#backend" })
    board.postMessage("coordinator", "@ui-dev cross-channel ping", { channel: "#backend" })

    const apiUnread = board.visibleUnread("api-dev")
    expect(apiUnread.length).toBe(2)

    const uiUnread = board.visibleUnread("ui-dev")
    expect(uiUnread.length).toBe(1)
    expect(uiUnread[0].text).toContain("@ui-dev")

    // Calling visibleUnread again returns 0 because lastReadSeq advanced
    expect(board.visibleUnread("ui-dev").length).toBe(0)

    board.unsubscribeChannel("api-dev", "#backend")
    expect(board.effectiveChannels("api-dev")).not.toContain("#backend")

    const archived = board.archiveChannel("#backend")
    expect(archived?.archived).toBe(true)
    expect(board.listChannels(false).some((c) => c.name === "#backend")).toBe(false)
    expect(() => board.archiveChannel("#general")).toThrow()
  })

  test("generates view.html with escaped content and member/message sections", () => {
    board.upsertMember({ name: "alpha", role: "worker", model: "gpt-test", status: "working" })
    board.postMessage("alpha", "Hello <script>alert(1)</script>")

    expect(fs.existsSync(board.viewHtmlFile)).toBe(true)
    const html = fs.readFileSync(board.viewHtmlFile, "utf8")
    expect(html).toContain("<!doctype html>")
    expect(html).toContain("Test Swarm")
    expect(html).toContain("alpha")
    expect(html).not.toContain("<script>alert(1)</script>")
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })
})

describe("wave-scheduler.ts", () => {
  test("scanImports and analyzeDependencies separate high fan-in spine (Wave 1) from leaf (Wave 2)", () => {
    const fileContents: Record<string, string> = {
      "src/types.ts": "export interface Item { id: string }\n",
      "src/api.ts": `import type { Item } from "./types.ts"\nexport const getItem = (): Item => ({ id: "1" })\n`,
      "src/ui.ts": `import type { Item } from "./types.ts"\nexport const render = (i: Item) => i.id\n`,
      "src/cli.ts": `import type { Item } from "./types.ts"\nexport const print = (i: Item) => console.log(i.id)\n`,
    }

    expect(scanImports(fileContents["src/api.ts"])).toEqual(["./types.ts"])

    const analysis = analyzeDependencies(Object.keys(fileContents), {
      rootDir: "/repo",
      spineThreshold: 2,
      fileContents,
    })
    expect(analysis.spineFiles).toEqual(["src/types.ts"])
    expect(analysis.leafFiles).toContain("src/api.ts")
    expect(analysis.leafFiles).toContain("src/ui.ts")
    expect(analysis.fanIn["src/types.ts"]).toBe(3)

    const scheduled = scheduleWaves(
      [
        { name: "t-types", files: ["src/types.ts"] },
        { name: "t-api", files: ["src/api.ts"] },
        { name: "t-ui", files: ["src/ui.ts"] },
        { name: "t-cli", files: ["src/cli.ts"] },
      ],
      { rootDir: "/repo", spineThreshold: 2, fileContents },
    )

    expect(scheduled.taskWave["t-types"]).toBe(1)
    expect(scheduled.taskWave["t-api"]).toBe(2)
    expect(scheduled.taskWave["t-ui"]).toBe(2)
    expect(scheduled.taskWave["t-cli"]).toBe(2)
    expect(scheduled.waves[0].role).toBe("spine")
    expect(scheduled.waves[1].role).toBe("leaf")
  })
})

describe("worktree.ts", () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = makeTempDir("swarm-git-")
    initGitRepo(repoDir)
  })

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true })
  })

  test("creates worktree, enforces verifier gate and conflict check on land(), and cleans up safely", () => {
    const wt = createWorktree(repoDir, "worker-1")
    expect(wt.branch).toBe("swarm/worker-1")
    expect(fs.existsSync(wt.path)).toBe(true)

    // Uncommitted change blocks non-forced cleanup
    fs.writeFileSync(path.join(wt.path, "feature.txt"), "hello\n", "utf8")
    expect(getWorktreeStatus(wt.path).clean).toBe(false)
    expect(cleanupWorktree(repoDir, wt.path).ok).toBe(false)

    // Commit change in worktree
    execFileSync("git", ["add", "feature.txt"], { cwd: wt.path, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "add feature"], { cwd: wt.path, stdio: "ignore" })

    // Verifier gate blocks landing when requireVerifier=true and verifierApproved=false
    const blocked = landWorktree(repoDir, wt.path, {
      requireVerifier: true,
      verifierApproved: false,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toBe("verifier_required")

    // Approved land succeeds
    const landed = landWorktree(repoDir, wt.path, {
      requireVerifier: true,
      verifierApproved: true,
    })
    expect(landed.ok).toBe(true)
    expect(landed.mergedBranch).toBe("swarm/worker-1")
    expect(fs.existsSync(path.join(repoDir, "feature.txt"))).toBe(true)

    // Conflict detection
    const wt2 = createWorktree(repoDir, "worker-2")
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Main change\n", "utf8")
    execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "main edit"], { cwd: repoDir, stdio: "ignore" })

    fs.writeFileSync(path.join(wt2.path, "README.md"), "# Worker 2 conflict\n", "utf8")
    execFileSync("git", ["add", "README.md"], { cwd: wt2.path, stdio: "ignore" })
    execFileSync("git", ["commit", "-m", "worker 2 edit"], { cwd: wt2.path, stdio: "ignore" })

    const conflict = landWorktree(repoDir, wt2.path)
    expect(conflict.ok).toBe(false)
    expect(conflict.reason).toBe("conflict")

    expect(cleanupWorktree(repoDir, wt.path, { deleteBranch: true }).ok).toBe(true)
    expect(cleanupWorktree(repoDir, wt2.path, { force: true, deleteBranch: true }).ok).toBe(true)
  })
})

describe("quarantine.ts", () => {
  test("blocks edits outside allowed_paths and allows edits inside", () => {
    const root = "/workspace/repo"
    expect(isPathAllowed("src/ui/app.tsx", ["src/ui/**"], root)).toBe(true)
    expect(isPathAllowed("src/server/index.ts", ["src/ui/**"], root)).toBe(false)

    const blocked = checkToolQuarantine(["src/ui/**"], "write", { filePath: "src/server/index.ts" }, root)
    expect(blocked.allowed).toBe(false)
    expect(blocked.blockedPath).toBe("src/server/index.ts")

    const allowed = checkToolQuarantine(["src/ui/**"], "edit", { filePath: "src/ui/panel.tsx" }, root)
    expect(allowed.allowed).toBe(true)

    const patchBlocked = checkToolQuarantine(
      ["src/ui/**"],
      "apply_patch",
      { patch: "*** Update File: package.json\n@@\n" },
      root,
    )
    expect(patchBlocked.allowed).toBe(false)

    // Non-write tools are never blocked
    const readOk = checkToolQuarantine(["src/ui/**"], "read", { filePath: "package.json" }, root)
    expect(readOk.allowed).toBe(true)
  })
})

describe("worker.ts", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir("swarm-worker-")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("parseReActResponse handles fenced JSON and plain text fallback", () => {
    const fenced = parseReActResponse('```json\n{"thought":"ok","final_response":"done"}\n```')
    expect(fenced.thought).toBe("ok")
    expect(fenced.final_response).toBe("done")

    const plain = parseReActResponse("plain final text")
    expect(plain.final_response).toBe("plain final text")
  })

  test("runs independent ReAct loop, toolDispatch, usage telemetry, spawnBatch, join, and listModels", async () => {
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = []
    let callIdx = 0

    const manager = new SwarmManager({
      dataDir: tmpDir,
      workspaceRoot: tmpDir,
      listModels: async () => [{ id: "model-a", provider: "prov-x", name: "Model A" }],
      toolDispatch: async (name, args) => {
        dispatched.push({ name, args })
        return { ok: true }
      },
      llmGenerate: async () => {
        callIdx += 1
        if (callIdx === 1) {
          return {
            text: JSON.stringify({
              thought: "write file first",
              tool_calls: [{ name: "write", args: { filePath: "src/a.ts", content: "hi" } }],
            }),
            usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, costUsd: 0.01 },
          }
        }
        return {
          text: JSON.stringify({
            thought: "finished",
            final_response: "[done] implemented src/a.ts",
          }),
          usage: { inputTokens: 80, outputTokens: 10, cacheReadTokens: 80, costUsd: 0.005 },
        }
      },
    })

    const engine = manager.getEngine("s1")
    const models = await engine.listModels()
    expect(models[0].id).toBe("model-a")

    const batch = engine.spawnBatch({
      name: "dev",
      brief: "Build module",
      tasks: ["src/a.ts", "src/b.ts"],
    })
    expect(batch.map((m) => m.name)).toEqual(["dev-1", "dev-2"])

    await engine.join(["dev-1", "dev-2"], 3000)
    expect(dispatched.some((d) => d.name === "write")).toBe(true)

    const snap = engine.board.getSnapshotData()
    expect(snap.totals.inputTokens).toBeGreaterThan(0)
    expect(snap.totals.cacheHitRate).toBeGreaterThan(0)
    expect(snap.messages.some((m) => m.text.includes("[done]"))).toBe(true)

    await manager.shutdownAll()
  })

  test("supports 0-token swarm_wait + @mention wake, live swapModel, and 429 pause recovery", async () => {
    let step = 0
    let saw429 = false
    let sawWakePrompt = false

    const manager = new SwarmManager({
      dataDir: tmpDir,
      workspaceRoot: tmpDir,
      defaultModel: "model-1",
      llmGenerate: async (prompt, opts) => {
        step += 1
        if (step === 1) {
          throw new Error("429 Too Many Requests: quota exceeded")
        }
        if (step === 2) {
          saw429 = true
          return {
            text: JSON.stringify({
              thought: "go to sleep until mentioned",
              tool_calls: [{ name: "swarm_wait", args: {} }],
            }),
          }
        }
        if (prompt.includes("wake up now")) {
          sawWakePrompt = true
        }
        return {
          text: JSON.stringify({
            thought: `running on ${opts.model}`,
            final_response: `woke on ${opts.model}`,
          }),
        }
      },
    })

    const engine = manager.getEngine("s2")
    engine.spawnWorker({ name: "sleeper", brief: "Wait and wake", retryPauseMs: 25 })

    // Wait for worker to hit 429, resume, and enter swarm_wait (waiting)
    await engine.join(["sleeper"], 3000)
    expect(saw429).toBe(true)
    expect(engine.board.getMember("sleeper")?.status).toBe("waiting")

    // Live swap model while waiting
    const swapped = engine.swapModel("sleeper", "model-2", "anthropic")
    expect(swapped.model).toBe("model-2")

    // @mention wakes the waiting worker at 0 tokens
    engine.board.postMessage("coordinator", "@sleeper wake up now")
    await new Promise((r) => setTimeout(r, 80))
    await engine.join(["sleeper"], 3000)

    expect(sawWakePrompt).toBe(true)
    expect(engine.board.readMessages().some((m) => m.text.includes("woke on model-2"))).toBe(true)

    await manager.shutdownAll()
  })
})

describe("monitor.ts", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = makeTempDir("swarm-monitor-")
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  test("detects deadlock, quota-freeze, and 5-min Cache TTL [ttl-warning]", () => {
    const board = new SwarmBoard("mon", { dataDir: tmpDir })
    let fakeNow = 1_000_000

    board.upsertMember({ name: "w1", role: "worker", status: "queued" })
    const m1 = board.getMember("w1")!
    m1.lastActivityAt = fakeNow

    const monitor = new SwarmMonitor(board, {
      ttlWarningMs: 270_000,
      now: () => fakeNow,
    })

    // Deadlock when queued worker exists and 0 working
    const res1 = monitor.runCheckOnce()
    expect(res1.deadlocked).toBe(true)
    expect(res1.ttlWarnings).toEqual([])
    expect(board.readMessages().some((m) => m.text.includes("[deadlock]"))).toBe(true)

    // Advance clock past 270s -> [ttl-warning]
    fakeNow += 280_000
    const res2 = monitor.runCheckOnce()
    expect(res2.ttlWarnings).toEqual(["w1"])
    expect(board.readMessages().some((m) => m.text.includes("[ttl-warning]"))).toBe(true)

    // Quota freeze when worker is paused
    board.updateMember("w1", { status: "paused" })
    const res3 = monitor.runCheckOnce()
    expect(res3.quotaFrozen).toBe(true)
    expect(board.readMessages().some((m) => m.text.includes("[quota-freeze]"))).toBe(true)
  })
})

describe("src/index.ts & src/rpc.ts", () => {
  test("SwarmRpc contract and plugin setup(ctx) registration smoke test", async () => {
    expect(SwarmRpc.id).toBe("swarm")
    expect(Object.keys(SwarmRpc.methods)).toEqual([
      "snapshot",
      "dm",
      "model",
      "land",
      "channel",
      "kill",
      "models",
      "swarms",
    ])

    const tmpDir = makeTempDir("swarm-plugin-")
    try {
      const registeredTools = new Map<string, any>()
      const hooks = new Map<string, Function>()
      const commands = new Map<string, any>()
      const skills = new Map<string, any>()
      let registeredRpc: any
      const emittedEvents: Array<{ event: string; payload: unknown }> = []

      const mockCtx = {
        location: { directory: tmpDir },
        options: { dataDir: tmpDir },
        rpc: {
          register: async (def: any, handlers: any) => {
            registeredRpc = { def, handlers }
            return {
              events: {
                emit: async (event: string, payload: unknown) => {
                  emittedEvents.push({ event, payload })
                },
              },
            }
          },
        },
        tool: {
          transform: async (fn: (editor: any) => void) => {
            fn({
              add: (t: any) => registeredTools.set(t.name, t),
            })
          },
          hook: async (name: string, cb: Function) => {
            hooks.set(name, cb)
          },
        },
        command: {
          transform: async (fn: (editor: any) => void) => {
            fn({
              add: (c: any) => commands.set(c.name, c),
            })
          },
        },
        skill: {
          transform: async (fn: (editor: any) => void) => {
            fn({
              get: (id: string) => skills.get(id),
              add: (s: any) => skills.set(s.id, s),
            })
          },
        },
        session: {
          synthetic: async () => {},
        },
        model: {
          list: async () => [{ id: "claude-sonnet", providerID: "anthropic", name: "Claude Sonnet" }],
        },
        experimental: {
          generate: {
            text: async () => ({
              text: JSON.stringify({ final_response: "ok" }),
            }),
          },
        },
      }

      const cleanup = await (swarmPlugin as any).setup(mockCtx)
      expect(typeof cleanup).toBe("function")
      expect(registeredRpc.def.id).toBe("swarm")
      expect([...registeredTools.keys()]).toEqual(["swarm", "post_message", "read_board", "swarm_wait"])
      expect(hooks.has("execute.before")).toBe(true)
      expect(commands.has("swarm")).toBe(true)
      expect(skills.size).toBeGreaterThanOrEqual(4)

      // Smoke-test RPC snapshot & dm
      const snapRes = await registeredRpc.handlers.snapshot({})
      expect(snapRes.changed).toBe(true)

      const dmRes = await registeredRpc.handlers.dm({ text: "hello swarm" }, { error: (c: string) => c })
      expect(dmRes.seq).toBe(1)

      // Smoke-test tool execution
      const statusOut = await registeredTools.get("swarm").execute({ action: "status" })
      expect(statusOut.content).toContain("Swarm")

      await cleanup()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
