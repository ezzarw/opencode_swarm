import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { SwarmRpc } from "./rpc.ts"
import { SwarmBoard, normalizeChannel, type BoardSnapshot } from "./engine/board.ts"
import { SwarmMonitor } from "./engine/monitor.ts"
import { checkToolQuarantine } from "./engine/quarantine.ts"
import { SwarmEngine, SwarmManager, type ModelInfo } from "./engine/worker.ts"

interface ParsedFrontmatter {
  data: Record<string, string | boolean>
  content: string
}

function parseSkillMarkdown(raw: string): ParsedFrontmatter {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { data: {}, content: raw.trim() }
  }
  const data: Record<string, string | boolean> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let val = line.slice(idx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (val === "true") data[key] = true
    else if (val === "false") data[key] = false
    else data[key] = val
  }
  return { data, content: match[2].trim() }
}

function parseModelRef(model?: string, provider?: string): { providerID: string; id: string } | undefined {
  if (!model) return undefined
  if (provider) return { providerID: provider, id: model }
  const slash = model.indexOf("/")
  if (slash > 0) {
    return {
      providerID: model.slice(0, slash),
      id: model.slice(slash + 1),
    }
  }
  return undefined
}

function formatSnapshotSummary(snap: BoardSnapshot): string {
  const members = Object.values(snap.members)
  const lines = [
    `Swarm "${snap.title}" (${snap.id}) — head #${snap.head}, ${members.length} member(s), cost $${snap.totals.costUsd.toFixed(4)}, cache hit ${(snap.totals.cacheHitRate * 100).toFixed(1)}%`,
  ]
  for (const m of members) {
    lines.push(
      `- ${m.name} [${m.role}] status=${m.status} wave=${m.wave ?? 1} model=${m.model ?? "default"} steps=${m.steps}${m.activity ? ` (${m.activity})` : ""}`,
    )
  }
  return lines.join("\n")
}

export default Plugin.define({
  id: "opencode.swarm",
  async setup(ctx) {
    const workspaceRoot =
      (ctx.location as { directory?: string; path?: string } | undefined)?.directory ??
      (ctx.location as { path?: string } | undefined)?.path ??
      process.cwd()

    const dataDir =
      typeof ctx.options?.dataDir === "string" && ctx.options.dataDir.trim()
        ? ctx.options.dataDir.trim()
        : undefined

    const requireVerifierOnLand = ctx.options?.requireVerifierOnLand === true

    const monitors = new Map<string, SwarmMonitor>()
    const wiredBoards = new Set<string>()
    let rpcHandle: Awaited<ReturnType<typeof ctx.rpc.register<typeof SwarmRpc>>> | undefined

    const manager = new SwarmManager({
      dataDir,
      workspaceRoot,
      requireVerifierOnLand,
      listModels: async (): Promise<ModelInfo[]> => {
        try {
          const list = await ctx.model.list()
          return list.map((m) => ({
            id: m.id,
            provider: m.providerID,
            name: m.name ?? m.id,
          }))
        } catch {
          return []
        }
      },
      llmGenerate: async (prompt, opts) => {
        const fullPrompt = opts.system ? `${opts.system}\n\n${prompt}` : prompt
        const modelRef = parseModelRef(opts.model, opts.provider)
        const result = await ctx.experimental.generate.text({
          prompt: fullPrompt,
          ...(modelRef ? { model: modelRef as any } : {}),
        })
        return { text: result.text }
      },
    })

    const getWiredEngine = (swarmId = "default"): SwarmEngine => {
      const engine = manager.getEngine(swarmId)
      if (!wiredBoards.has(swarmId)) {
        wiredBoards.add(swarmId)
        engine.board.onUpdate((reason) => {
          if (!rpcHandle) return
          const snap = engine.board.getSnapshotData()
          void rpcHandle.events
            .emit("updated", {
              swarmId: engine.board.id,
              etag: snap.etag,
              head: snap.head,
              reason,
            })
            .catch(() => {})
        })
        const monitor = new SwarmMonitor(engine.board)
        monitor.start()
        monitors.set(swarmId, monitor)
      }
      return engine
    }

    // 1. Register RPC
    rpcHandle = await ctx.rpc.register(SwarmRpc, {
      snapshot: async (input) => {
        const engine = getWiredEngine(input.swarmId ?? "default")
        return engine.board.snapshot(input.etag)
      },
      dm: async (input, context) => {
        if (!input.text || !input.text.trim()) {
          return context.error("invalid_input", { reason: "text is required" })
        }
        const engine = getWiredEngine(input.swarmId ?? "default")
        const target = input.to?.replace(/^@/, "").trim()
        const body = target && !input.text.includes(`@${target}`) ? `@${target} ${input.text.trim()}` : input.text.trim()
        const msg = engine.board.postMessage(input.from ?? "user", body, {
          channel: input.channel,
          kind: "dm",
        })
        return {
          seq: msg.seq,
          time: msg.time,
          channel: msg.channel,
        }
      },
      model: async (input, context) => {
        const engine = getWiredEngine(input.swarmId ?? "default")
        if (!engine.board.getMember(input.name)) {
          return context.error("not_found", { reason: `Unknown member: ${input.name}` })
        }
        const updated = engine.swapModel(input.name, input.model, input.provider)
        return {
          ok: true,
          name: updated.name,
          model: updated.model ?? input.model,
          provider: updated.provider,
        }
      },
      land: async (input, context) => {
        const engine = getWiredEngine(input.swarmId ?? "default")
        const res = engine.land(input.name, { verifierApproved: input.verifierApproved })
        if (!res.ok) {
          if (res.reason === "not_found") {
            return context.error("not_found", { reason: res.message ?? "Member or worktree not found" })
          }
          if (res.reason === "conflict") {
            return context.error("conflict", { reason: res.message ?? "Merge conflict" })
          }
          if (res.reason === "verifier_required") {
            return context.error("verifier_required", { reason: res.message ?? "Verifier approval required" })
          }
          return { ok: false, reason: res.message ?? res.reason }
        }
        return {
          ok: true,
          mergedBranch: res.mergedBranch,
        }
      },
      channel: async (input, context) => {
        const engine = getWiredEngine(input.swarmId ?? "default")
        const board = engine.board
        switch (input.action) {
          case "list":
            return { ok: true, channels: board.listChannels(true) }
          case "create": {
            if (!input.channel) {
              return context.error("invalid_input", { reason: "channel is required for create" })
            }
            board.createChannel(input.channel)
            return { ok: true, channels: board.listChannels(true) }
          }
          case "archive": {
            if (!input.channel) {
              return context.error("invalid_input", { reason: "channel is required for archive" })
            }
            board.archiveChannel(input.channel)
            return { ok: true, channels: board.listChannels(true) }
          }
          case "subscribe": {
            if (!input.channel || !input.member) {
              return context.error("invalid_input", { reason: "channel and member are required for subscribe" })
            }
            board.subscribeChannel(input.member, input.channel)
            return { ok: true, channels: board.listChannels(true) }
          }
          case "unsubscribe": {
            if (!input.channel || !input.member) {
              return context.error("invalid_input", { reason: "channel and member are required for unsubscribe" })
            }
            board.unsubscribeChannel(input.member, input.channel)
            return { ok: true, channels: board.listChannels(true) }
          }
          default:
            return context.error("invalid_input", { reason: `Unsupported channel action: ${String(input.action)}` })
        }
      },
      kill: async (input, context) => {
        const engine = getWiredEngine(input.swarmId ?? "default")
        if (!engine.board.getMember(input.name)) {
          return context.error("not_found", { reason: `Unknown member: ${input.name}` })
        }
        const res = engine.killWorker(input.name, { force: input.force })
        if (!res.ok) {
          return context.error("dirty_worktree", { reason: res.reason ?? "Worktree has uncommitted changes" })
        }
        return { ok: true, name: input.name }
      },
      models: async (input) => {
        const engine = getWiredEngine(input.swarmId ?? "default")
        const models = await engine.listModels()
        return { models }
      },
      swarms: async () => {
        const swarms = manager.listSwarms().map((s) => ({
          id: s.id,
          title: s.title,
          head: s.head,
          memberCount: s.memberCount,
        }))
        return { swarms }
      },
    })

    // 2. Register 4 Swarm Tools
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "swarm",
        description:
          "Manage the OpenCode swarm: status, models, add (with tasks/n/wave/depends_on/auto_waves), model, kill, land, channel, join, title.",
        options: { codemode: false },
        output: { type: "object", additionalProperties: true },
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["status", "models", "add", "model", "kill", "land", "channel", "join", "title"],
            },
            swarm_id: { type: "string" },
            name: { type: "string" },
            brief: { type: "string" },
            tasks: { type: "array", items: { type: "string" } },
            n: { type: "number" },
            wave: { type: "number" },
            depends_on: { type: "array", items: { type: "string" } },
            auto_waves: { type: "boolean" },
            role: { type: "string" },
            model: { type: "string" },
            provider: { type: "string" },
            allowed_paths: { type: "array", items: { type: "string" } },
            worktree: { type: "boolean" },
            channel: { type: "string" },
            force: { type: "boolean" },
            verifier_approved: { type: "boolean" },
            names: { type: "array", items: { type: "string" } },
            timeout_ms: { type: "number" },
            channel_action: { type: "string", enum: ["create", "archive", "subscribe", "unsubscribe", "list"] },
            member: { type: "string" },
            title: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: async (rawInput) => {
          const input = rawInput as Record<string, any>
          const engine = getWiredEngine(input.swarm_id ?? "default")
          const board = engine.board

          switch (input.action) {
            case "status": {
              const snap = board.getSnapshotData()
              return { output: snap, content: formatSnapshotSummary(snap) }
            }
            case "models": {
              const models = await engine.listModels()
              return { output: { models }, content: JSON.stringify(models, null, 2) }
            }
            case "add": {
              if (!input.name || !input.brief) {
                throw new Error("swarm add requires name and brief")
              }
              const spawned = engine.spawnBatch({
                name: input.name,
                brief: input.brief,
                tasks: input.tasks,
                n: input.n,
                role: input.role,
                model: input.model,
                provider: input.provider,
                allowedPaths: input.allowed_paths,
                worktree: input.worktree,
                channel: input.channel,
                wave: input.wave,
                dependsOn: input.depends_on,
                autoWaves: input.auto_waves,
              })
              return {
                output: { spawned },
                content: `Spawned ${spawned.length} worker(s): ${spawned.map((m) => `${m.name} (wave ${m.wave ?? 1})`).join(", ")}`,
              }
            }
            case "model": {
              if (!input.name || !input.model) {
                throw new Error("swarm model requires name and model")
              }
              const updated = engine.swapModel(input.name, input.model, input.provider)
              return {
                output: updated,
                content: `Switched ${updated.name} to model ${updated.model ?? input.model}`,
              }
            }
            case "kill": {
              if (!input.name) {
                throw new Error("swarm kill requires name")
              }
              const res = engine.killWorker(input.name, { force: input.force })
              if (!res.ok) throw new Error(res.reason ?? `Failed to kill ${input.name}`)
              return { output: res, content: `Killed worker ${input.name}` }
            }
            case "land": {
              if (!input.name) {
                throw new Error("swarm land requires name")
              }
              const res = engine.land(input.name, { verifierApproved: input.verifier_approved })
              if (!res.ok) throw new Error(res.message ?? res.reason ?? `Failed to land ${input.name}`)
              return {
                output: res,
                content: `Landed ${input.name}${res.mergedBranch ? ` (${res.mergedBranch})` : ""}`,
              }
            }
            case "channel": {
              const chAction = input.channel_action ?? "list"
              if (chAction === "list") {
                const channels = board.listChannels(true)
                return { output: { channels }, content: JSON.stringify(channels, null, 2) }
              }
              if (!input.channel) throw new Error("swarm channel requires channel name")
              if (chAction === "create") {
                const ch = board.createChannel(input.channel)
                return { output: ch, content: `Created channel ${ch.name}` }
              }
              if (chAction === "archive") {
                const ch = board.archiveChannel(input.channel)
                return { output: ch, content: `Archived channel ${normalizeChannel(input.channel)}` }
              }
              if (chAction === "subscribe") {
                if (!input.member) throw new Error("swarm channel subscribe requires member")
                const channels = board.subscribeChannel(input.member, input.channel)
                return { output: { channels }, content: `Subscribed ${input.member} to ${normalizeChannel(input.channel)}` }
              }
              if (chAction === "unsubscribe") {
                if (!input.member) throw new Error("swarm channel unsubscribe requires member")
                const channels = board.unsubscribeChannel(input.member, input.channel)
                return { output: { channels }, content: `Unsubscribed ${input.member} from ${normalizeChannel(input.channel)}` }
              }
              throw new Error(`Unknown channel_action: ${chAction}`)
            }
            case "join": {
              const names: string[] = Array.isArray(input.names)
                ? input.names
                : input.name
                  ? [input.name]
                  : []
              await engine.join(names, input.timeout_ms ?? 10_000)
              return { output: { joined: names }, content: `Joined: ${names.join(", ")}` }
            }
            case "title": {
              if (!input.title) throw new Error("swarm title requires title")
              board.setTitle(input.title)
              return { output: { title: input.title }, content: `Swarm title set to "${input.title}"` }
            }
            default:
              throw new Error(`Unknown swarm action: ${String(input.action)}`)
          }
        },
      })

      tools.add({
        name: "post_message",
        description: "Post a message to the swarm blackboard.",
        options: { codemode: false },
        output: { type: "object", additionalProperties: true },
        input: {
          type: "object",
          properties: {
            text: { type: "string" },
            channel: { type: "string" },
            swarm_id: { type: "string" },
            agent: { type: "string" },
            kind: { type: "string", enum: ["brief", "status", "result", "system", "dm", "alert"] },
          },
          required: ["text"],
          additionalProperties: false,
        },
        execute: async (rawInput) => {
          const input = rawInput as Record<string, any>
          const engine = getWiredEngine(input.swarm_id ?? "default")
          const msg = engine.board.postMessage(input.agent ?? "coordinator", input.text, {
            channel: input.channel,
            kind: input.kind,
          })
          return {
            output: msg,
            content: `Posted #${msg.seq} in ${msg.channel} as ${msg.agent}`,
          }
        },
      })

      tools.add({
        name: "read_board",
        description: "Read messages from the swarm blackboard.",
        options: { codemode: false },
        output: { type: "object", additionalProperties: true },
        input: {
          type: "object",
          properties: {
            since: { type: "number" },
            limit: { type: "number" },
            channel: { type: "string" },
            member: { type: "string" },
            swarm_id: { type: "string" },
          },
          additionalProperties: false,
        },
        execute: async (rawInput) => {
          const input = rawInput as Record<string, any>
          const engine = getWiredEngine(input.swarm_id ?? "default")
          const messages = engine.board.readMessages({
            since: input.since,
            limit: input.limit ?? 20,
            channel: input.channel,
            member: input.member,
          })
          return {
            output: { messages, head: engine.board.getHead() },
            content: JSON.stringify({ messages, head: engine.board.getHead() }, null, 2),
          }
        },
      })

      tools.add({
        name: "swarm_wait",
        description: "Sleep at 0 tokens until a matching message arrives on the swarm blackboard.",
        options: { codemode: false },
        output: { type: "object", additionalProperties: true },
        input: {
          type: "object",
          properties: {
            since: { type: "number" },
            mentions_only: { type: "boolean" },
            timeout: { type: "number" },
            swarm_id: { type: "string" },
            member: { type: "string" },
          },
          additionalProperties: false,
        },
        execute: async (rawInput, toolCtx) => {
          const input = rawInput as Record<string, any>
          const engine = getWiredEngine(input.swarm_id ?? "default")
          const memberName = input.member ?? "coordinator"
          const messages = await engine.board.waitForMessage(memberName, {
            since: input.since,
            mentionsOnly: input.mentions_only ?? true,
            timeoutMs: typeof input.timeout === "number" ? input.timeout * 1000 : undefined,
            signal: toolCtx.signal,
          })
          return {
            output: { messages, head: engine.board.getHead() },
            content: JSON.stringify({ messages, head: engine.board.getHead() }, null, 2),
          }
        },
      })
    })

    // 3. Register File Quarantine Hook
    await ctx.tool.hook("execute.before", (event) => {
      const board = getWiredEngine("default").board
      const member = board.getMember(event.agent)
      if (!member || member.status !== "working" || !member.allowedPaths?.length) {
        return
      }
      const args =
        event.input && typeof event.input === "object" ? (event.input as Record<string, unknown>) : {}
      const result = checkToolQuarantine(member.allowedPaths, event.tool, args, member.worktree ?? workspaceRoot)
      if (!result.allowed) {
        throw new Error(result.reason ?? `File quarantine blocked ${event.tool}`)
      }
    })

    // 4. Register /swarm Command
    await ctx.command.transform((editor) => {
      editor.add({
        name: "swarm",
        description: "Inspect or control the OpenCode swarm board",
        execute: async (input) => {
          const text = input.prompt.text.trim()
          const engine = getWiredEngine("default")
          const snap = engine.board.getSnapshotData()
          const summary = formatSnapshotSummary(snap)
          const body = text ? `${summary}\n\nCommand input: ${text}` : summary
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text: body,
          })
        },
      })
    })

    // 5. Register Bundled Skills from ../skills/*/SKILL.md
    const skillsDirUrl = new URL("../skills/", import.meta.url)
    const skillsDirPath = fileURLToPath(skillsDirUrl)
    const loadedSkills: Skill.Info[] = []
    try {
      const entries = await fs.readdir(skillsDirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillPath = path.join(skillsDirPath, entry.name, "SKILL.md")
        try {
          const raw = await fs.readFile(skillPath, "utf8")
          const parsed = parseSkillMarkdown(raw)
          const skillName = typeof parsed.data.name === "string" ? parsed.data.name : `swarm-${entry.name}`
          const description = typeof parsed.data.description === "string" ? parsed.data.description : undefined
          loadedSkills.push(
            Skill.Info.make({
              id: Skill.ID.make(skillName),
              name: Skill.Name.make(skillName),
              description,
              autoinvoke: parsed.data["disable-model-invocation"] !== true,
              path: Skill.Info.fields.path.make(skillPath),
              content: parsed.content,
            }),
          )
        } catch {
          // Skip missing or unreadable SKILL.md
        }
      }
    } catch {
      // Skills directory optional in test environments
    }

    if (loadedSkills.length > 0) {
      await ctx.skill.transform((editor) => {
        for (const skill of loadedSkills) {
          if (!editor.get(skill.id)) {
            editor.add(skill)
          }
        }
      })
    }

    // 6. Cleanup
    return async () => {
      for (const monitor of monitors.values()) {
        monitor.stop()
      }
      monitors.clear()
      await manager.shutdownAll()
    }
  },
})
