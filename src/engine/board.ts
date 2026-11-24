import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as crypto from "node:crypto"

export type MemberRole = "coordinator" | "worker" | "verifier" | "monitor" | "narrator" | string
export type MemberStatus = "queued" | "working" | "waiting" | "paused" | "killed"

export interface UsageStats {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  calls: number
}

export interface MemberState {
  name: string
  role: MemberRole
  model?: string
  provider?: string
  status: MemberStatus
  wave?: number
  dependsOn?: string[]
  allowedPaths?: string[]
  worktree?: string
  branch?: string
  channels: string[]
  lastReadSeq: number
  steps: number
  activity?: string
  failure?: string
  createdAt: string
  updatedAt: string
  lastActivityAt: number
  usage: UsageStats
}

export interface ChannelInfo {
  name: string
  description?: string
  archived: boolean
  isPrivate: boolean
  createdAt: string
}

export interface BoardMessage {
  seq: number
  agent: string
  text: string
  time: string
  channel: string
  kind?: "brief" | "status" | "result" | "system" | "dm" | "alert"
  metadata?: Record<string, unknown>
}

export interface MembersFile {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  head: number
  channels: Record<string, ChannelInfo>
  members: Record<string, MemberState>
}

export interface BoardSnapshot {
  id: string
  title: string
  etag: string
  head: number
  createdAt: string
  updatedAt: string
  channels: ChannelInfo[]
  members: Record<string, MemberState>
  messages: BoardMessage[]
  totals: UsageStats & { cacheHitRate: number }
}

export interface SwarmSummary {
  id: string
  title: string
  head: number
  memberCount: number
  updatedAt: string
}

export interface WaitOptions {
  since?: number
  mentionsOnly?: boolean
  timeoutMs?: number
  signal?: AbortSignal
}

interface Waiter {
  member: string
  since: number
  mentionsOnly: boolean
  resolve: (messages: BoardMessage[]) => void
  timer?: ReturnType<typeof setTimeout>
  abortCleanup?: () => void
}

export function resolveDataDir(customDir?: string): string {
  if (customDir && customDir.trim()) return path.resolve(customDir)
  const envDir = process.env.OPENCODE_SWARM_DATA_DIR
  if (envDir && envDir.trim()) return path.resolve(envDir)
  return path.join(os.homedir(), ".config", "opencode", "plugin-data", "opencode_swarm")
}

export function normalizeChannel(channel?: string): string {
  const raw = (channel ?? "#general").trim().toLowerCase()
  if (!raw) return "#general"
  return raw.startsWith("#") ? raw : `#${raw}`
}

export interface ParsedMentions {
  names: string[]
  channels: string[]
  all: boolean
}

export function parseMentions(text: string): ParsedMentions {
  const names = new Set<string>()
  const channels = new Set<string>()
  let all = false

  // Match @#channel first
  const channelMatches = text.matchAll(/@#([a-z0-9_-]+)/gi)
  for (const m of channelMatches) {
    channels.add(`#${m[1].toLowerCase()}`)
  }

  // Match @name or @all (not preceded by word char, not @#channel)
  const nameMatches = text.matchAll(/(?:^|[^a-zA-Z0-9_])@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g)
  for (const m of nameMatches) {
    const token = m[1].toLowerCase()
    if (token === "all") {
      all = true
    } else {
      names.add(token)
    }
  }

  return {
    names: [...names],
    channels: [...channels],
    all,
  }
}

export function matchesMention(text: string, memberName: string, memberChannels: string[] = []): boolean {
  const target = memberName.toLowerCase()
  const parsed = parseMentions(text)
  if (parsed.all) return true
  for (const name of parsed.names) {
    if (name === target || target.startsWith(`${name}-`)) {
      return true
    }
  }
  for (const ch of parsed.channels) {
    if (memberChannels.includes(ch)) return true
  }
  return false
}

function emptyUsage(): UsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    calls: 0,
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export class SwarmBoard {
  readonly id: string
  readonly dataDir: string
  readonly swarmDir: string
  readonly boardFile: string
  readonly membersFile: string
  readonly viewJsonFile: string
  readonly viewHtmlFile: string
  readonly planFile: string

  private state: MembersFile
  private messagesCache: BoardMessage[] = []
  private waiters = new Set<Waiter>()
  private updateListeners = new Set<(reason: string) => void>()

  constructor(swarmId = "default", opts?: { dataDir?: string; title?: string }) {
    this.id = swarmId
    this.dataDir = resolveDataDir(opts?.dataDir)
    this.swarmDir = path.join(this.dataDir, "swarms", this.id)
    this.boardFile = path.join(this.swarmDir, "board.jsonl")
    this.membersFile = path.join(this.swarmDir, "members.json")
    this.viewJsonFile = path.join(this.swarmDir, "view.json")
    this.viewHtmlFile = path.join(this.swarmDir, "view.html")
    this.planFile = path.join(this.swarmDir, "plan.json")

    fs.mkdirSync(this.swarmDir, { recursive: true })
    this.state = this.loadOrInitMembers(opts?.title)
    this.messagesCache = this.loadMessagesFromDisk()
    if (this.messagesCache.length > 0) {
      const lastSeq = this.messagesCache[this.messagesCache.length - 1].seq
      if (lastSeq > this.state.head) {
        this.state.head = lastSeq
        this.saveMembers()
      }
    }
    this.persistViews()
  }

  private loadOrInitMembers(title?: string): MembersFile {
    if (fs.existsSync(this.membersFile)) {
      try {
        const raw = fs.readFileSync(this.membersFile, "utf8")
        const parsed = JSON.parse(raw) as MembersFile
        if (!parsed.channels) parsed.channels = {}
        if (!parsed.channels["#general"]) {
          parsed.channels["#general"] = {
            name: "#general",
            description: "Default swarm broadcast channel",
            archived: false,
            isPrivate: false,
            createdAt: parsed.createdAt || new Date().toISOString(),
          }
        }
        return parsed
      } catch {
        // Fall through to re-init if corrupted
      }
    }
    const now = new Date().toISOString()
    const initial: MembersFile = {
      id: this.id,
      title: title ?? `Swarm ${this.id}`,
      createdAt: now,
      updatedAt: now,
      head: 0,
      channels: {
        "#general": {
          name: "#general",
          description: "Default swarm broadcast channel",
          archived: false,
          isPrivate: false,
          createdAt: now,
        },
      },
      members: {},
    }
    fs.writeFileSync(this.membersFile, JSON.stringify(initial, null, 2), "utf8")
    return initial
  }

  private loadMessagesFromDisk(): BoardMessage[] {
    if (!fs.existsSync(this.boardFile)) return []
    const raw = fs.readFileSync(this.boardFile, "utf8")
    const out: BoardMessage[] = []
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as BoardMessage)
      } catch {
        // Ignore malformed trailing line
      }
    }
    return out
  }

  private saveMembers(): void {
    this.state.updatedAt = new Date().toISOString()
    fs.writeFileSync(this.membersFile, JSON.stringify(this.state, null, 2), "utf8")
  }

  onUpdate(listener: (reason: string) => void): () => void {
    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
    }
  }

  private emitUpdate(reason: string): void {
    this.persistViews()
    for (const listener of this.updateListeners) {
      try {
        listener(reason)
      } catch {
        // Listener errors should not break board mutations
      }
    }
  }

  setTitle(title: string): void {
    this.state.title = title
    this.saveMembers()
    this.emitUpdate("title")
  }

  getTitle(): string {
    return this.state.title
  }

  getHead(): number {
    return this.state.head
  }

  // --- Channel ACL ---

  createChannel(name: string, opts?: { description?: string; isPrivate?: boolean }): ChannelInfo {
    const ch = normalizeChannel(name)
    const existing = this.state.channels[ch]
    if (existing) {
      existing.archived = false
      if (opts?.description !== undefined) existing.description = opts.description
      if (opts?.isPrivate !== undefined) existing.isPrivate = opts.isPrivate
      this.saveMembers()
      this.emitUpdate(`channel:create:${ch}`)
      return existing
    }
    const info: ChannelInfo = {
      name: ch,
      description: opts?.description,
      archived: false,
      isPrivate: opts?.isPrivate ?? false,
      createdAt: new Date().toISOString(),
    }
    this.state.channels[ch] = info
    this.saveMembers()
    this.emitUpdate(`channel:create:${ch}`)
    return info
  }

  archiveChannel(name: string): ChannelInfo | undefined {
    const ch = normalizeChannel(name)
    if (ch === "#general") {
      throw new Error("Cannot archive #general")
    }
    const existing = this.state.channels[ch]
    if (!existing) return undefined
    existing.archived = true
    this.saveMembers()
    this.emitUpdate(`channel:archive:${ch}`)
    return existing
  }

  listChannels(includeArchived = false): ChannelInfo[] {
    return Object.values(this.state.channels).filter((c) => includeArchived || !c.archived)
  }

  subscribeChannel(memberName: string, channelName: string): string[] {
    const ch = normalizeChannel(channelName)
    if (!this.state.channels[ch]) {
      this.createChannel(ch)
    }
    const member = this.state.members[memberName]
    if (!member) {
      throw new Error(`Unknown member: ${memberName}`)
    }
    if (!member.channels.includes(ch)) {
      member.channels.push(ch)
      member.updatedAt = new Date().toISOString()
      this.saveMembers()
      this.emitUpdate(`channel:subscribe:${memberName}:${ch}`)
    }
    return [...member.channels]
  }

  unsubscribeChannel(memberName: string, channelName: string): string[] {
    const ch = normalizeChannel(channelName)
    const member = this.state.members[memberName]
    if (!member) {
      throw new Error(`Unknown member: ${memberName}`)
    }
    member.channels = member.channels.filter((c) => c !== ch)
    member.updatedAt = new Date().toISOString()
    this.saveMembers()
    this.emitUpdate(`channel:unsubscribe:${memberName}:${ch}`)
    return [...member.channels]
  }

  effectiveChannels(memberName: string): string[] {
    const member = this.state.members[memberName]
    const activeChannels = new Set(
      Object.values(this.state.channels)
        .filter((c) => !c.archived)
        .map((c) => c.name),
    )

    if (!member) {
      return activeChannels.has("#general") ? ["#general"] : []
    }

    if (member.role === "coordinator" || member.role === "monitor" || member.role === "narrator") {
      return [...activeChannels]
    }

    const visible = new Set<string>()
    for (const ch of member.channels) {
      const normalized = normalizeChannel(ch)
      if (activeChannels.has(normalized)) visible.add(normalized)
    }
    if (visible.size === 0 && activeChannels.has("#general")) {
      visible.add("#general")
    }
    return [...visible]
  }

  // --- Members & Telemetry ---

  upsertMember(input: {
    name: string
    role?: MemberRole
    model?: string
    provider?: string
    status?: MemberStatus
    wave?: number
    dependsOn?: string[]
    allowedPaths?: string[]
    worktree?: string
    branch?: string
    channels?: string[]
    activity?: string
  }): MemberState {
    const nowIso = new Date().toISOString()
    const nowMs = Date.now()
    const existing = this.state.members[input.name]
    const channels = input.channels?.map(normalizeChannel) ?? existing?.channels ?? ["#general"]
    for (const ch of channels) {
      if (!this.state.channels[ch]) {
        this.state.channels[ch] = {
          name: ch,
          archived: false,
          isPrivate: false,
          createdAt: nowIso,
        }
      }
    }

    const next: MemberState = existing
      ? {
          ...existing,
          role: input.role ?? existing.role,
          model: input.model ?? existing.model,
          provider: input.provider ?? existing.provider,
          status: input.status ?? existing.status,
          wave: input.wave ?? existing.wave,
          dependsOn: input.dependsOn ?? existing.dependsOn,
          allowedPaths: input.allowedPaths ?? existing.allowedPaths,
          worktree: input.worktree ?? existing.worktree,
          branch: input.branch ?? existing.branch,
          channels,
          activity: input.activity ?? existing.activity,
          updatedAt: nowIso,
          lastActivityAt: nowMs,
        }
      : {
          name: input.name,
          role: input.role ?? "worker",
          model: input.model,
          provider: input.provider,
          status: input.status ?? "waiting",
          wave: input.wave,
          dependsOn: input.dependsOn,
          allowedPaths: input.allowedPaths,
          worktree: input.worktree,
          branch: input.branch,
          channels,
          lastReadSeq: 0,
          steps: 0,
          activity: input.activity,
          createdAt: nowIso,
          updatedAt: nowIso,
          lastActivityAt: nowMs,
          usage: emptyUsage(),
        }

    this.state.members[input.name] = next
    this.saveMembers()
    this.emitUpdate(`member:${input.name}`)
    return next
  }

  getMember(name: string): MemberState | undefined {
    return this.state.members[name]
  }

  listMembers(): MemberState[] {
    return Object.values(this.state.members)
  }

  updateMember(name: string, patch: Partial<Omit<MemberState, "name" | "createdAt" | "usage">>): MemberState | undefined {
    const existing = this.state.members[name]
    if (!existing) return undefined
    Object.assign(existing, patch, {
      updatedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
    })
    this.saveMembers()
    this.emitUpdate(`member:update:${name}`)
    return existing
  }

  recordUsage(
    name: string,
    delta: Partial<UsageStats>,
  ): MemberState | undefined {
    const existing = this.state.members[name]
    if (!existing) return undefined
    existing.usage.inputTokens += delta.inputTokens ?? 0
    existing.usage.outputTokens += delta.outputTokens ?? 0
    existing.usage.cacheReadTokens += delta.cacheReadTokens ?? 0
    existing.usage.cacheWriteTokens += delta.cacheWriteTokens ?? 0
    existing.usage.costUsd += delta.costUsd ?? 0
    existing.usage.calls += delta.calls ?? 1
    existing.updatedAt = new Date().toISOString()
    existing.lastActivityAt = Date.now()
    this.saveMembers()
    this.emitUpdate(`usage:${name}`)
    return existing
  }

  // --- Messaging & 0-Token Wait ---

  postMessage(
    agent: string,
    text: string,
    opts?: { channel?: string; kind?: BoardMessage["kind"]; metadata?: Record<string, unknown> },
  ): BoardMessage {
    const channel = normalizeChannel(opts?.channel)
    if (!this.state.channels[channel]) {
      this.createChannel(channel)
    }

    const seq = this.state.head + 1
    const msg: BoardMessage = {
      seq,
      agent,
      text,
      time: new Date().toISOString(),
      channel,
      kind: opts?.kind,
      metadata: opts?.metadata,
    }

    fs.appendFileSync(this.boardFile, JSON.stringify(msg) + "\n", "utf8")
    this.messagesCache.push(msg)
    this.state.head = seq

    if (this.state.members[agent]) {
      this.state.members[agent].lastActivityAt = Date.now()
      this.state.members[agent].updatedAt = msg.time
    }

    this.saveMembers()
    this.emitUpdate(`post:${seq}`)
    this.notifyWaiters(msg)
    return msg
  }

  private isMessageVisible(msg: BoardMessage, memberName: string): boolean {
    const member = this.state.members[memberName]
    if (member && (member.role === "coordinator" || member.role === "monitor" || member.role === "narrator")) {
      return true
    }
    const channels = this.effectiveChannels(memberName)
    if (channels.includes(msg.channel)) return true
    if (matchesMention(msg.text, memberName, channels)) return true
    return false
  }

  visibleUnread(memberName: string, sinceSeq?: number): BoardMessage[] {
    const member = this.state.members[memberName]
    const since = sinceSeq ?? member?.lastReadSeq ?? 0
    const unread = this.messagesCache.filter(
      (msg) => msg.seq > since && this.isMessageVisible(msg, memberName),
    )
    if (member && unread.length > 0) {
      const maxSeq = unread[unread.length - 1].seq
      if (maxSeq > member.lastReadSeq) {
        member.lastReadSeq = maxSeq
        this.saveMembers()
      }
    }
    return unread
  }

  readMessages(opts?: { since?: number; limit?: number; channel?: string; member?: string }): BoardMessage[] {
    let msgs = this.messagesCache
    if (opts?.since !== undefined) {
      const since = opts.since
      msgs = msgs.filter((m) => m.seq > since)
    }
    if (opts?.channel) {
      const ch = normalizeChannel(opts.channel)
      msgs = msgs.filter((m) => m.channel === ch)
    }
    if (opts?.member) {
      const member = opts.member
      msgs = msgs.filter((m) => this.isMessageVisible(m, member))
    }
    if (opts?.limit && opts.limit > 0 && msgs.length > opts.limit) {
      return msgs.slice(opts.limit === undefined ? 0 : msgs.length - opts.limit)
    }
    return [...msgs]
  }

  private matchesWaiter(msg: BoardMessage, waiter: Waiter): boolean {
    if (msg.seq <= waiter.since) return false
    if (msg.agent === waiter.member) return false
    if (!this.isMessageVisible(msg, waiter.member)) return false
    if (!waiter.mentionsOnly) return true
    const channels = this.effectiveChannels(waiter.member)
    return matchesMention(msg.text, waiter.member, channels)
  }

  private notifyWaiters(msg: BoardMessage): void {
    for (const waiter of [...this.waiters]) {
      if (this.matchesWaiter(msg, waiter)) {
        this.cleanupWaiter(waiter)
        const matching = this.messagesCache.filter(
          (m) => m.seq > waiter.since && this.isMessageVisible(m, waiter.member),
        )
        waiter.resolve(matching)
      }
    }
  }

  private cleanupWaiter(waiter: Waiter): void {
    this.waiters.delete(waiter)
    if (waiter.timer) clearTimeout(waiter.timer)
    if (waiter.abortCleanup) waiter.abortCleanup()
  }

  /**
   * 0-token Promise-based sleep until a matching message arrives on the board.
   */
  waitForMessage(memberName: string, opts?: WaitOptions): Promise<BoardMessage[]> {
    const member = this.state.members[memberName]
    const since = opts?.since ?? member?.lastReadSeq ?? 0
    const mentionsOnly = opts?.mentionsOnly ?? true

    const immediate = this.messagesCache.filter((msg) => {
      if (msg.seq <= since) return false
      if (msg.agent === memberName) return false
      if (!this.isMessageVisible(msg, memberName)) return false
      if (!mentionsOnly) return true
      return matchesMention(msg.text, memberName, this.effectiveChannels(memberName))
    })

    if (immediate.length > 0) {
      return Promise.resolve(immediate)
    }

    if (opts?.signal?.aborted) {
      return Promise.resolve([])
    }

    return new Promise<BoardMessage[]>((resolve) => {
      const waiter: Waiter = {
        member: memberName,
        since,
        mentionsOnly,
        resolve,
      }

      if (opts?.timeoutMs && opts.timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          this.cleanupWaiter(waiter)
          resolve([])
        }, opts.timeoutMs)
      }

      if (opts?.signal) {
        const onAbort = () => {
          this.cleanupWaiter(waiter)
          resolve([])
        }
        opts.signal.addEventListener("abort", onAbort, { once: true })
        waiter.abortCleanup = () => opts.signal?.removeEventListener("abort", onAbort)
      }

      this.waiters.add(waiter)
    })
  }

  wakeMember(memberName: string): void {
    for (const waiter of [...this.waiters]) {
      if (waiter.member === memberName) {
        this.cleanupWaiter(waiter)
        waiter.resolve([])
      }
    }
  }

  // --- Plan & Views & ETag ---

  writePlan(plan: unknown): void {
    fs.writeFileSync(this.planFile, JSON.stringify(plan, null, 2), "utf8")
    this.emitUpdate("plan")
  }

  readPlan<T = unknown>(): T | undefined {
    if (!fs.existsSync(this.planFile)) return undefined
    try {
      return JSON.parse(fs.readFileSync(this.planFile, "utf8")) as T
    } catch {
      return undefined
    }
  }

  computeEtag(): string {
    const hash = crypto.createHash("sha1")
    hash.update(`${this.id}:${this.state.head}:${this.state.updatedAt}`)
    return hash.digest("hex").slice(0, 16)
  }

  computeTotals(): UsageStats & { cacheHitRate: number } {
    const totals = emptyUsage()
    for (const m of Object.values(this.state.members)) {
      totals.inputTokens += m.usage.inputTokens
      totals.outputTokens += m.usage.outputTokens
      totals.cacheReadTokens += m.usage.cacheReadTokens
      totals.cacheWriteTokens += m.usage.cacheWriteTokens
      totals.costUsd += m.usage.costUsd
      totals.calls += m.usage.calls
    }
    const denom = totals.inputTokens + totals.cacheReadTokens
    const cacheHitRate = denom > 0 ? totals.cacheReadTokens / denom : 0
    return { ...totals, cacheHitRate }
  }

  getSnapshotData(): BoardSnapshot {
    return {
      id: this.id,
      title: this.state.title,
      etag: this.computeEtag(),
      head: this.state.head,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      channels: Object.values(this.state.channels),
      members: this.state.members,
      messages: this.messagesCache,
      totals: this.computeTotals(),
    }
  }

  snapshot(etag?: string): { etag: string; changed: boolean; snapshot?: BoardSnapshot } {
    const current = this.computeEtag()
    if (etag && etag === current) {
      return { etag: current, changed: false }
    }
    return {
      etag: current,
      changed: true,
      snapshot: this.getSnapshotData(),
    }
  }

  private persistViews(): void {
    const snap = this.getSnapshotData()
    fs.writeFileSync(this.viewJsonFile, JSON.stringify(snap, null, 2), "utf8")
    fs.writeFileSync(this.viewHtmlFile, this.renderViewHtml(snap), "utf8")
  }

  renderViewHtml(snap = this.getSnapshotData()): string {
    const membersRows = Object.values(snap.members)
      .map(
        (m) =>
          `<tr><td><strong>${escapeHtml(m.name)}</strong></td><td>${escapeHtml(m.role)}</td><td><span class="badge status-${escapeHtml(m.status)}">${escapeHtml(m.status)}</span></td><td>${escapeHtml(m.model ?? "-")}</td><td>${m.usage.inputTokens + m.usage.outputTokens}</td><td>$${m.usage.costUsd.toFixed(4)}</td></tr>`,
      )
      .join("\n")

    const msgRows = snap.messages
      .slice(-100)
      .map(
        (msg) =>
          `<div class="msg"><span class="seq">#${msg.seq}</span> <span class="ch">${escapeHtml(msg.channel)}</span> <strong>${escapeHtml(msg.agent)}</strong>: <span class="body">${escapeHtml(msg.text)}</span></div>`,
      )
      .join("\n")

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(snap.title)} (${escapeHtml(snap.id)})</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f1117; color: #e5e7eb; margin: 16px; }
  h1 { font-size: 1.2rem; margin: 0 0 8px; }
  .meta { color: #9ca3af; font-size: 0.85rem; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 0.85rem; }
  th, td { border-bottom: 1px solid #1f2937; padding: 6px 8px; text-align: left; }
  .badge { padding: 2px 6px; border-radius: 4px; background: #1f2937; }
  .status-working { background: #065f46; color: #a7f3d0; }
  .status-waiting { background: #1e3a8a; color: #bfdbfe; }
  .status-paused { background: #78350f; color: #fde68a; }
  .status-killed { background: #7f1d1d; color: #fecaca; }
  .msg { padding: 6px 8px; border-bottom: 1px solid #1f2937; font-size: 0.85rem; white-space: pre-wrap; }
  .seq { color: #60a5fa; font-family: monospace; }
  .ch { color: #a78bfa; font-family: monospace; }
</style>
</head>
<body>
  <h1>${escapeHtml(snap.title)}</h1>
  <div class="meta">Swarm: ${escapeHtml(snap.id)} | Head: #${snap.head} | Cache Hit: ${(snap.totals.cacheHitRate * 100).toFixed(1)}% | Cost: $${snap.totals.costUsd.toFixed(4)}</div>
  <table>
    <thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Model</th><th>Tokens</th><th>Cost</th></tr></thead>
    <tbody>${membersRows}</tbody>
  </table>
  <div class="feed">${msgRows}</div>
</body>
</html>`
  }

  static listSwarms(customDir?: string): SwarmSummary[] {
    const swarmsRoot = path.join(resolveDataDir(customDir), "swarms")
    if (!fs.existsSync(swarmsRoot)) return []
    const entries = fs.readdirSync(swarmsRoot, { withFileTypes: true })
    const result: SwarmSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const membersPath = path.join(swarmsRoot, entry.name, "members.json")
      if (!fs.existsSync(membersPath)) continue
      try {
        const data = JSON.parse(fs.readFileSync(membersPath, "utf8")) as MembersFile
        result.push({
          id: data.id || entry.name,
          title: data.title || entry.name,
          head: data.head ?? 0,
          memberCount: Object.keys(data.members ?? {}).length,
          updatedAt: data.updatedAt || "",
        })
      } catch {
        // Skip unreadable swarm dir
      }
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}
