// Last resort when OpenCode can't run at all: print the real error, in full, ready to copy.
// OpenCode normally hides these in its log file; here they go straight to the terminal.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const RULE = "─".repeat(72)

// The report is meant to be pasted publicly: hide the home folder and anything secret-looking.
export function redact(text: string) {
  const home = os.homedir()
  return text
    .split(home)
    .join("~")
    .replace(/((?:password|token|secret|api[_-]?key|authorization)["'=:\s]+)[^\s"',}]+/gi, "$1***")
    .replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, "//***:***@")
}

export function tail(text: string | undefined, lines = 60) {
  return (text ?? "").trim().split(/\r?\n/).slice(-lines).join("\n")
}

// Error and warning lines from an OpenCode log file, plus its last lines for context.
export function logErrors(file: string, lines = 40) {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
  const all = text.trim().split(/\r?\n/)
  const problems = all.filter((line) => /level=(ERROR|WARN|FATAL)|error|exception|panic/i.test(line)).slice(-lines)
  const last = all.slice(-15).filter((line) => !problems.includes(line))
  return [...problems, ...last].join("\n")
}

export function printErrorReport(input: { title: string; facts: string[]; sections: { heading: string; body: string }[]; saveTo?: string }) {
  const body = [
    `oc-triage: ${input.title}`,
    "",
    ...input.facts,
    ...input.sections.flatMap((section) => ["", `## ${section.heading}`, section.body.trim() || "(no output)"]),
  ].join("\n")
  const text = redact(body)

  console.error(`\n\x1b[31m${RULE}\x1b[0m`)
  console.error(`\x1b[1mSomething went wrong. This is the real error.\x1b[0m`)
  console.error("Copy everything between the red lines and share it with whoever is helping you.")
  console.error(`\x1b[31m${RULE}\x1b[0m\n`)
  console.error(text)
  console.error(`\n\x1b[31m${RULE}\x1b[0m`)
  if (input.saveTo) {
    fs.mkdirSync(path.dirname(input.saveTo), { recursive: true })
    fs.writeFileSync(input.saveTo, text + "\n")
    console.error(`Also saved to ${input.saveTo}`)
  }
}

export function machineFacts(version: string) {
  return [`- oc-triage ${version}`, `- OS: ${os.type()} ${os.release()} (${process.platform}/${process.arch})`, `- Node: ${process.version}`]
}
