# opencode_swarm

Independent multi-agent swarm engine, blackboard, TUI, and Desktop GUI plugin for **OpenCode v2.4.1+**.

## Features

- **Independent Worker Runtime (`src/engine/worker.ts`)**: Workers run their own ReAct loop via `ctx.experimental.generate.text` with clean-slate or `fork` context seeding, `spawnBatch` (`tasks` / `n`), `join`, live `swapModel`, `429` pause/resume, and usage/cache-hit telemetry.
- **0-Token Blackboard (`src/engine/board.ts`)**: Append-only `board.jsonl`, `@mention`, `@prefix`, `@all`, `@#channel`, Channel ACL (`create` / `subscribe` / `unsubscribe` / `archive`), `visibleUnread`, `swarm_wait`, and `view.html` snapshots.
- **Deterministic Wave Scheduler (`src/engine/wave-scheduler.ts`)**: AST-free dependency scanner separating high fan-in spine files (Wave 1) from parallel leaf tasks (Wave 2+).
- **File Quarantine & Git Worktrees (`src/engine/quarantine.ts`, `src/engine/worktree.ts`)**: Enforces `allowed_paths` via `execute.before` tool hook and manages isolated `git worktree` lifecycles with verifier & conflict gates on `land()`.
- **Monitor (`src/engine/monitor.ts`)**: Detects deadlocks, quota freezes, and 5-minute prompt cache TTL idle warnings (`[ttl-warning]`).
- **TUI & Desktop GUI (`src/tui.tsx`, `src/gui.tsx`)**: 3-panel OpenTUI `/swarm` board and 5-tab SolidJS Desktop panel backed by `SwarmRpc` (`src/rpc.ts`).
- **Bundled Skills (`skills/`)**: `swarm-coordinator`, `swarm-verifier`, `swarm-monitor`, `swarm-narrator`.

---

## Installation

### Linux / macOS / WSL2

#### Option 1: OpenCode CLI (Recommended)

```bash
opencode plugin add github:ezzarw/opencode_swarm
```

#### Option 2: `opencode.jsonc` Configuration

Add the plugin to `~/.config/opencode/opencode.jsonc` (global) or `.opencode/opencode.jsonc` (project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "github:ezzarw/opencode_swarm"
  ]
}
```

#### Option 3: Manual Local / Plugin Directory

Clone into `~/.config/opencode/plugins/opencode_swarm` (global) or `.opencode/plugins/opencode_swarm` (project):

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/ezzarw/opencode_swarm.git ~/.config/opencode/plugins/opencode_swarm
```

Or for project-local installation:

```bash
mkdir -p .opencode/plugins
git clone https://github.com/ezzarw/opencode_swarm.git .opencode/plugins/opencode_swarm
```

---

### Windows (Native PowerShell)

#### Option 1: OpenCode CLI (Recommended)

```powershell
opencode plugin add github:ezzarw/opencode_swarm
```

#### Option 2: Manual PowerShell Clone & Config (`%USERPROFILE%\.config\opencode\`)

```powershell
$PluginDir = "$env:USERPROFILE\.config\opencode\plugins"
New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
git clone https://github.com/ezzarw/opencode_swarm.git "$PluginDir\opencode_swarm"
```

Or reference it in `$env:USERPROFILE\.config\opencode\opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "github:ezzarw/opencode_swarm"
  ]
}
```

---

## Tools & Commands

- **Tools**: `swarm`, `post_message`, `read_board`, `swarm_wait`
- **Slash Command**: `/swarm` (opens the 3-panel Swarm Board in TUI or prints swarm summary in session)
- **Desktop GUI**: Command `Open Swarm Board` / Panel `Swarm Board`

## Testing

```bash
bun test
```
