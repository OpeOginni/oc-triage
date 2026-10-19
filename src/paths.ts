// Where OpenCode V2 keeps things on this machine. Mirrors packages/util/src/global-roots.ts
// (XDG layout under the home dir on every OS, Windows included) and the desktop app's
// Electron userData (appData + app id), from packages/desktop/src/main/lifecycle/configure.ts.
import os from "node:os"
import path from "node:path"

export const DESKTOP_APP_IDS = ["ai.opencode.desktop", "ai.opencode.desktop.beta", "ai.opencode.desktop.dev"]

export type Paths = ReturnType<typeof opencodePaths>

export function opencodePaths(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const home = os.homedir()
  const xdg = {
    data: env.XDG_DATA_HOME || path.join(home, ".local", "share"),
    config: env.XDG_CONFIG_HOME || path.join(home, ".config"),
    state: env.XDG_STATE_HOME || path.join(home, ".local", "state"),
    cache: env.XDG_CACHE_HOME || path.join(home, ".cache"),
  }
  const data = path.join(xdg.data, "opencode")
  const config = env.OPENCODE_CONFIG_DIR || path.join(xdg.config, "opencode")
  const state = path.join(xdg.state, "opencode")
  const cache = path.join(xdg.cache, "opencode")

  const appData =
    platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : platform === "win32"
        ? env.APPDATA || path.join(home, "AppData", "Roaming")
        : xdg.config

  return {
    home,
    data,
    db: path.join(data, env.OPENCODE_DB || "opencode.db"),
    log: path.join(data, "log"),
    legacyAuth: path.join(data, "auth.json"),
    config,
    state,
    serviceRegistration: path.join(state, "service.json"),
    serviceSettings: path.join(config, "service.json"),
    cache,
    tmp: path.join(os.tmpdir(), "opencode"),
    desktop: DESKTOP_APP_IDS.map((id) => ({ id, userData: path.join(appData, id) })),
    systemConfig:
      platform === "darwin"
        ? "/Library/Application Support/opencode"
        : platform === "win32"
          ? path.join(env.ProgramData || "C:\\ProgramData", "opencode")
          : "/etc/opencode",
  }
}

// Where the desktop app bundles its copy of the CLI ("opencode-cli"), per OS.
export function desktopBundledCli(env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const home = os.homedir()
  if (platform === "darwin") {
    return ["/Applications", path.join(home, "Applications")].flatMap((dir) =>
      ["OpenCode", "OpenCode Beta", "OpenCode Dev"].map((name) =>
        path.join(dir, `${name}.app`, "Contents", "Resources", "opencode-cli"),
      ),
    )
  }
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local")
    return [
      path.join(local, "Programs", "@opencodedesktop", "resources", "opencode-cli.exe"),
      path.join(local, "Programs", "OpenCode", "resources", "opencode-cli.exe"),
    ]
  }
  return ["/opt/OpenCode", "/opt/OpenCode Beta", "/usr/lib/opencode"].map((dir) =>
    path.join(dir, "resources", "opencode-cli"),
  )
}

// Where the standalone CLI ends up for each install method.
export function cliInstallLocations(platform = process.platform) {
  const home = os.homedir()
  const exe = platform === "win32" ? "opencode.exe" : "opencode"
  return [
    { method: "curl install script", file: path.join(home, ".opencode", "bin", exe) },
    { method: "homebrew", file: "/opt/homebrew/bin/opencode" },
    { method: "homebrew", file: "/usr/local/bin/opencode" },
    { method: "bun global", file: path.join(home, ".bun", "bin", exe) },
  ]
}
