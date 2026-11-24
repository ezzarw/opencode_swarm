import * as path from "node:path"

export const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "apply_patch",
  "write_file",
  "edit_file",
  "patch",
  "str_replace",
  "delete_file",
])

export interface QuarantineCheckResult {
  allowed: boolean
  reason?: string
  blockedPath?: string
  checkedPaths: string[]
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(?:.+/)?")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
  return new RegExp(`^${escaped}$`)
}

function normalizeRel(targetPath: string, workspaceRoot: string): string {
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath)
  return path.relative(workspaceRoot, abs).replace(/\\/g, "/")
}

export function extractTargetPaths(toolName: string, args: Record<string, unknown>): string[] {
  const paths = new Set<string>()
  for (const key of ["filePath", "path", "file", "target", "targetPath"]) {
    const val = args[key]
    if (typeof val === "string" && val.trim()) {
      paths.add(val.trim())
    }
  }
  if (Array.isArray(args.files)) {
    for (const f of args.files) {
      if (typeof f === "string" && f.trim()) paths.add(f.trim())
    }
  }

  // Parse patch text for apply_patch / patch
  const patchText =
    typeof args.patch === "string"
      ? args.patch
      : typeof args.patchText === "string"
        ? args.patchText
        : typeof args.diff === "string"
          ? args.diff
          : undefined

  if (patchText && (toolName === "apply_patch" || toolName === "patch" || paths.size === 0)) {
    const patchHeaders = patchText.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/gm)
    for (const m of patchHeaders) {
      if (m[1]?.trim()) paths.add(m[1].trim())
    }
    const unifiedHeaders = patchText.matchAll(/^(?:---|\+\+\+)\s+[ab]\/(.+)$/gm)
    for (const m of unifiedHeaders) {
      if (m[1]?.trim() && m[1].trim() !== "/dev/null") paths.add(m[1].trim())
    }
  }

  return [...paths]
}

export function isPathAllowed(targetPath: string, allowedPaths: string[], workspaceRoot: string): boolean {
  const rel = normalizeRel(targetPath, workspaceRoot)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return false
  }

  for (const rawPattern of allowedPaths) {
    const pattern = rawPattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")
    if (!pattern) continue

    if (pattern.includes("*") || pattern.includes("?")) {
      if (globToRegex(pattern).test(rel)) return true
      continue
    }

    if (rel === pattern || rel.startsWith(`${pattern}/`)) {
      return true
    }
  }
  return false
}

/**
 * Enforces deterministic file quarantine for write/edit/apply_patch tools.
 * If `allowedPaths` is undefined or empty, no quarantine restriction applies.
 */
export function checkToolQuarantine(
  allowedPaths: string[] | undefined,
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot = process.cwd(),
): QuarantineCheckResult {
  if (!WRITE_TOOLS.has(toolName)) {
    return { allowed: true, checkedPaths: [] }
  }
  if (!allowedPaths || allowedPaths.length === 0) {
    return { allowed: true, checkedPaths: [] }
  }

  const targets = extractTargetPaths(toolName, args)
  if (targets.length === 0) {
    return {
      allowed: false,
      reason: `Quarantine blocked ${toolName}: could not determine target file path`,
      checkedPaths: [],
    }
  }

  for (const target of targets) {
    if (!isPathAllowed(target, allowedPaths, workspaceRoot)) {
      return {
        allowed: false,
        blockedPath: target,
        checkedPaths: targets,
        reason: `Quarantine violation: "${target}" is outside allowed_paths [${allowedPaths.join(", ")}]`,
      }
    }
  }

  return { allowed: true, checkedPaths: targets }
}
