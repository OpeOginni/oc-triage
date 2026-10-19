// Find every OpenCode binary on the machine, and fetch a private one for the triage
// session when none of them is a working V2 CLI.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { cliInstallLocations, desktopBundledCli, type Paths } from "./paths"

export type Version = { ok: true; version: string } | { ok: false; error: string }
export type Opencode = { file: string; source: string } & Version

const isWindows = process.platform === "win32"

function onPath() {
  try {
    const out = execFileSync(isWindows ? "where" : "which", isWindows ? ["opencode"] : ["-a", "opencode"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return out.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

// `--version` can hang on a broken install (issue #56775), so it gets a hard timeout.
export function versionOf(file: string): Version {
  const result = spawnSync(file, ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true })
  if (result.error) return { ok: false, error: (result.error as NodeJS.ErrnoException).code || result.error.message }
  if (result.status !== 0) return { ok: false, error: `exit ${result.status}: ${(result.stderr || "").trim().slice(0, 200)}` }
  const match = /(\d+\.\d+\.\d+[^\s]*)/.exec(result.stdout)
  return match ? { ok: true, version: match[1] } : { ok: false, error: `unexpected output: ${result.stdout.trim().slice(0, 80)}` }
}

function stagedDesktopCopies(desktop: Paths["desktop"]) {
  return desktop.flatMap(({ userData }) => {
    const dir = path.join(userData, "cli")
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).map((entry) => path.join(dir, entry, isWindows ? "opencode-cli.exe" : "opencode-cli"))
  })
}

export function findOpencodes(paths: Paths): Opencode[] {
  const found = new Map<string, { file: string; source: string }>()
  const add = (file: string, source: string) => {
    if (!fs.existsSync(file) || found.has(fs.realpathSync(file))) return
    found.set(fs.realpathSync(file), { file, source })
  }
  for (const file of onPath()) add(file, "on PATH")
  for (const { file, method } of cliInstallLocations()) add(file, method)
  for (const file of desktopBundledCli()) add(file, "bundled inside the desktop app")
  for (const file of stagedDesktopCopies(paths.desktop)) add(file, "desktop app's staged copy")
  return [...found.values()].map((item) => ({ ...item, ...versionOf(item.file) }))
}

export const isV2 = (item: Opencode) => item.ok && Number(item.version.split(".")[0]) >= 2

// The newest OpenCode release, so triage runs on current code. Undefined when offline.
export async function latestVersion() {
  try {
    const response = await fetch("https://registry.npmjs.org/@opencode/cli/latest", { signal: AbortSignal.timeout(5000) })
    return ((await response.json()) as { version?: string }).version
  } catch {
    return undefined
  }
}

// Newest first: "2.0.32" > "2.0.9"; prereleases like 0.0.0-beta sort last.
export const compareVersions = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true })

// Installs @opencode/cli into a folder that is deleted when the session ends. npm gets its own
// cache inside that folder, so nothing stays behind in ~/.npm either. Nothing global changes.
export function installPrivateCopy(runtimeDir: string, version: string): Opencode | undefined {
  fs.mkdirSync(runtimeDir, { recursive: true })
  const result = spawnSync(
    isWindows ? "npm.cmd" : "npm",
    ["install", "--prefix", runtimeDir, "--cache", path.join(runtimeDir, "npm-cache"), "--no-audit", "--no-fund", "--loglevel=error", `@opencode/cli@${version}`],
    { stdio: "inherit", shell: isWindows },
  )
  fs.rmSync(path.join(runtimeDir, "npm-cache"), { recursive: true, force: true })
  if (result.status !== 0) return undefined
  const file = path.join(runtimeDir, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
  if (!fs.existsSync(file)) return undefined
  return { file, source: "temporary copy downloaded by oc-triage", ...versionOf(file) }
}

export type Preflight = { ok: true; models: string[] } | { ok: false; error: string }

// Proves a binary can start a private (standalone) server in the sandbox: the same thing the
// triage TUI does. Server logs normally go nowhere; OPENCODE_PRINT_LOGS keeps the real error.
export function preflight(file: string, env: NodeJS.ProcessEnv): Preflight {
  const result = spawnSync(file, ["models", "--standalone"], {
    env: { ...env, OPENCODE_PRINT_LOGS: "1", OPENCODE_LOG_LEVEL: "WARN" },
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  const models = (result.stdout || "").split(/\r?\n/).filter((line) => line.includes("/"))
  if (result.status === 0 && models.length) return { ok: true, models }
  const reason = result.error
    ? (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? "timed out after 90 s"
      : result.error.message
    : result.signal
      ? `killed by ${result.signal}`
      : `exit code ${result.status}`
  return { ok: false, error: [`$ ${file} models --standalone  → ${reason}`, result.stderr, result.stdout].filter(Boolean).join("\n") }
}
