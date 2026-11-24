import { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { BoardMessage, BoardSnapshot, MemberState } from "./engine/board.ts"
import { SwarmRpc, type RpcSwarmSummary } from "./rpc.ts"

type PanelFocus = "roster" | "feed" | "detail"

interface TuiSwarmState {
  swarmId: string
  swarms: RpcSwarmSummary[]
  snapshot: BoardSnapshot | null
  etag: string | undefined
  loading: boolean
  error: string | undefined
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(0)}%`
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function statusGlyph(status: MemberState["status"]): string {
  switch (status) {
    case "working":
      return "●"
    case "waiting":
      return "◎"
    case "paused":
      return "⏸"
    case "queued":
      return "◌"
    case "killed":
      return "✕"
    default:
      return "·"
  }
}

function parseDmInput(raw: string, fallbackMember?: string): { to?: string; text: string } {
  const trimmed = raw.trim()
  const match = trimmed.match(/^@([a-z0-9_-]+)\s+([\s\S]+)$/i)
  if (match) {
    return { to: match[1].toLowerCase(), text: trimmed }
  }
  if (fallbackMember) {
    return { to: fallbackMember, text: `@${fallbackMember} ${trimmed}` }
  }
  return { text: trimmed }
}

function SwarmBoardView(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const rpc = props.context.client.rpc(SwarmRpc)

  const [state, setState] = createStore<TuiSwarmState>({
    swarmId: "default",
    swarms: [],
    snapshot: null,
    etag: undefined,
    loading: true,
    error: undefined,
  })

  const [focus, setFocus] = createSignal<PanelFocus>("feed")
  const [channelFilter, setChannelFilter] = createSignal<string>("#all")
  const [rosterIndex, setRosterIndex] = createSignal(0)
  const [feedIndex, setFeedIndex] = createSignal(0)

  const membersList = createMemo<MemberState[]>(() => {
    const snap = state.snapshot
    if (!snap) return []
    return Object.values(snap.members).sort((a, b) => a.name.localeCompare(b.name))
  })

  const filteredMessages = createMemo<BoardMessage[]>(() => {
    const snap = state.snapshot
    if (!snap) return []
    const ch = channelFilter()
    if (ch === "#all") return snap.messages
    return snap.messages.filter((m) => m.channel === ch)
  })

  const selectedMember = createMemo<MemberState | undefined>(() => {
    const list = membersList()
    if (list.length === 0) return undefined
    const idx = Math.max(0, Math.min(rosterIndex(), list.length - 1))
    return list[idx]
  })

  const selectedMessage = createMemo<BoardMessage | undefined>(() => {
    const list = filteredMessages()
    if (list.length === 0) return undefined
    const idx = Math.max(0, Math.min(feedIndex(), list.length - 1))
    return list[idx]
  })

  let fetchTurn = 0

  async function refresh(targetSwarmId = state.swarmId, force = false) {
    const currentTurn = ++fetchTurn
    try {
      const [swarmsRes, snapRes] = await Promise.all([
        rpc.swarms({}),
        rpc.snapshot({ swarmId: targetSwarmId, etag: force ? undefined : state.etag }),
      ])
      if (currentTurn !== fetchTurn) return
      setState("swarms", reconcile(swarmsRes.swarms))
      if (snapRes.changed && snapRes.snapshot) {
        setState("snapshot", reconcile(snapRes.snapshot as unknown as BoardSnapshot))
        setState("etag", snapRes.etag)
        const msgs = (snapRes.snapshot as unknown as BoardSnapshot).messages ?? []
        if (msgs.length > 0 && feedIndex() === 0) {
          setFeedIndex(msgs.length - 1)
        }
      }
      setState("loading", false)
      setState("error", undefined)
    } catch (err) {
      if (currentTurn !== fetchTurn) return
      setState("loading", false)
      setState("error", err instanceof Error ? err.message : String(err))
    }
  }

  void refresh("default", true)

  onCleanup(
    rpc.events.on("updated", (event) => {
      if (event.data.swarmId === state.swarmId || state.swarms.length === 0) {
        void refresh(state.swarmId, false)
      } else {
        void rpc.swarms({}).then(
          (res) => setState("swarms", reconcile(res.swarms)),
          () => undefined,
        )
      }
    }),
  )

  onCleanup(
    props.context.data.on("server.connected", () => {
      void refresh(state.swarmId, true)
    }),
  )

  function statusColor(status: MemberState["status"]) {
    switch (status) {
      case "working":
        return theme.text.feedback.success.base
      case "waiting":
        return theme.text.action.primary.base
      case "paused":
        return theme.text.feedback.warning.base
      case "killed":
        return theme.text.feedback.error.base
      default:
        return theme.text.muted
    }
  }

  async function openSwarmSwitcher() {
    try {
      const res = await rpc.swarms({})
      setState("swarms", reconcile(res.swarms))
      const options = res.swarms.map((s) => ({
        title: s.title ? `${s.title} (${s.id})` : s.id,
        value: s.id,
        description: `head #${s.head} • ${s.memberCount} members`,
      }))
      if (options.length === 0) {
        props.context.ui.toast.show({ message: "No active swarms found.", variant: "info" })
        return
      }
      const picked = await props.context.ui.dialog.select({
        title: "Switch Swarm",
        current: state.swarmId,
        options,
      })
      if (picked && picked !== state.swarmId) {
        setState("swarmId", picked)
        setState("etag", undefined)
        setRosterIndex(0)
        setFeedIndex(0)
        await refresh(picked, true)
      }
    } catch (err) {
      props.context.ui.toast.show({
        message: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  async function openChannelFilter() {
    const channels = state.snapshot?.channels ?? []
    const options = [
      { title: "#all", value: "#all", description: "Show messages from all channels" },
      ...channels.map((ch) => ({
        title: ch.name,
        value: ch.name,
        description: ch.description ?? (ch.archived ? "archived" : "channel"),
      })),
    ]
    const picked = await props.context.ui.dialog.select({
      title: "Filter Channel",
      current: channelFilter(),
      options,
    })
    if (picked) {
      setChannelFilter(picked)
      setFeedIndex(Math.max(0, filteredMessages().length - 1))
    }
  }

  async function openDmPrompt() {
    const target = selectedMember()?.name
    const raw = await props.context.ui.dialog.prompt({
      title: "Send Swarm Message / DM",
      description: "Prefix with @worker <msg> to DM & wake a worker, or send to current channel.",
      placeholder: target ? `@${target} status check` : "@worker <message>",
      value: target ? `@${target} ` : "",
    })
    if (!raw || !raw.trim()) return
    const parsed = parseDmInput(raw, target)
    const ch = channelFilter() === "#all" ? "#general" : channelFilter()
    try {
      await rpc.dm({
        swarmId: state.swarmId,
        to: parsed.to,
        text: parsed.text,
        channel: ch,
        from: "coordinator",
      })
      props.context.ui.toast.show({
        message: parsed.to ? `Sent DM to @${parsed.to}` : `Posted to ${ch}`,
        variant: "success",
      })
      await refresh(state.swarmId, true)
    } catch (err) {
      props.context.ui.toast.show({
        message: err instanceof Error ? err.message : String(err),
        variant: "error",
      })
    }
  }

  function moveSelection(delta: number) {
    if (focus() === "roster") {
      const len = membersList().length
      if (len === 0) return
      setRosterIndex((prev) => Math.max(0, Math.min(len - 1, prev + delta)))
    } else if (focus() === "feed") {
      const len = filteredMessages().length
      if (len === 0) return
      setFeedIndex((prev) => Math.max(0, Math.min(len - 1, prev + delta)))
    }
  }

  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 50,
    commands: [
      {
        id: "swarm.board.tab",
        title: "Switch Panel",
        bind: "tab",
        run: () => {
          setFocus((cur) => (cur === "roster" ? "feed" : cur === "feed" ? "detail" : "roster"))
        },
      },
      {
        id: "swarm.board.down",
        title: "Next Item",
        bind: "j",
        run: () => moveSelection(1),
      },
      {
        id: "swarm.board.up",
        title: "Previous Item",
        bind: "k",
        run: () => moveSelection(-1),
      },
      {
        id: "swarm.board.arrow_down",
        title: "Next Item",
        bind: "down",
        run: () => moveSelection(1),
      },
      {
        id: "swarm.board.arrow_up",
        title: "Previous Item",
        bind: "up",
        run: () => moveSelection(-1),
      },
      {
        id: "swarm.board.switcher",
        title: "Switch Swarm",
        bind: "s",
        run: () => {
          void openSwarmSwitcher()
        },
      },
      {
        id: "swarm.board.channel",
        title: "Filter Channel",
        bind: "c",
        run: () => {
          void openChannelFilter()
        },
      },
      {
        id: "swarm.board.dm",
        title: "Send DM (@worker <msg>)",
        bind: "d",
        run: () => {
          void openDmPrompt()
        },
      },
      {
        id: "swarm.board.refresh",
        title: "Refresh Board",
        bind: "r",
        run: () => {
          void refresh(state.swarmId, true)
        },
      },
      {
        id: "swarm.board.close",
        title: "Close Swarm Board",
        bind: "escape",
        run: () => props.context.ui.router.navigate({ type: "home" }),
      },
    ],
  }))

  const totals = createMemo(() => state.snapshot?.totals)

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      backgroundColor={theme.background.base}
      flexDirection="column"
      padding={1}
      gap={1}
    >
      {/* Header Bar */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={theme.background.raised.base}
        paddingLeft={1}
        paddingRight={1}
        height={1}
        flexShrink={0}
      >
        <text fg={theme.text.action.primary.base}>
          SWARM BOARD [{state.snapshot?.title ?? state.swarmId}] #{state.snapshot?.head ?? 0} • {channelFilter()}
        </text>
        <Show when={totals()}>
          {(t) => (
            <text fg={theme.text.muted}>
              tok {formatTokens(t().inputTokens + t().outputTokens)} • hit {formatPct(t().cacheHitRate)} •{" "}
              {formatCost(t().costUsd)}
            </text>
          )}
        </Show>
      </box>

      <Show when={state.error}>
        {(err) => (
          <box backgroundColor={theme.background.raised.base} paddingLeft={1} height={1} flexShrink={0}>
            <text fg={theme.text.feedback.error.base}>Error: {err()}</text>
          </box>
        )}
      </Show>

      {/* 3-Panel Layout: Roster | Posts Feed | Message & Member Detail */}
      <box flexDirection="row" flexGrow={1} gap={1}>
        {/* Panel 1: Roster */}
        <box
          width="28%"
          flexDirection="column"
          border
          borderColor={focus() === "roster" ? theme.text.action.primary.base : theme.border.base}
          padding={1}
        >
          <text fg={focus() === "roster" ? theme.text.action.primary.base : theme.text.base}>
            Roster ({membersList().length})
          </text>
          <scrollbox flexGrow={1}>
            <Show
              when={membersList().length > 0}
              fallback={<text fg={theme.text.muted}>{state.loading ? "Loading..." : "No members"}</text>}
            >
              <For each={membersList()}>
                {(member, idx) => {
                  const isSelected = () => idx() === rosterIndex()
                  const cacheDenom = member.usage.inputTokens + member.usage.cacheReadTokens
                  const hit = cacheDenom > 0 ? member.usage.cacheReadTokens / cacheDenom : 0
                  return (
                    <box flexDirection="column" paddingTop={idx() === 0 ? 0 : 1}>
                      <text fg={isSelected() ? theme.text.formfield.selected : statusColor(member.status)}>
                        {isSelected() ? "› " : "  "}
                        {statusGlyph(member.status)} @{member.name} ({member.status})
                      </text>
                      <text fg={theme.text.muted}>
                        {"   "}
                        {member.model ?? "default"} • {formatTokens(member.usage.inputTokens + member.usage.outputTokens)}{" "}
                        • {formatPct(hit)} • {formatCost(member.usage.costUsd)}
                      </text>
                    </box>
                  )
                }}
              </For>
            </Show>
          </scrollbox>
        </box>

        {/* Panel 2: Posts Feed */}
        <box
          width="42%"
          flexDirection="column"
          border
          borderColor={focus() === "feed" ? theme.text.action.primary.base : theme.border.base}
          padding={1}
        >
          <text fg={focus() === "feed" ? theme.text.action.primary.base : theme.text.base}>
            Posts Feed ({filteredMessages().length})
          </text>
          <scrollbox flexGrow={1}>
            <Show
              when={filteredMessages().length > 0}
              fallback={<text fg={theme.text.muted}>{state.loading ? "Loading..." : "No posts yet"}</text>}
            >
              <For each={filteredMessages()}>
                {(msg, idx) => {
                  const isSelected = () => idx() === feedIndex()
                  const preview = msg.text.replace(/\s+/g, " ").slice(0, 96)
                  return (
                    <box flexDirection="column" paddingTop={idx() === 0 ? 0 : 1}>
                      <text fg={isSelected() ? theme.text.formfield.selected : theme.text.action.primary.base}>
                        {isSelected() ? "› " : "  "}#{msg.seq} @{msg.agent} [{msg.channel}]
                        {msg.kind ? ` (${msg.kind})` : ""}
                      </text>
                      <text fg={isSelected() ? theme.text.base : theme.text.muted}>
                        {"   "}
                        {preview}
                      </text>
                    </box>
                  )
                }}
              </For>
            </Show>
          </scrollbox>
        </box>

        {/* Panel 3: Message & Member Detail */}
        <box
          width="30%"
          flexDirection="column"
          border
          borderColor={focus() === "detail" ? theme.text.action.primary.base : theme.border.base}
          padding={1}
        >
          <text fg={focus() === "detail" ? theme.text.action.primary.base : theme.text.base}>Detail</text>
          <scrollbox flexGrow={1}>
            <Show when={selectedMessage()}>
              {(msg) => (
                <box flexDirection="column" gap={0}>
                  <text fg={theme.text.action.primary.base}>
                    Post #{msg().seq} by @{msg().agent}
                  </text>
                  <text fg={theme.text.muted}>
                    {msg().channel} • {msg().time}
                  </text>
                  <box height={1} />
                  <text fg={theme.text.base}>{msg().text}</text>
                </box>
              )}
            </Show>

            <Show when={selectedMember()}>
              {(member) => {
                const denom = member().usage.inputTokens + member().usage.cacheReadTokens
                const hit = denom > 0 ? member().usage.cacheReadTokens / denom : 0
                return (
                  <box flexDirection="column" paddingTop={1}>
                    <text fg={theme.text.action.primary.base}>
                      Member @{member().name} [{member().role}]
                    </text>
                    <text fg={statusColor(member().status)}>
                      Status: {member().status} • Steps: {member().steps}
                    </text>
                    <text fg={theme.text.muted}>Model: {member().model ?? "default"}</text>
                    <text fg={theme.text.muted}>Channels: {member().channels.join(", ")}</text>
                    <Show when={member().worktree}>
                      {(wt) => <text fg={theme.text.muted}>Worktree: {wt()}</text>}
                    </Show>
                    <Show when={member().activity}>
                      {(act) => <text fg={theme.text.base}>Activity: {act()}</text>}
                    </Show>
                    <text fg={theme.text.muted}>
                      Tokens: in {formatTokens(member().usage.inputTokens)} / out{" "}
                      {formatTokens(member().usage.outputTokens)} / cache {formatPct(hit)}
                    </text>
                    <text fg={theme.text.muted}>
                      Cost: {formatCost(member().usage.costUsd)} ({member().usage.calls} calls)
                    </text>
                  </box>
                )
              }}
            </Show>
          </scrollbox>
        </box>
      </box>

      {/* Footer Keybind Bar */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        backgroundColor={theme.background.raised.base}
        paddingLeft={1}
        paddingRight={1}
        height={1}
        flexShrink={0}
      >
        <text fg={theme.text.muted}>
          [Tab] Panel  [j/k] Navigate  [S] Switch Swarm  [C] Channel  [D] @worker DM  [R] Refresh  [Esc] Close
        </text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.swarm.tui",
  setup(context) {
    const unregisterRoute = context.ui.router.register({
      name: "swarm-board",
      render: () => <SwarmBoardView context={context} />,
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "swarm.open",
          title: "Open Swarm Board",
          description: "Open the multi-agent Swarm Board TUI",
          group: "Swarm",
          palette: true,
          slash: {
            name: "swarm",
            aliases: ["swarm-board"],
          },
          run: () => {
            context.ui.router.navigate({ type: "plugin", name: "swarm-board" })
          },
        },
      ],
    }))

    return () => {
      unregisterRoute()
    }
  },
})
