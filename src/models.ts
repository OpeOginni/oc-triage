// OpenCode Zen's free models. The default is a free model that can see screenshots, with Big
// Pickle as the fallback: OpenCode keeps it free permanently (it routes to another model
// underneath), but it reads text only. The rest of the lineup changes every few weeks, so it is
// never pinned: we take the models the harness serves right now and read capabilities from models.dev.
export const ALWAYS_FREE = "opencode/big-pickle"

// Model families (not ids, which rotate) tried in order when several free vision models are on
// offer; anything else ranks by context size. If none is on offer, Big Pickle takes over.
const PREFERRED = ["glm", "deepseek", "kimi", "qwen", "minimax", "mimo"]

export type FreeModel = { id: string; context: number }

type ModelsDev = Record<string, { models?: Record<string, { cost?: { input?: number }; tool_call?: boolean; modalities?: { input?: string[] }; limit?: { context?: number } }> }>

async function freeModelCatalog(): Promise<FreeModel[]> {
  try {
    const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(5000) })
    const models = ((await response.json()) as ModelsDev).opencode?.models ?? {}
    return Object.entries(models)
      .filter(([, m]) => m.cost?.input === 0 && m.tool_call && m.modalities?.input?.includes("image"))
      .map(([id, m]) => ({ id: `opencode/${id}`, context: m.limit?.context ?? 0 }))
  } catch {
    return []
  }
}

const rank = (id: string) => {
  const i = PREFERRED.findIndex((name) => id.includes(name))
  return i === -1 ? PREFERRED.length : i
}

export async function pickVisionModel(served: string[]): Promise<FreeModel | undefined> {
  const available = new Set(served)
  const free = (await freeModelCatalog()).filter((m) => available.has(m.id))
  const sorted = free.sort((a, b) => rank(a.id) - rank(b.id) || b.context - a.context)
  return sorted[0]
}
