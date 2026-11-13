export interface ProviderProgressUpdate {
  itemId: string
  kind: 'summary' | 'reasoning' | 'plan' | 'commentary'
  text: string
  sections?: readonly string[]
  completed?: boolean
}
type Json = Record<string, unknown>
interface Emission { delta: string; progress: ProviderProgressUpdate }
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const indexOf = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0

/** Each completed item replaces its streamed sections, including corrections and empty results. */
export class CodexProgress {
  private parts = new Map<string, Map<number, string>>()
  private snapshots = new Map<string, string>()
  private messagePhases = new Map<string, string>()
  private planItemId = 'turn-plan'
  private lastTextSection?: string

  handle(method: string, params: Json): Emission[] {
    const item = object(params.item)
    if (method === 'item/started' && item.type === 'plan' && typeof item.id === 'string') this.planItemId = item.id
    const itemId = typeof params.itemId === 'string' ? params.itemId : ''
    if (method === 'item/started' && item.type === 'agentMessage' && typeof item.id === 'string' && typeof item.phase === 'string')
      this.messagePhases.set(item.id, item.phase)
    // Commentary is public progress; keep its identity separate from reasoning summaries.
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string' && this.messagePhases.get(itemId) === 'commentary')
      return this.section(itemId, 'commentary', 0, params.delta, false)
    if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.id === 'string' && typeof item.text === 'string'
      && (item.phase === 'commentary' || this.messagePhases.get(item.id) === 'commentary'))
      return this.complete(item.id, 'commentary', [item.text])
    if (method === 'item/reasoning/summaryPartAdded')
      return this.section(itemId, 'summary', indexOf(params.summaryIndex), '', false)
    if (method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string')
      return this.section(itemId, 'summary', indexOf(params.summaryIndex), params.delta, false)
    if (method === 'item/reasoning/textDelta' && typeof params.delta === 'string')
      return this.section(itemId, 'reasoning', indexOf(params.contentIndex), params.delta, false)
    if (method === 'item/completed' && item.type === 'reasoning') {
      const id = typeof item.id === 'string' ? item.id : ''
      return (['summary', 'content'] as const).flatMap(field => {
        if (!Array.isArray(item[field])) return []
        const kind = field === 'summary' ? 'summary' : 'reasoning'
        const sections = item[field].map(value => typeof value === 'string' ? value : '')
        return this.complete(id, kind, sections)
      })
    }
    if (method === 'item/plan/delta' && typeof params.delta === 'string') {
      if (itemId) this.planItemId = itemId
      return this.section(this.planItemId, 'plan', 0, params.delta, false)
    }
    if (method === 'turn/plan/updated') {
      const steps = Array.isArray(params.plan) ? params.plan.flatMap(value => {
        const step = object(value)
        return typeof step.step === 'string' ? [String(step.status ?? 'pending') + ': ' + step.step] : []
      }) : []
      const text = [typeof params.explanation === 'string' ? params.explanation : '', ...steps].filter(Boolean).join('\n')
      return this.complete('turn-plan', 'plan', [text], false)
    }
    if (method === 'item/completed' && item.type === 'plan' && typeof item.text === 'string') {
      const id = typeof item.id === 'string' ? item.id : this.planItemId
      return this.complete(id, 'plan', [item.text])
    }
    return []
  }

  private section(itemId: string, kind: ProviderProgressUpdate['kind'], index: number, delta: string, completed: boolean): Emission[] {
    const key = JSON.stringify([kind, itemId])
    const sections = this.parts.get(key) ?? new Map<number, string>()
    sections.set(index, (sections.get(index) ?? '') + delta)
    this.parts.set(key, sections)
    return this.publish(itemId, kind, sections, this.portableDelta(itemId, kind, index, delta), completed)
  }

  private complete(itemId: string, kind: ProviderProgressUpdate['kind'], values: string[], completed = true): Emission[] {
    const key = JSON.stringify([kind, itemId])
    const previous = this.parts.get(key) ?? new Map<number, string>()
    const delta = values.map((value, index) => {
      const prior = previous.get(index) ?? ''
      const suffix = value.startsWith(prior)
      return this.portableDelta(itemId, kind, index, suffix ? value.slice(prior.length) : value, !suffix)
    }).join('')
    const sections = new Map(values.map((text, index) => [index, text]))
    this.parts.set(key, sections)
    return this.publish(itemId, kind, sections, delta, completed)
  }

  private portableDelta(itemId: string, kind: ProviderProgressUpdate['kind'], index: number, text: string, corrected = false): string {
    if (!text) return ''
    const section = JSON.stringify([kind, itemId, index])
    // Text-only consumers lack item metadata, so boundaries must travel in the text itself.
    const separator = this.lastTextSection !== undefined && (this.lastTextSection !== section || corrected) ? '\n\n' : ''
    this.lastTextSection = section
    return separator + text
  }

  private publish(itemId: string, kind: ProviderProgressUpdate['kind'], parts: Map<number, string>, delta: string, completed: boolean): Emission[] {
    const sections = [...parts].sort(([a], [b]) => a - b).map(([, text]) => text)
    const progress = { itemId, kind, text: sections.join('\n\n'), sections, completed }
    const key = JSON.stringify([kind, itemId]), serialized = JSON.stringify(progress)
    if (!progress.text.trim() && !this.snapshots.has(key)) return []
    if (this.snapshots.get(key) === serialized) return []
    this.snapshots.set(key, serialized)
    return [{ delta, progress }]
  }
}
