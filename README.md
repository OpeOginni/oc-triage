# oc-triage

Fix a broken OpenCode install with OpenCode itself.

```sh
npx oc-triage
```

It opens OpenCode with a triage agent that asks what went wrong, reads the right logs and files for your OS, explains the problem in plain words, and fixes simple issues with your approval (backing files up first). When it can't fix something and you have the GitHub CLI logged in, it checks for an existing issue (adding a comment if there is one) or drafts a short new one from the OpenCode bug template, with personal details removed, and posts only with your OK.

Made for the desktop app as much as the terminal: you don't need the `opencode` command installed.

## What it handles

The playbook covers the problems people report most, including:

- the desktop app breaking after a project folder is renamed or moved
- white screen or crash at launch from stale desktop state (deleted sessions, removed servers)
- "Starting background server…" forever: Windows reserved ports, WSL port reservations, a stale service, proxies
- database errors from mixing OpenCode V1 and V2
- config files silently ignored, sign-in problems, plugins, MCP, GPU crashes, macOS folder permissions

See [PLAYBOOK.md](PLAYBOOK.md) for the full list and the exact checks and fixes.

## How it works

1. Finds every OpenCode binary on the machine (PATH, install script, Homebrew, the desktop app's bundled CLI) and checks each one's version.
2. Writes `context.md` into a session folder under `~/.oc-triage/sessions/`. It holds facts and paths only (OS, versions, which config, database, log and desktop state files exist, background service status, proxy settings, and on Windows the reserved port ranges). No file contents are read at this step.
3. Starts `opencode --standalone` with private config, data and state folders, so a broken config or database can't stop triage from starting. Your logins are copied in for the session and deleted when it ends, and it opens on the model you used last. With no logins it starts on whichever free model that can read screenshots OpenCode offers that day (free models come and go), falling back to Big Pickle, the one model OpenCode keeps free permanently.
4. The agent works against your real install through a small `oc` wrapper in the session folder, which runs your own `opencode` with your own environment.

### Works when OpenCode is dead

Triage never goes through your OpenCode background service, your port, your config or your database: it runs its own private server on a random free port with its own data. Before launching, it checks that an OpenCode binary can really start that private server. It tries the latest release first, then any other copy on your computer that works. So a broken desktop app, a blocked port or a corrupt database doesn't stop it.

If no copy of OpenCode can start at all, or the session crashes, oc-triage prints the real error in full (normally it is buried in a log file), with your home folder and anything secret-looking redacted. You can copy it and send it to whoever is helping you. It is also saved as `error-report.txt` in the session folder.

The agent never fixes anything on its first reply. It explains the problem in plain English first, proposes a fix only when it's sure the fix will work, says what could happen, and waits for your go-ahead. Every command and file change also asks for your approval. Backups go into the session folder.

Triage always runs on the latest OpenCode release. If a copy on your computer is already the latest, it uses that. Otherwise it downloads the latest (about 85 MB) into a temporary folder just for the session, and deletes it afterwards, npm cache included. It never installs OpenCode globally or touches your own install, so the CLI you install later never sees it. If you're offline, it uses the newest copy on your computer that works.

## Options

```
-m, --model <id>    model to start on (default: your last used model, else a free one)
--opencode <path>   OpenCode binary to run the session with
--print             write the prompt and context files only, to paste into any agent
```

Screenshots: drag an image file into the window, or paste one.

## Development

```sh
npm install
npm run build        # tsup: src/*.ts -> dist/cli.js
npm run typecheck    # tsc, no emit
node dist/cli.js --print
```

`OC_TRIAGE_HOME=/tmp/x` points oc-triage's own folder somewhere else for testing.
