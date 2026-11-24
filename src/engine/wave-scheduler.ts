import * as fs from "node:fs"
import * as path from "node:path"

export interface WaveTask {
  name: string
  files?: string[]
  dependsOn?: string[]
  wave?: number
}

export interface DependencyAnalysis {
  /** Map of file -> files it imports */
  imports: Record<string, string[]>
  /** Map of file -> number of files that import it */
  fanIn: Record<string, number>
  /** High fan-in shared/spine files (Wave 1) */
  spineFiles: string[]
  /** Leaf files with low fan-in (Wave 2+) */
  leafFiles: string[]
}

export interface ScheduledWave {
  wave: number
  role: "spine" | "leaf" | "dependent"
  tasks: string[]
}

const IMPORT_PATTERNS = [
  /(?:import|export)\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\s+['"]([^'"]+)['"]/g,
]

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]

function resolveRelativeImport(fromFile: string, specifier: string, knownFiles: Set<string>, rootDir: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined
  const fromAbs = path.isAbsolute(fromFile) ? fromFile : path.resolve(rootDir, fromFile)
  const baseDir = path.dirname(fromAbs)
  const rawTarget = path.resolve(baseDir, specifier)

  // Strip .js/.jsx if TS source imports ESM .js extension
  const candidates: string[] = [rawTarget]
  if (rawTarget.endsWith(".js") || rawTarget.endsWith(".jsx")) {
    candidates.push(rawTarget.replace(/\.jsx?$/, ".ts"))
    candidates.push(rawTarget.replace(/\.jsx?$/, ".tsx"))
  }

  for (const cand of candidates) {
    for (const ext of EXTENSIONS) {
      const full = cand + ext
      const rel = path.relative(rootDir, full).replace(/\\/g, "/")
      if (knownFiles.has(rel) || knownFiles.has(full)) {
        return knownFiles.has(rel) ? rel : full
      }
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        return rel
      }
    }
    for (const idx of ["index.ts", "index.tsx", "index.js", "index.jsx"]) {
      const fullIdx = path.join(cand, idx)
      const relIdx = path.relative(rootDir, fullIdx).replace(/\\/g, "/")
      if (knownFiles.has(relIdx) || knownFiles.has(fullIdx)) {
        return knownFiles.has(relIdx) ? relIdx : fullIdx
      }
      if (fs.existsSync(fullIdx) && fs.statSync(fullIdx).isFile()) {
        return relIdx
      }
    }
  }
  return undefined
}

/**
 * Deterministic AST-free regex scanner for TS/JS imports. Zero LLM tokens.
 */
export function scanImports(content: string): string[] {
  const found = new Set<string>()
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) found.add(match[1])
    }
  }
  return [...found]
}

export function analyzeDependencies(
  files: string[],
  opts?: { rootDir?: string; spineThreshold?: number; fileContents?: Record<string, string> },
): DependencyAnalysis {
  const rootDir = opts?.rootDir ?? process.cwd()
  const spineThreshold = opts?.spineThreshold ?? 2
  const normalizedFiles = files.map((f) =>
    path.isAbsolute(f) ? path.relative(rootDir, f).replace(/\\/g, "/") : f.replace(/\\/g, "/"),
  )
  const knownFiles = new Set(normalizedFiles)

  const imports: Record<string, string[]> = {}
  const fanIn: Record<string, number> = {}
  for (const f of normalizedFiles) {
    imports[f] = []
    fanIn[f] = 0
  }

  for (const f of normalizedFiles) {
    const abs = path.isAbsolute(f) ? f : path.resolve(rootDir, f)
    let content = opts?.fileContents?.[f] ?? opts?.fileContents?.[abs]
    if (content === undefined && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      try {
        content = fs.readFileSync(abs, "utf8")
      } catch {
        content = ""
      }
    }
    if (!content) continue

    const specifiers = scanImports(content)
    const resolvedList: string[] = []
    for (const spec of specifiers) {
      const target = resolveRelativeImport(f, spec, knownFiles, rootDir)
      if (target && target !== f && !resolvedList.includes(target)) {
        resolvedList.push(target)
        fanIn[target] = (fanIn[target] ?? 0) + 1
      }
    }
    imports[f] = resolvedList
  }

  const spineFiles: string[] = []
  const leafFiles: string[] = []
  for (const f of normalizedFiles) {
    if ((fanIn[f] ?? 0) >= spineThreshold) {
      spineFiles.push(f)
    } else {
      leafFiles.push(f)
    }
  }

  return { imports, fanIn, spineFiles, leafFiles }
}

/**
 * Assigns tasks into deterministic execution waves:
 * - Wave 1: High fan-in spine files (or explicit `wave: 1`)
 * - Wave 2: Parallel leaf tasks (or tasks importing spine files)
 * - Wave 3+: Tasks with explicit `dependsOn` chains
 */
export function scheduleWaves(
  tasks: WaveTask[],
  opts?: { rootDir?: string; spineThreshold?: number; fileContents?: Record<string, string> },
): { waves: ScheduledWave[]; taskWave: Record<string, number>; analysis: DependencyAnalysis } {
  const allFiles = new Set<string>()
  for (const t of tasks) {
    for (const f of t.files ?? []) allFiles.add(f)
  }

  const analysis = analyzeDependencies([...allFiles], opts)
  const spineSet = new Set(analysis.spineFiles)
  const taskMap = new Map(tasks.map((t) => [t.name, t]))
  const taskWave: Record<string, number> = {}

  // Map file -> owning task
  const fileOwner = new Map<string, string>()
  const rootDir = opts?.rootDir ?? process.cwd()
  for (const t of tasks) {
    for (const f of t.files ?? []) {
      const norm = path.isAbsolute(f) ? path.relative(rootDir, f).replace(/\\/g, "/") : f.replace(/\\/g, "/")
      fileOwner.set(norm, t.name)
    }
  }

  const visiting = new Set<string>()
  const resolveWave = (name: string): number => {
    if (taskWave[name] !== undefined) return taskWave[name]
    const task = taskMap.get(name)
    if (!task) return 1
    if (task.wave !== undefined && task.wave >= 1) {
      taskWave[name] = task.wave
      return task.wave
    }
    if (visiting.has(name)) {
      return 1
    }
    visiting.add(name)

    const deps = new Set<string>(task.dependsOn ?? [])
    // Implicit dependency: if this task's files import a spine file owned by another task
    for (const f of task.files ?? []) {
      const norm = path.isAbsolute(f) ? path.relative(rootDir, f).replace(/\\/g, "/") : f.replace(/\\/g, "/")
      for (const imp of analysis.imports[norm] ?? []) {
        const owner = fileOwner.get(imp)
        if (owner && owner !== name && spineSet.has(imp)) {
          deps.add(owner)
        }
      }
    }

    let wave = 1
    if (deps.size > 0) {
      let maxDepWave = 0
      for (const dep of deps) {
        if (taskMap.has(dep)) {
          maxDepWave = Math.max(maxDepWave, resolveWave(dep))
        }
      }
      wave = maxDepWave + 1
    } else {
      const ownsSpine = (task.files ?? []).some((f) => {
        const norm = path.isAbsolute(f) ? path.relative(rootDir, f).replace(/\\/g, "/") : f.replace(/\\/g, "/")
        return spineSet.has(norm)
      })
      wave = ownsSpine || spineSet.size === 0 ? 1 : 2
    }

    visiting.delete(name)
    taskWave[name] = wave
    return wave
  }

  for (const t of tasks) {
    resolveWave(t.name)
  }

  const grouped = new Map<number, string[]>()
  for (const t of tasks) {
    const w = taskWave[t.name] ?? 1
    const arr = grouped.get(w) ?? []
    arr.push(t.name)
    grouped.set(w, arr)
  }

  const waves: ScheduledWave[] = [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wave, waveTasks]) => ({
      wave,
      role: wave === 1 ? "spine" : wave === 2 ? "leaf" : "dependent",
      tasks: waveTasks,
    }))

  return { waves, taskWave, analysis }
}
