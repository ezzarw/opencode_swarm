import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface WorktreeInfo {
  name: string
  path: string
  branch: string
}

export interface WorktreeStatus {
  exists: boolean
  clean: boolean
  branch?: string
  modified: string[]
  untracked: string[]
}

export interface LandResult {
  ok: boolean
  reason?: "verifier_required" | "conflict" | "dirty_target" | "not_found" | "git_error"
  message?: string
  mergedBranch?: string
  conflicts?: string[]
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, stdout: stdout.trim(), stderr: "" }
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string }
    return {
      ok: false,
      stdout: String(e.stdout ?? "").trim(),
      stderr: String(e.stderr ?? e.message ?? "").trim(),
    }
  }
}

export function createWorktree(
  repoRoot: string,
  name: string,
  opts?: { baseBranch?: string; worktreeDir?: string },
): WorktreeInfo {
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-")
  const worktreePath = opts?.worktreeDir
    ? path.resolve(opts.worktreeDir)
    : path.join(repoRoot, ".opencode-swarm", "worktrees", safeName)
  const branch = `swarm/${safeName}`

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
  if (fs.existsSync(worktreePath)) {
    const status = getWorktreeStatus(worktreePath)
    return { name, path: worktreePath, branch: status.branch ?? branch }
  }

  const branchExists = runGit(repoRoot, ["rev-parse", "--verify", branch]).ok
  const args = branchExists
    ? ["worktree", "add", worktreePath, branch]
    : ["worktree", "add", "-b", branch, worktreePath, opts?.baseBranch ?? "HEAD"]

  const res = runGit(repoRoot, args)
  if (!res.ok) {
    throw new Error(`Failed to create git worktree for ${name}: ${res.stderr || res.stdout}`)
  }
  return { name, path: worktreePath, branch }
}

export function getWorktreeStatus(worktreePath: string): WorktreeStatus {
  if (!fs.existsSync(worktreePath)) {
    return { exists: false, clean: true, modified: [], untracked: [] }
  }
  const branchRes = runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
  const statusRes = runGit(worktreePath, ["status", "--porcelain"])
  if (!statusRes.ok) {
    return { exists: true, clean: true, branch: branchRes.stdout || undefined, modified: [], untracked: [] }
  }

  const modified: string[] = []
  const untracked: string[] = []
  for (const line of statusRes.stdout.split("\n")) {
    if (!line) continue
    const code = line.slice(0, 2)
    const file = line.slice(3).trim()
    if (code === "??") untracked.push(file)
    else modified.push(file)
  }

  return {
    exists: true,
    clean: modified.length === 0 && untracked.length === 0,
    branch: branchRes.stdout || undefined,
    modified,
    untracked,
  }
}

export function landWorktree(
  repoRoot: string,
  worktreePath: string,
  opts?: { requireVerifier?: boolean; verifierApproved?: boolean; targetBranch?: string },
): LandResult {
  if (!fs.existsSync(worktreePath)) {
    return { ok: false, reason: "not_found", message: `Worktree not found: ${worktreePath}` }
  }

  if (opts?.requireVerifier && !opts?.verifierApproved) {
    return {
      ok: false,
      reason: "verifier_required",
      message: "Landing blocked: verifier approval is required before merging",
    }
  }

  const wtStatus = getWorktreeStatus(worktreePath)
  const sourceBranch = wtStatus.branch
  if (!sourceBranch) {
    return { ok: false, reason: "git_error", message: "Could not determine worktree branch" }
  }

  // Commit any pending changes in worktree if dirty? No, require clean or auto-stage? Keep deterministic:
  // Check target repo is clean before merge
  const rootStatus = getWorktreeStatus(repoRoot)
  if (!rootStatus.clean) {
    return {
      ok: false,
      reason: "dirty_target",
      message: "Target repository has uncommitted changes",
    }
  }

  if (opts?.targetBranch) {
    const co = runGit(repoRoot, ["checkout", opts.targetBranch])
    if (!co.ok) {
      return { ok: false, reason: "git_error", message: co.stderr || co.stdout }
    }
  }

  // Dry-run conflict check using `git merge --no-commit --no-ff` then abort
  const dryRun = runGit(repoRoot, ["merge", "--no-commit", "--no-ff", sourceBranch])
  if (!dryRun.ok) {
    const diffConflicts = runGit(repoRoot, ["diff", "--name-only", "--diff-filter=U"])
    runGit(repoRoot, ["merge", "--abort"])
    return {
      ok: false,
      reason: "conflict",
      message: `Merge conflict landing ${sourceBranch}: ${dryRun.stderr || dryRun.stdout}`,
      conflicts: diffConflicts.stdout ? diffConflicts.stdout.split("\n") : [],
    }
  }

  // Abort dry-run if it staged changes without committing, then do real merge
  runGit(repoRoot, ["merge", "--abort"])
  const mergeRes = runGit(repoRoot, ["merge", "--no-ff", "-m", `Land ${sourceBranch}`, sourceBranch])
  if (!mergeRes.ok) {
    runGit(repoRoot, ["merge", "--abort"])
    return {
      ok: false,
      reason: "git_error",
      message: mergeRes.stderr || mergeRes.stdout,
    }
  }

  return { ok: true, mergedBranch: sourceBranch }
}

export function cleanupWorktree(
  repoRoot: string,
  worktreePath: string,
  opts?: { force?: boolean; deleteBranch?: boolean },
): { ok: boolean; reason?: string } {
  const status = getWorktreeStatus(worktreePath)
  if (!status.exists) {
    return { ok: true }
  }
  if (!status.clean && !opts?.force) {
    return {
      ok: false,
      reason: `Worktree ${worktreePath} has uncommitted changes (${status.modified.length} modified, ${status.untracked.length} untracked). Pass force=true to discard.`,
    }
  }

  const args = ["worktree", "remove"]
  if (opts?.force) args.push("--force")
  args.push(worktreePath)

  const res = runGit(repoRoot, args)
  if (!res.ok) {
    return { ok: false, reason: res.stderr || res.stdout }
  }

  if (opts?.deleteBranch && status.branch) {
    runGit(repoRoot, ["branch", opts.force ? "-D" : "-d", status.branch])
  }

  return { ok: true }
}
