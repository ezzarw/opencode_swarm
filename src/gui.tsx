import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Command, createKeyed, Panel, Plugin, type PanelTab } from "@opencode/plugin/gui"
import type { BoardMessage, BoardSnapshot, MemberState } from "./engine/board.ts"
import { SwarmRpc, type RpcModelInfo, type RpcSwarmSummary } from "./rpc.ts"

type BoardTabId = "overview" | "board" | "members" | "graph" | "raw"
type GraphMode = "hive" | "mentions"

interface MentionEdge {
  from: string
  to: string
  count: number
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function statusColorHex(status: MemberState["status"]): string {
  switch (status) {
    case "working":
      return "#22c55e"
    case "waiting":
      return "#3b82f6"
    case "paused":
      return "#f59e0b"
    case "queued":
      return "#94a3b8"
    case "killed":
      return "#ef4444"
    default:
      return "#64748b"
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function buildNarratorSrcDoc(snap: BoardSnapshot | null): string {
  if (!snap) {
    return "<html><body style='font-family:sans-serif;color:#888;padding:12px;'>No swarm snapshot loaded.</body></html>"
  }
  const narratorPosts = snap.messages
    .filter((m) => m.agent === "narrator" || m.agent === "coordinator" || m.kind === "result")
    .slice(-12)
    .reverse()
  const members = Object.values(snap.members)
  const working = members.filter((m) => m.status === "working").length
  const waiting = members.filter((m) => m.status === "waiting").length
  const paused = members.filter((m) => m.status === "paused").length
  const rows = narratorPosts
    .map(
      (m) =>
        `<div style="padding:8px 10px;border-bottom:1px solid #2a2a2e;">
          <div style="font-size:11px;color:#9ca3af;">#${m.seq} • <strong>@${escapeHtml(m.agent)}</strong> • ${escapeHtml(m.channel)}</div>
          <div style="font-size:12px;margin-top:4px;white-space:pre-wrap;">${escapeHtml(m.text)}</div>
        </div>`,
    )
    .join("")

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="margin:0;padding:12px;font-family:system-ui,-apple-system,sans-serif;background:#111114;color:#e5e7eb;">
  <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #2a2a2e;padding-bottom:8px;margin-bottom:8px;">
    <div>
      <div style="font-size:13px;font-weight:600;">${escapeHtml(snap.title || snap.id)}</div>
      <div style="font-size:11px;color:#9ca3af;">Head #${snap.head} • ${working} working • ${waiting} waiting • ${paused} paused</div>
    </div>
    <div style="font-size:11px;color:#34d399;">${formatCost(snap.totals.costUsd)} • ${formatPct(snap.totals.cacheHitRate)} cache hit</div>
  </div>
  ${rows || "<div style='color:#9ca3af;font-size:12px;'>Waiting for narrator or coordinator updates...</div>"}
</body>
</html>`
}

function extractMentionEdges(messages: readonly BoardMessage[], members: readonly string[]): MentionEdge[] {
  const known = new Set(members.map((m) => m.toLowerCase()))
  const counts = new Map<string, number>()

  for (const msg of messages) {
    const matches = msg.text.matchAll(/@([a-z0-9_-]+)/gi)
    for (const m of matches) {
      const target = m[1].toLowerCase()
      if (target === "all") {
        for (const member of known) {
          if (member !== msg.agent.toLowerCase()) {
            const key = `${msg.agent}->${member}`
            counts.set(key, (counts.get(key) ?? 0) + 1)
          }
        }
      } else if (known.has(target) && target !== msg.agent.toLowerCase()) {
        const key = `${msg.agent}->${target}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }

  return Array.from(counts.entries()).map(([key, count]) => {
    const [from, to] = key.split("->")
    return { from, to, count }
  })
}

function SwarmBoardPanel(props: { ctx: Plugin.Setup<typeof definition> extends (c: infer C) => unknown ? C : never }) {
  const ctx = props.ctx
  const [swarmId, setSwarmId] = createSignal("default")
  const [swarms, setSwarms] = createSignal<RpcSwarmSummary[]>([])
  const [models, setModels] = createSignal<RpcModelInfo[]>([])
  const [snapshot, setSnapshot] = createSignal<BoardSnapshot | null>(null)
  const [etag, setEtag] = createSignal<string | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [busy, setBusy] = createSignal(false)

  const [activeTab, setActiveTab] = createSignal<BoardTabId>("overview")
  const [channelFilter, setChannelFilter] = createSignal("#all")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [jumpSeq, setJumpSeq] = createSignal<number | undefined>(undefined)

  const [dmInputs, setDmInputs] = createSignal<Record<string, string>>({})
  const [modelInputs, setModelInputs] = createSignal<Record<string, string>>({})

  const [graphMode, setGraphMode] = createSignal<GraphMode>("hive")
  const [replaySeq, setReplaySeq] = createSignal<number | undefined>(undefined)
  const [playing, setPlaying] = createSignal(false)

  const currentClient = () => {
    const session = ctx.sessions.current()
    if (session) return ctx.servers.get(session.server.id)?.client ?? ctx.client
    return ctx.client
  }

  async function refresh(targetSwarmId: string, force = false) {
    const client = currentClient()
    const rpc = client.rpc(SwarmRpc)
    setBusy(true)
    try {
      const [swarmsRes, modelsRes, snapRes] = await Promise.all([
        rpc.swarms({}),
        rpc.models({ swarmId: targetSwarmId }),
        rpc.snapshot({ swarmId: targetSwarmId, etag: force ? undefined : etag() }),
      ])
      setSwarms(swarmsRes.swarms)
      setModels(modelsRes.models)
      if (snapRes.changed && snapRes.snapshot) {
        setSnapshot(snapRes.snapshot as unknown as BoardSnapshot)
        setEtag(snapRes.etag)
      }
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  createKeyed(
    () => swarmId(),
    (id) => {
      setEtag(undefined)
      void refresh(id, true)

      const client = currentClient()
      const rpc = client.rpc(SwarmRpc)
      const off = rpc.events.on("updated", (event) => {
        if (event.data.swarmId === id) {
          void refresh(id, false)
        } else {
          void rpc.swarms({}).then(
            (res) => setSwarms(res.swarms),
            () => undefined,
          )
        }
      })
      onCleanup(off)
    },
  )

  createKeyed(
    () => playing(),
    (isPlaying) => {
      if (!isPlaying) return
      const timer = setInterval(() => {
        const head = snapshot()?.head ?? 0
        if (head <= 0) {
          setPlaying(false)
          return
        }
        const cur = replaySeq() ?? 1
        if (cur >= head) {
          setPlaying(false)
          setReplaySeq(head)
        } else {
          setReplaySeq(cur + 1)
        }
      }, 650)
      onCleanup(() => clearInterval(timer))
    },
  )

  const membersList = createMemo<MemberState[]>(() => {
    const snap = snapshot()
    if (!snap) return []
    return Object.values(snap.members).sort((a, b) => a.name.localeCompare(b.name))
  })

  const filteredMessages = createMemo<BoardMessage[]>(() => {
    const snap = snapshot()
    if (!snap) return []
    const ch = channelFilter()
    const q = searchQuery().trim().toLowerCase()
    const targetSeq = jumpSeq()
    return snap.messages.filter((m) => {
      if (ch !== "#all" && m.channel !== ch) return false
      if (targetSeq !== undefined && m.seq !== targetSeq) return false
      if (q && !m.text.toLowerCase().includes(q) && !m.agent.toLowerCase().includes(q)) return false
      return true
    })
  })

  const replayMessages = createMemo<BoardMessage[]>(() => {
    const snap = snapshot()
    if (!snap) return []
    const limit = replaySeq() ?? snap.head
    return snap.messages.filter((m) => m.seq <= limit)
  })

  const mentionEdges = createMemo<MentionEdge[]>(() =>
    extractMentionEdges(
      replayMessages(),
      membersList().map((m) => m.name),
    ),
  )

  async function sendDm(target: string) {
    const text = (dmInputs()[target] ?? "").trim()
    if (!text) return
    try {
      await currentClient()
        .rpc(SwarmRpc)
        .dm({
          swarmId: swarmId(),
          to: target,
          text: text.startsWith(`@${target}`) ? text : `@${target} ${text}`,
          from: "coordinator",
        })
      setDmInputs((prev) => ({ ...prev, [target]: "" }))
      ctx.toast.show({ title: `Sent DM to @${target}`, variant: "success" })
      await refresh(swarmId(), true)
    } catch (err) {
      ctx.toast.show({
        title: "DM failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  async function swapModel(name: string) {
    const model = (modelInputs()[name] ?? "").trim()
    if (!model) return
    try {
      await currentClient().rpc(SwarmRpc).model({ swarmId: swarmId(), name, model })
      ctx.toast.show({ title: `Swapped @${name} to ${model}`, variant: "success" })
      await refresh(swarmId(), true)
    } catch (err) {
      ctx.toast.show({
        title: "Model swap failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  async function landWorker(name: string) {
    try {
      const res = await currentClient().rpc(SwarmRpc).land({
        swarmId: swarmId(),
        name,
        verifierApproved: true,
      })
      ctx.toast.show({
        title: res.ok ? `Landed @${name}` : `Land blocked for @${name}`,
        description: res.reason ?? res.mergedBranch,
        variant: res.ok ? "success" : "warning",
      })
      await refresh(swarmId(), true)
    } catch (err) {
      ctx.toast.show({
        title: "Land failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  async function killWorker(name: string) {
    try {
      await currentClient().rpc(SwarmRpc).kill({ swarmId: swarmId(), name })
      ctx.toast.show({ title: `Killed @${name}`, variant: "info" })
      await refresh(swarmId(), true)
    } catch (err) {
      ctx.toast.show({
        title: "Kill failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  const tabs: { id: BoardTabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "board", label: "Board" },
    { id: "members", label: "Members" },
    { id: "graph", label: "Graph" },
    { id: "raw", label: "Raw" },
  ]

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        padding: "12px",
        gap: "10px",
        "font-size": "12px",
        "box-sizing": "border-box",
      }}
    >
      {/* Top Bar */}
      <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center", gap: "8px" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
          <strong>Swarm Board</strong>
          <select
            value={swarmId()}
            onChange={(e) => setSwarmId(e.currentTarget.value)}
            style={{
              padding: "3px 6px",
              "border-radius": "4px",
              border: "1px solid var(--border-base, #333)",
              background: "transparent",
              color: "inherit",
            }}
          >
            <Show when={swarms().length > 0} fallback={<option value={swarmId()}>{swarmId()}</option>}>
              <For each={swarms()}>
                {(s) => (
                  <option value={s.id}>
                    {s.title ? `${s.title} (${s.id})` : s.id} [#{s.head}]
                  </option>
                )}
              </For>
            </Show>
          </select>
        </div>

        <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
          <Show when={busy()}>
            <ctx.ui.Loader size="small" />
          </Show>
          <ctx.ui.IconButton
            icon="outline-rotate-clockwise"
            label="Refresh"
            onClick={() => void refresh(swarmId(), true)}
          />
        </div>
      </div>

      {/* Tab Strip */}
      <div style={{ display: "flex", gap: "4px", "border-bottom": "1px solid var(--border-base, #333)", "padding-bottom": "6px" }}>
        <For each={tabs}>
          {(tab) => (
            <ctx.ui.Button
              variant={activeTab() === tab.id ? "contrast" : "ghost"}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </ctx.ui.Button>
          )}
        </For>
      </div>

      <Show when={error()}>
        {(err) => (
          <div style={{ padding: "8px", "border-radius": "6px", border: "1px solid #ef4444", color: "#ef4444" }}>
            {err()}
          </div>
        )}
      </Show>

      {/* Tab 1: Overview */}
      <Show when={activeTab() === "overview"}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "10px", flex: 1, "min-height": 0 }}>
          <Show when={snapshot()}>
            {(snap) => (
              <div style={{ display: "grid", "grid-template-columns": "repeat(4, 1fr)", gap: "8px" }}>
                <div style={{ padding: "8px", border: "1px solid var(--border-base, #333)", "border-radius": "6px" }}>
                  <div style={{ opacity: 0.7, "font-size": "11px" }}>Head Seq</div>
                  <div style={{ "font-size": "16px", "font-weight": 600 }}>#{snap().head}</div>
                </div>
                <div style={{ padding: "8px", border: "1px solid var(--border-base, #333)", "border-radius": "6px" }}>
                  <div style={{ opacity: 0.7, "font-size": "11px" }}>Members</div>
                  <div style={{ "font-size": "16px", "font-weight": 600 }}>{membersList().length}</div>
                </div>
                <div style={{ padding: "8px", border: "1px solid var(--border-base, #333)", "border-radius": "6px" }}>
                  <div style={{ opacity: 0.7, "font-size": "11px" }}>Tokens / Hit</div>
                  <div style={{ "font-size": "14px", "font-weight": 600 }}>
                    {formatTokens(snap().totals.inputTokens + snap().totals.outputTokens)} ({formatPct(snap().totals.cacheHitRate)})
                  </div>
                </div>
                <div style={{ padding: "8px", border: "1px solid var(--border-base, #333)", "border-radius": "6px" }}>
                  <div style={{ opacity: 0.7, "font-size": "11px" }}>Total Cost</div>
                  <div style={{ "font-size": "16px", "font-weight": 600 }}>{formatCost(snap().totals.costUsd)}</div>
                </div>
              </div>
            )}
          </Show>

          <div style={{ "font-weight": 600 }}>Narrator Live View (Sandboxed)</div>
          <iframe
            sandbox="allow-scripts"
            srcDoc={buildNarratorSrcDoc(snapshot())}
            style={{
              width: "100%",
              flex: 1,
              "min-height": "260px",
              border: "1px solid var(--border-base, #333)",
              "border-radius": "6px",
              background: "#111114",
            }}
          />
        </div>
      </Show>

      {/* Tab 2: Board */}
      <Show when={activeTab() === "board"}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px", flex: 1, "min-height": 0 }}>
          {/* Channel Tabs */}
          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
            <ctx.ui.Button
              variant={channelFilter() === "#all" ? "contrast" : "ghost"}
              onClick={() => setChannelFilter("#all")}
            >
              #all
            </ctx.ui.Button>
            <For each={snapshot()?.channels ?? []}>
              {(ch) => (
                <ctx.ui.Button
                  variant={channelFilter() === ch.name ? "contrast" : "ghost"}
                  onClick={() => setChannelFilter(ch.name)}
                >
                  {ch.name}
                </ctx.ui.Button>
              )}
            </For>
          </div>

          {/* Search & #seq Jump Pills */}
          <div style={{ display: "flex", gap: "6px", "align-items": "center" }}>
            <input
              type="text"
              placeholder="Filter posts by @agent or text..."
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
              style={{
                flex: 1,
                padding: "5px 8px",
                "border-radius": "4px",
                border: "1px solid var(--border-base, #333)",
                background: "transparent",
                color: "inherit",
              }}
            />
            <Show when={jumpSeq() !== undefined}>
              <ctx.ui.Button variant="ghost" onClick={() => setJumpSeq(undefined)}>
                Clear #{jumpSeq()}
              </ctx.ui.Button>
            </Show>
          </div>

          <div style={{ display: "flex", "flex-wrap": "wrap", gap: "4px" }}>
            <For each={(snapshot()?.messages ?? []).slice(-12)}>
              {(m) => (
                <button
                  type="button"
                  onClick={() => setJumpSeq((cur) => (cur === m.seq ? undefined : m.seq))}
                  style={{
                    padding: "2px 6px",
                    "font-size": "11px",
                    "border-radius": "999px",
                    border: "1px solid var(--border-base, #333)",
                    background: jumpSeq() === m.seq ? "#3b82f6" : "transparent",
                    color: jumpSeq() === m.seq ? "#fff" : "inherit",
                    cursor: "pointer",
                  }}
                >
                  #{m.seq}
                </button>
              )}
            </For>
          </div>

          {/* Posts Feed */}
          <div style={{ flex: 1, "overflow-y": "auto", display: "flex", "flex-direction": "column", gap: "6px" }}>
            <For each={filteredMessages()}>
              {(msg) => (
                <div
                  style={{
                    padding: "8px",
                    border: "1px solid var(--border-base, #333)",
                    "border-radius": "6px",
                  }}
                >
                  <div style={{ display: "flex", "justify-content": "space-between", opacity: 0.8, "font-size": "11px" }}>
                    <span>
                      <strong>#{msg.seq}</strong> @{msg.agent} • {msg.channel}
                      {msg.kind ? ` [${msg.kind}]` : ""}
                    </span>
                    <span>{msg.time}</span>
                  </div>
                  <div style={{ "margin-top": "4px", "white-space": "pre-wrap" }}>{msg.text}</div>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      {/* Tab 3: Members */}
      <Show when={activeTab() === "members"}>
        <div style={{ flex: 1, "overflow-y": "auto", display: "flex", "flex-direction": "column", gap: "8px" }}>
          <For each={membersList()}>
            {(member) => {
              const denom = member.usage.inputTokens + member.usage.cacheReadTokens
              const hit = denom > 0 ? member.usage.cacheReadTokens / denom : 0
              return (
                <div
                  style={{
                    padding: "10px",
                    border: "1px solid var(--border-base, #333)",
                    "border-radius": "6px",
                    display: "flex",
                    "flex-direction": "column",
                    gap: "6px",
                  }}
                >
                  <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                      <span
                        style={{
                          width: "8px",
                          height: "8px",
                          "border-radius": "999px",
                          background: statusColorHex(member.status),
                          display: "inline-block",
                        }}
                      />
                      <strong>@{member.name}</strong>
                      <span style={{ opacity: 0.7 }}>
                        ({member.role} • {member.status})
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: "6px", "font-size": "11px", opacity: 0.85 }}>
                      <span>{formatTokens(member.usage.inputTokens + member.usage.outputTokens)} tok</span>
                      <span>{formatPct(hit)} hit</span>
                      <span>{formatCost(member.usage.costUsd)}</span>
                    </div>
                  </div>

                  <div style={{ "font-size": "11px", opacity: 0.75 }}>
                    Model: {member.model ?? "default"} • Steps: {member.steps} • Channels: {member.channels.join(", ")}
                  </div>

                  {/* DM Input */}
                  <div style={{ display: "flex", gap: "4px" }}>
                    <input
                      type="text"
                      placeholder={`DM @${member.name}...`}
                      value={dmInputs()[member.name] ?? ""}
                      onInput={(e) => setDmInputs((prev) => ({ ...prev, [member.name]: e.currentTarget.value }))}
                      style={{
                        flex: 1,
                        padding: "4px 6px",
                        "border-radius": "4px",
                        border: "1px solid var(--border-base, #333)",
                        background: "transparent",
                        color: "inherit",
                      }}
                    />
                    <ctx.ui.Button onClick={() => void sendDm(member.name)}>DM</ctx.ui.Button>
                  </div>

                  {/* Model Swap + Land + Kill */}
                  <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
                    <input
                      type="text"
                      list={`swarm-models-${member.name}`}
                      placeholder={member.model ?? "model id..."}
                      value={modelInputs()[member.name] ?? ""}
                      onInput={(e) => setModelInputs((prev) => ({ ...prev, [member.name]: e.currentTarget.value }))}
                      style={{
                        flex: 1,
                        padding: "4px 6px",
                        "border-radius": "4px",
                        border: "1px solid var(--border-base, #333)",
                        background: "transparent",
                        color: "inherit",
                      }}
                    />
                    <datalist id={`swarm-models-${member.name}`}>
                      <For each={models()}>{(m) => <option value={m.id}>{m.name ?? m.id}</option>}</For>
                    </datalist>
                    <ctx.ui.Button variant="ghost" onClick={() => void swapModel(member.name)}>
                      Swap
                    </ctx.ui.Button>
                    <ctx.ui.Button variant="ghost" onClick={() => void landWorker(member.name)}>
                      Land
                    </ctx.ui.Button>
                    <ctx.ui.Button
                      variant="ghost"
                      disabled={member.status === "killed"}
                      onClick={() => void killWorker(member.name)}
                    >
                      Kill
                    </ctx.ui.Button>
                  </div>
                </div>
              )
            }}
          </For>
        </div>
      </Show>

      {/* Tab 4: Graph (Hive / Mentions + Timeline Replay) */}
      <Show when={activeTab() === "graph"}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px", flex: 1, "min-height": 0 }}>
          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
            <div style={{ display: "flex", gap: "4px" }}>
              <ctx.ui.Button
                variant={graphMode() === "hive" ? "contrast" : "ghost"}
                onClick={() => setGraphMode("hive")}
              >
                Hive
              </ctx.ui.Button>
              <ctx.ui.Button
                variant={graphMode() === "mentions" ? "contrast" : "ghost"}
                onClick={() => setGraphMode("mentions")}
              >
                Mentions
              </ctx.ui.Button>
            </div>

            <div style={{ display: "flex", gap: "4px", "align-items": "center" }}>
              <ctx.ui.Button
                variant="ghost"
                onClick={() => {
                  const cur = replaySeq() ?? snapshot()?.head ?? 0
                  setReplaySeq(Math.max(0, cur - 1))
                }}
              >
                -1
              </ctx.ui.Button>
              <ctx.ui.Button variant="ghost" onClick={() => setPlaying((p) => !p)}>
                {playing() ? "Pause" : "Play"}
              </ctx.ui.Button>
              <ctx.ui.Button
                variant="ghost"
                onClick={() => {
                  const head = snapshot()?.head ?? 0
                  const cur = replaySeq() ?? head
                  setReplaySeq(Math.min(head, cur + 1))
                }}
              >
                +1
              </ctx.ui.Button>
            </div>
          </div>

          {/* Replay Scrubber */}
          <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
            <input
              type="range"
              min={0}
              max={snapshot()?.head ?? 0}
              value={replaySeq() ?? snapshot()?.head ?? 0}
              onInput={(e) => setReplaySeq(Number(e.currentTarget.value))}
              style={{ flex: 1 }}
            />
            <span style={{ "font-size": "11px", opacity: 0.8 }}>
              Seq #{replaySeq() ?? snapshot()?.head ?? 0} / #{snapshot()?.head ?? 0}
            </span>
          </div>

          <svg
            viewBox="0 0 420 260"
            style={{
              width: "100%",
              flex: 1,
              "min-height": "220px",
              border: "1px solid var(--border-base, #333)",
              "border-radius": "6px",
              background: "#0f1115",
            }}
          >
            <Show when={graphMode() === "hive"}>
              <For each={membersList()}>
                {(member, idx) => {
                  const col = idx() % 4
                  const row = Math.floor(idx() / 4)
                  const cx = 65 + col * 95 + (row % 2 === 1 ? 45 : 0)
                  const cy = 65 + row * 85
                  const r = 34
                  const pts = Array.from({ length: 6 }, (_, i) => {
                    const angle = (Math.PI / 3) * i - Math.PI / 6
                    return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`
                  }).join(" ")
                  return (
                    <g>
                      <polygon
                        points={pts}
                        fill={statusColorHex(member.status)}
                        fill-opacity="0.22"
                        stroke={statusColorHex(member.status)}
                        stroke-width="2"
                      />
                      <text x={cx} y={cy - 2} text-anchor="middle" fill="#e5e7eb" font-size="10" font-weight="bold">
                        @{member.name}
                      </text>
                      <text x={cx} y={cy + 12} text-anchor="middle" fill="#9ca3af" font-size="9">
                        {member.status}
                      </text>
                    </g>
                  )
                }}
              </For>
            </Show>

            <Show when={graphMode() === "mentions"}>
              {(() => {
                const list = membersList()
                const positions = new Map<string, { x: number; y: number }>()
                list.forEach((m, idx) => {
                  const angle = (2 * Math.PI * idx) / Math.max(1, list.length) - Math.PI / 2
                  positions.set(m.name.toLowerCase(), {
                    x: 210 + 115 * Math.cos(angle),
                    y: 130 + 85 * Math.sin(angle),
                  })
                })
                return (
                  <>
                    <For each={mentionEdges()}>
                      {(edge) => {
                        const from = positions.get(edge.from.toLowerCase())
                        const to = positions.get(edge.to.toLowerCase())
                        if (!from || !to) return null
                        return (
                          <g>
                            <line
                              x1={from.x}
                              y1={from.y}
                              x2={to.x}
                              y2={to.y}
                              stroke="#60a5fa"
                              stroke-opacity="0.55"
                              stroke-width={Math.min(5, 1 + edge.count * 0.6)}
                            />
                          </g>
                        )
                      }}
                    </For>
                    <For each={list}>
                      {(member) => {
                        const pos = positions.get(member.name.toLowerCase()) ?? { x: 210, y: 130 }
                        return (
                          <g>
                            <circle
                              cx={pos.x}
                              cy={pos.y}
                              r="18"
                              fill="#18181b"
                              stroke={statusColorHex(member.status)}
                              stroke-width="2"
                            />
                            <text x={pos.x} y={pos.y + 3} text-anchor="middle" fill="#e5e7eb" font-size="9">
                              {member.name}
                            </text>
                          </g>
                        )
                      }}
                    </For>
                  </>
                )
              })()}
            </Show>
          </svg>
        </div>
      </Show>

      {/* Tab 5: Raw */}
      <Show when={activeTab() === "raw"}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "8px", flex: 1, "min-height": 0 }}>
          <div style={{ display: "flex", "justify-content": "space-between", "align-items": "center" }}>
            <span style={{ opacity: 0.8 }}>Snapshot JSON</span>
            <ctx.ui.Button
              variant="ghost"
              onClick={() => {
                void ctx.system.copy(JSON.stringify(snapshot(), null, 2))
                ctx.toast.show({ title: "Copied JSON snapshot", variant: "success" })
              }}
            >
              Copy JSON
            </ctx.ui.Button>
          </div>
          <pre
            style={{
              flex: 1,
              margin: 0,
              padding: "10px",
              overflow: "auto",
              "border-radius": "6px",
              border: "1px solid var(--border-base, #333)",
              background: "#0d0f12",
              color: "#d1d5db",
              "font-size": "11px",
            }}
          >
            {JSON.stringify(snapshot(), null, 2)}
          </pre>
        </div>
      </Show>
    </div>
  )
}

const definition = Plugin.define({
  i18n: {
    en: {
      "command.open": "Open Swarm Board",
      "panel.title": "Swarm Board",
    },
  },
  setup(ctx) {
    const swarmTab: PanelTab = {
      id: "swarm-board",
      title: ctx.t("panel.title"),
      pinned: true,
      closable: false,
    }

    ctx.add(Command, () => ({
      id: "open",
      title: ctx.t("command.open"),
      keywords: "swarm board agents",
      group: "Swarm",
      run: () => {
        const session = ctx.sessions.current()
        if (!session) return
        ctx.layout.open(`${ctx.id}:swarm-board`, session)
      },
    }))

    ctx.add(Panel, {
      id: "swarm-board",
      region: "side",
      wide: true,
      list: () => [swarmTab],
      render: () => <SwarmBoardPanel ctx={ctx} />,
    })
  },
})

export default definition
