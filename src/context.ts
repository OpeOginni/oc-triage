// Writes context.md: facts about this machine's OpenCode install, gathered without reading
// any log or database contents. The agent reads the files itself, with the user watching.
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Opencode } from "./opencode"
import type { Paths } from "./paths"

const SECRET = /KEY|TOKEN|PASSWORD|SECRET|AUTH/i

function describe(file: string) {
  try {
    const stat = fs.statSync(file)
    if (stat.isDirectory()) return `\`${file}\` (folder, modified ${stat.mtime.toISOString()})`
    return `\`${file}\` (${formatSize(stat.size)}, modified ${stat.mtime.toISOString()})`
  } catch {
    return `\`${file}\` (missing)`
  }
}

const formatSize = (bytes: number) =>
  bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} KB`

const readJson = (file: string) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""))
  } catch {
    return undefined
  }
}

const list = (dir: string, filter: (name: string) => boolean = () => true) => {
  try {
    return fs.readdirSync(dir).filter(filter).map((name) => path.join(dir, name))
  } catch {
    return []
  }
}

const newest = (files: string[]) =>
  files.map((file) => ({ file, time: fs.statSync(file).mtimeMs })).sort((a, b) => b.time - a.time)[0]?.file

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function run(cmd: string, args: string[]) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim()
  } catch {
    return undefined
  }
}

// Whether the agent can search and file GitHub issues. Never records the account name.
function githubStatus() {
  const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 10000, stdio: "ignore", windowsHide: true })
  if (result.error) return "not installed: do not mention GitHub or issues to the user"
  return result.status === 0 ? "logged in: you may offer to find or file an issue" : "not logged in: do not mention GitHub or issues to the user"
}

function isWsl() {
  if (process.platform !== "linux") return false
  try {
    return /microsoft/i.test(fs.readFileSync("/proc/version", "utf8"))
  } catch {
    return false
  }
}

function proxyHost(value: string) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`
  } catch {
    return "(set)"
  }
}

function serviceSection(paths: Paths) {
  const lines = []
  const registration = readJson(paths.serviceRegistration)
  if (registration) {
    lines.push(
      `- Registration ${describe(paths.serviceRegistration)}: url ${registration.url}, pid ${registration.pid} (${alive(registration.pid) ? "process alive" : "process NOT running"}), service version ${registration.version}`,
    )
  } else {
    lines.push(`- Registration ${describe(paths.serviceRegistration)}: none or unreadable`)
  }
  const settings = readJson(paths.serviceSettings)
  if (settings) {
    const { password, env, ...rest } = settings
    lines.push(
      `- User service settings ${describe(paths.serviceSettings)}: ${JSON.stringify(rest)}${env ? `, env keys: ${Object.keys(env).join(", ")}` : ""}`,
    )
  }
  lines.push(
    `- Default port when no setting overrides it: ${process.platform === "win32" ? "45278 (Windows, since 2.0.30; 49374 before)" : "49374"}`,
  )
  return lines
}

function windowsSection() {
  const lines = []
  const excluded = run("netsh", ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"])
  if (excluded) lines.push("Windows excluded TCP port ranges (Hyper-V/WinNAT reservations):", "```", excluded, "```")
  const wslconfig = path.join(os.homedir(), ".wslconfig")
  if (fs.existsSync(wslconfig)) {
    const mode = /networkingMode\s*=\s*(\w+)/i.exec(fs.readFileSync(wslconfig, "utf8"))?.[1]
    lines.push(`- ${describe(wslconfig)}: networkingMode=${mode ?? "default (NAT)"}`)
  }
  return lines
}

export type ContextInput = {
  version: string
  paths: Paths
  opencodes: Opencode[]
  harness: { file: string; version: string }
  model: string
  session: { dir: string; backups: string; wrapper: string; userEnv: NodeJS.ProcessEnv }
}

export function buildContext({ version, paths, opencodes, harness, model, session }: ContextInput) {
  const env = session.userEnv
  const desktop = paths.desktop.filter((d) => fs.existsSync(d.userData))
  const corrupt = list(path.dirname(paths.data), (name) => name.startsWith("opencode.corrupt"))
  const latestLog = newest(list(paths.log, (name) => name.endsWith(".log")))

  const overrides = Object.keys(env)
    .filter((key) => /^(OPENCODE_|XDG_)/.test(key))
    .map((key) => `- ${key}=${SECRET.test(key) ? "(set, value hidden)" : env[key]}`)
  const proxies = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
    .flatMap((key) => {
      const value = env[key]
      return value ? [`- ${key}=${proxyHost(value)}`] : []
    })
  const noProxy = env.NO_PROXY ?? env.no_proxy

  const out = [
    "# OpenCode triage context",
    "",
    `Collected by oc-triage ${version} at ${new Date().toISOString()}. These are facts and paths only: no file contents were read.`,
    "",
    "## Machine",
    `- OS: ${os.type()} ${os.release()} (${process.platform}/${process.arch})${isWsl() ? ", running inside WSL" : ""}`,
    `- Home folder: \`${paths.home}\` (scrub this from anything you post publicly)`,
    `- Node: ${process.version}`,
    "",
    "## OpenCode binaries found",
    ...(opencodes.length
      ? opencodes.map((o) => `- \`${o.file}\` (${o.source}): ${o.ok ? `v${o.version}` : `BROKEN: ${o.error}`}`)
      : ["- None. The user has no standalone CLI, and no desktop app bundle was found."]),
    `- This triage session itself runs on \`${harness.file}\` v${harness.version}. That is oc-triage's choice, not necessarily what the user runs.`,
    "",
    "## Commands against the user's real install",
    `The triage harness runs with its own private config and data folders. To run an OpenCode command against the user's real install, ALWAYS use the wrapper \`${session.wrapper}\`, which restores the user's environment, e.g. \`${session.wrapper} service status\`. Never call \`opencode\` directly for that.`,
    "",
    "## Paths (OpenCode V2)",
    `- Config folder: ${describe(paths.config)}`,
    ...["opencode.json", "opencode.jsonc", "cli.json", "config.json"].map((name) => `  - ${describe(path.join(paths.config, name))}`),
    `- Admin-managed config: ${describe(paths.systemConfig)}`,
    `- Data folder: ${describe(paths.data)}`,
    `  - Database (sessions, projects, credentials): ${describe(paths.db)}`,
    `  - ${describe(paths.db + "-wal")}`,
    `  - Server log folder: ${describe(paths.log)}${latestLog ? `, newest: \`${latestLog}\`` : ""}`,
    `  - Legacy V1 credentials file, NEVER read: ${describe(paths.legacyAuth)}`,
    ...corrupt.map((dir) => `  - Data folder OpenCode moved aside after corruption: ${describe(dir)}`),
    `- State folder: ${describe(paths.state)}`,
    `- Cache folder (plugins, downloaded tools): ${describe(paths.cache)}`,
    "",
    "## Background service",
    ...serviceSection(paths),
    "",
    "## Desktop app",
    ...(desktop.length
      ? desktop.flatMap(({ id, userData }) => [
          `- ${id}: ${describe(userData)}`,
          `  - UI state (projects list, open tabs, servers): ${describe(path.join(userData, "drafts.sqlite"))}`,
          `  - Settings: ${describe(path.join(userData, "opencode.settings"))}`,
          `  - Logs: ${describe(path.join(userData, "logs"))}${newest(list(path.join(userData, "logs"))) ? `, newest: \`${newest(list(path.join(userData, "logs")))}\`` : ""}`,
          `  - Staged CLI copies: ${describe(path.join(userData, "cli"))}`,
          ...list(userData, (name) => name.endsWith(".dat")).map((file) => `  - Legacy V1 UI state file: ${describe(file)}`),
        ])
      : ["- No desktop app data folder found."]),
    "",
    "## Environment",
    ...(overrides.length ? overrides : ["- No OPENCODE_* or XDG_* variables set by the user."]),
    ...(proxies.length ? [...proxies, `- NO_PROXY=${noProxy ?? "(not set: loopback traffic may go through the proxy)"}`] : ["- No proxy variables set."]),
    ...(process.platform === "win32" ? ["", "## Windows", ...windowsSection()] : []),
    "",
    "## GitHub",
    `- GitHub CLI (\`gh\`): ${githubStatus()}`,
    "",
    "## This triage session",
    `- Session folder (your working directory): \`${session.dir}\``,
    `- Put backups here before changing any file: \`${session.backups}\``,
    `- Model: ${model}`,
    "",
  ]
  return out.join("\n")
}
