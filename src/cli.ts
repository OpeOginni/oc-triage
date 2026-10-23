#!/usr/bin/env node
// npx oc-triage: collect facts about this machine's OpenCode install, then open OpenCode
// itself (in a private, isolated copy) with a triage agent that walks the user through a fix.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { buildContext } from "./context"
import { ALWAYS_FREE, pickVisionModel } from "./models"
import { compareVersions, findOpencodes, installPrivateCopy, isV2, latestVersion, preflight, versionOf, type Opencode } from "./opencode"
import { opencodePaths } from "./paths"
import { logErrors, machineFacts, printErrorReport, tail } from "./report"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
const isWindows = process.platform === "win32"

const { values: args } = parseArgs({
  options: {
    model: { type: "string", short: "m" },
    opencode: { type: "string" },
    print: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
})

if (args.version) {
  console.log(version)
  process.exit(0)
}
if (args.help) {
  console.log(`oc-triage ${version}: diagnose and fix a broken OpenCode install (desktop app or TUI)

Usage: npx oc-triage [options]

  -m, --model <id>     Model to start on, e.g. opencode/big-pickle. Default: the model you used
                       last in OpenCode, else a free model that reads screenshots, else Big
                       Pickle (always free). Switch any time in the app.
  --opencode <path>    OpenCode binary to run the triage session with
  --print              Only write the triage files and print their paths, to paste into any agent
  -h, --help           Show this help
  -v, --version        Show the version`)
  process.exit(0)
}

const home = process.env.OC_TRIAGE_HOME || path.join(os.homedir(), ".oc-triage")
// A downloaded OpenCode and the sandbox's copy of the user's logins exist for one session
// only; both are removed on every way out, crashes included.
const runtime = path.join(home, "runtime")
const sandboxDataRoot = path.join(home, "harness", "data")
process.on("exit", () => {
  for (const dir of [runtime, sandboxDataRoot]) fs.rmSync(dir, { recursive: true, force: true })
})

// If oc-triage itself breaks, the user still gets the full error to copy.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    printErrorReport({
      title: "oc-triage itself crashed",
      facts: machineFacts(version),
      sections: [{ heading: "Error", body: error instanceof Error ? (error.stack ?? error.message) : String(error) }],
    })
    process.exit(1)
  })
}

const say = (text: string) => console.log(`\x1b[36m›\x1b[0m ${text}`)

// The user's install, as their own environment sees it.
const userEnv = { ...process.env }
const paths = opencodePaths(userEnv)

say("Looking for OpenCode on this computer…")
const opencodes = findOpencodes(paths)
// The desktop app keeps a copy per update; list those on one line unless they're broken.
const staged = opencodes.filter((o) => o.source === "desktop app's staged copy" && o.ok)
for (const o of opencodes.filter((o) => !staged.includes(o))) say(`  ${o.ok ? `v${o.version}` : "broken"}  ${o.file}  (${o.source})`)
if (staged.length) say(`  + ${staged.length} older copies kept by the desktop app`)
if (!opencodes.length) say("  No OpenCode CLI found.")

// oc-triage's own folder: the harness runs with private config, data and state so a broken
// user config or database can't stop the triage session from starting.
const sandbox = {
  XDG_CONFIG_HOME: path.join(home, "harness", "config"),
  XDG_DATA_HOME: sandboxDataRoot,
  XDG_STATE_HOME: path.join(home, "harness", "state"),
  XDG_CACHE_HOME: path.join(home, "harness", "cache"),
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CLAUDE_CODE: "1",
  OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ default_agent: "triage", ...(args.model ? { model: args.model } : {}) }),
  OPENCODE_CONFIG_DIR: undefined,
  OPENCODE_CONFIG: undefined,
  OPENCODE_DB: undefined,
}
const harnessEnv = { ...userEnv }
for (const [key, value] of Object.entries(sandbox)) {
  if (value === undefined) delete harnessEnv[key]
  else harnessEnv[key] = value
}

// Session folder: the agent's working directory, with context, wrapper and backups.
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const sessionDir = path.join(home, "sessions", stamp)
const backups = path.join(sessionDir, "backups")
const errorReport = path.join(sessionDir, "error-report.txt")
fs.mkdirSync(backups, { recursive: true })

// Old sessions can hold large database backups: keep two weeks.
const sessionsDir = path.dirname(sessionDir)
for (const name of fs.readdirSync(sessionsDir)) {
  const dir = path.join(sessionsDir, name)
  if (Date.now() - fs.statSync(dir).mtimeMs > 14 * 24 * 60 * 60 * 1000) fs.rmSync(dir, { recursive: true, force: true })
}

// Every session starts from an empty sandbox database.
const sandboxData = path.join(sandbox.XDG_DATA_HOME, "opencode")
fs.rmSync(sandboxData, { recursive: true, force: true })

// The triage session must work even when the user's OpenCode is dead, so a binary only runs it
// after proving it can start a private server in the sandbox. Failures are kept for the report.
fs.rmSync(runtime, { recursive: true, force: true })
const failures: { heading: string; body: string }[] = []
type Harness = { harness: Extract<Opencode, { ok: true }>; served: string[] }

function check(candidate: Opencode): Harness | undefined {
  if (!candidate.ok) {
    failures.push({ heading: `${candidate.file} (${candidate.source})`, body: candidate.error })
    return
  }
  say(`Checking OpenCode ${candidate.version} (${candidate.source})…`)
  const result = preflight(candidate.file, harnessEnv)
  if (result.ok) return { harness: candidate, served: result.models }
  say("  It couldn't start.")
  failures.push({ heading: `${candidate.file} v${candidate.version} (${candidate.source})`, body: tail(result.error) })
}

// Prefer the latest release: a copy already on this computer if one is current, otherwise a
// temporary download. Offline or if that fails, the newest copy on this computer that works.
async function chooseHarness(): Promise<Harness | undefined> {
  if (args.opencode) return check({ file: args.opencode, source: "--opencode", ...versionOf(args.opencode) })
  const seen = new Set<string>()
  const local = opencodes
    .filter(isV2)
    .sort((a, b) => (a.ok && b.ok ? compareVersions(a.version, b.version) : 0) || Number(a.source.includes("desktop")) - Number(b.source.includes("desktop")))
    .filter((o) => o.ok && !seen.has(o.version) && seen.add(o.version))
  const latest = await latestVersion()
  const current = local.filter((o) => o.ok && o.version === latest)
  for (const candidate of current) {
    const found = check(candidate)
    if (found) return found
  }
  if (latest) {
    say(`Getting the latest OpenCode (${latest}) for this session. It is removed again afterwards.`)
    const installed = installPrivateCopy(runtime, latest)
    const found = installed && check(installed)
    if (found) return found
    if (!installed) failures.push({ heading: `Downloading OpenCode ${latest}`, body: "`npm install @opencode/cli` failed: see its output above." })
  }
  for (const candidate of local.filter((o) => !current.includes(o))) {
    const found = check(candidate)
    if (found) return found
  }
}

let harness: Harness["harness"] | undefined
let served: string[] = []
if (!args.print) {
  const chosen = await chooseHarness()
  if (!chosen) {
    printErrorReport({
      title: "no copy of OpenCode could start",
      facts: [
        ...machineFacts(version),
        "- OpenCode binaries found:",
        ...(opencodes.length ? opencodes.map((o) => `  - ${o.file} (${o.source}): ${o.ok ? `v${o.version}` : `BROKEN: ${o.error}`}`) : ["  - none"]),
      ],
      sections: failures,
      saveTo: errorReport,
    })
    process.exit(1)
  }
  ;({ harness, served } = chosen)
}

// Wrapper that runs the user's own OpenCode with the user's own environment, so commands the
// agent runs (service restart, auth list…) act on the real install, not the sandbox.
const userBin = opencodes.find((o) => o.source === "on PATH" && o.ok)?.file ?? opencodes.find((o) => o.ok)?.file ?? harness?.file
const wrapper = path.join(sessionDir, isWindows ? "oc.cmd" : "oc")
const restore = Object.keys(sandbox).map((key) => [key, userEnv[key]])
if (isWindows) {
  const lines = restore.map(([key, value]) => (value === undefined ? `set ${key}=` : `set "${key}=${value}"`))
  fs.writeFileSync(wrapper, ["@echo off", ...lines, `"${userBin}" %*`, ""].join("\r\n"))
} else {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
  const lines = restore.map(([key, value]) => (value === undefined ? `unset ${key}` : `export ${key}=${quote(value)}`))
  fs.writeFileSync(wrapper, ["#!/bin/sh", ...lines, `exec ${quote(userBin ?? "opencode")} "$@"`, ""].join("\n"), { mode: 0o755 })
}

// Bring in the user's logins so their own providers work. The copy is deleted when the session
// ends. If the user's install is too broken to export them, triage carries on with free models.
let logins = 0
const exporter = opencodes.find((o) => o.source === "on PATH" && isV2(o)) ?? opencodes.find(isV2)
if (harness && exporter) {
  say("Bringing in your OpenCode logins…")
  const exported = spawnSync(exporter.file, ["auth", "export", "--standalone"], { env: userEnv, encoding: "utf8", timeout: 30000, windowsHide: true })
  try {
    logins = JSON.parse(exported.stdout).length
  } catch {}
  if (logins) {
    const imported = spawnSync(harness.file, ["auth", "import", "--standalone"], { env: harnessEnv, input: exported.stdout, timeout: 60000, windowsHide: true })
    if (imported.status !== 0) logins = 0
  }
  say(logins ? `  ${logins} login(s) available to the triage session.` : "  None usable: free models only.")
}

// The TUI starts on the first usable model in model.json's "recent" list. Seed it with the
// user's own recent models, then a free model that reads screenshots, then Big Pickle (always
// free). The TUI skips models that are no longer served, so Big Pickle catches removed ones.
let modelNote = args.model ?? `your last used model, else ${ALWAYS_FREE}`
if (harness) {
  say("Picking a model…")
  const vision = await pickVisionModel(served)
  let prefs: { recent?: unknown } = {}
  try {
    prefs = JSON.parse(fs.readFileSync(path.join(paths.state, "model.json"), "utf8"))
  } catch {}
  const recent: { providerID: string; modelID: string }[] = Array.isArray(prefs.recent) ? prefs.recent : []
  const userRecent = recent[0]
  for (const id of [vision?.id, ALWAYS_FREE]) if (id) recent.push({ providerID: "opencode", modelID: id.slice("opencode/".length) })
  const sandboxState = path.join(sandbox.XDG_STATE_HOME, "opencode")
  fs.mkdirSync(sandboxState, { recursive: true })
  fs.writeFileSync(path.join(sandboxState, "model.json"), JSON.stringify({ ...prefs, recent }, null, 2))
  if (!args.model) {
    const free = vision ? `${vision.id} (free, reads screenshots), else ${ALWAYS_FREE} (free, text only)` : `${ALWAYS_FREE} (free, text only)`
    modelNote = userRecent ? `${userRecent.providerID}/${userRecent.modelID} (last used), else ${free}` : free
  }
}

const contextFile = path.join(sessionDir, "context.md")
const context = buildContext({
  version,
  paths,
  opencodes,
  harness: harness ?? { file: "(none: --print)", version: "-" },
  model: modelNote,
  session: { dir: sessionDir, backups, wrapper, userEnv },
})
fs.writeFileSync(contextFile, context)

const playbook = fs.readFileSync(path.join(root, "PLAYBOOK.md"), "utf8")
// The machine facts ride along in the agent's instructions, so the visible first message stays short.
const instructions = `${playbook}\n\n---\n\n${context}`
const kickoff = "Hi, I need help with OpenCode."

if (!harness) {
  const promptFile = path.join(sessionDir, "prompt.md")
  fs.writeFileSync(promptFile, `${instructions}\n\n---\n\n${kickoff}\n`)
  say(`Triage prompt: ${promptFile}`)
  say(`Machine facts: ${contextFile}`)
  say("Paste the prompt file into any coding agent to run triage by hand.")
  process.exit(0)
}

// The triage agent, written into the sandbox's config folder on every run.
const permissions = [
  ["*", "*", "ask"],
  ["read", "*", "allow"],
  ["grep", "*", "allow"],
  ["glob", "*", "allow"],
  ["question", "*", "allow"],
  ["webfetch", "*", "allow"],
  ["websearch", "*", "allow"],
  ["external_directory", "*", "allow"],
  // Prompts are for changes the user agreed to in chat, nothing else. Tools triage doesn't need are
  // switched off so they never prompt: the user's own skills (~/.claude/skills, ~/.agents/skills),
  // subagents, and code mode (scripts calling the sandbox's own session/worktree tools).
  ["skill", "*", "deny"],
  ["subagent", "*", "deny"],
  ["execute", "*", "deny"],
  ["read", "*auth.json", "deny"],
  ["read", "*.env", "deny"],
  ["read", "*.env.*", "deny"],
]
const agentsDir = path.join(sandbox.XDG_CONFIG_HOME, "opencode", "agents")
fs.mkdirSync(agentsDir, { recursive: true })
fs.writeFileSync(
  path.join(agentsDir, "triage.md"),
  [
    "---",
    "description: Diagnose and fix problems with this computer's OpenCode install",
    "mode: primary",
    "permissions:",
    ...permissions.map(([action, resource, effect]) => `  - { action: "${action}", resource: "${resource}", effect: ${effect} }`),
    "---",
    instructions,
  ].join("\n"),
)

say(`Model: ${modelNote}`)
say(`Session folder: ${sessionDir}`)
say("Starting OpenCode triage. Tip: drag a screenshot into the window to show what went wrong.\n")

// Ctrl+C belongs to the TUI; keep this process alive so the cleanup below still runs.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => {})
const child = spawnSync(harness.file, ["--standalone", "--prompt", kickoff, sessionDir], {
  cwd: sessionDir,
  env: harnessEnv,
  stdio: "inherit",
  windowsHide: false,
})
// Keep the session's log, then remove the sandbox's copy of the user's logins.
const sessionLog = path.join(sessionDir, "opencode.log")
try {
  fs.copyFileSync(path.join(sandboxData, "log", "opencode.log"), sessionLog)
} catch {}
fs.rmSync(sandboxData, { recursive: true, force: true })
// Quitting with Ctrl+C (exit 130) or closing the terminal is a normal way out, not a crash.
const quit = child.status === 0 || child.status === 130 || child.status === 143 || ["SIGINT", "SIGTERM", "SIGHUP"].includes(child.signal ?? "")
if (child.error || !quit) {
  printErrorReport({
    title: `the triage session ended with ${child.error ? child.error.message : child.signal ? `signal ${child.signal}` : `exit code ${child.status}`}`,
    facts: [...machineFacts(version), `- OpenCode used: ${harness.file} v${harness.version}`],
    sections: [{ heading: "OpenCode log (errors, then the last lines)", body: logErrors(sessionLog) }],
    saveTo: errorReport,
  })
}
console.log(`\nTriage notes and backups are in ${sessionDir}`)
process.exit(quit && !child.error ? 0 : (child.status ?? 1))
