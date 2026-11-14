import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentDoc, CanonicalBundle } from '../../core/catalog'

const INCLUDE_LINE = /^[ \t]*\{\{include:([^}\s]*)\}\}[ \t]*$/
const INCLUDE_ANYWHERE = /\{\{include:[^}]*\}\}/
const INCLUDE_TARGET = /^([a-z0-9][a-z0-9._-]*)#([a-z0-9][a-z0-9-]*)$/
const PART_LINE = /^<!--\s*part:\s*([a-z0-9][a-z0-9-]*)\s*-->[ \t]*$/

/** Where the text that several agents share lives: canonical/agents/partials/<id>.md. A partial is never an agent. */
export const AGENT_PARTIALS_DIR = 'agents/partials'

export type PartialReader = (id: string) => string | undefined

/** The named parts of a partial: the text after each `<!-- part: <name> -->` line, up to the next one. */
export function partialParts(text: string): Map<string, string> {
  const out = new Map<string, string>()
  let name: string | undefined
  let buf: string[] = []
  const flush = () => {
    if (name !== undefined) out.set(name, buf.join('\n').trim())
    buf = []
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = PART_LINE.exec(line)
    if (m?.[1] !== undefined) { flush(); name = m[1]; continue }
    buf.push(line)
  }
  flush()
  return out
}

/**
 * One agent body with every `{{include:<partial>#<part>}}` line replaced by that part's text. An include that names
 * nothing is an error, never silent text: a generated agent must be a complete file.
 */
export function expandIncludes(body: string, file: string, read: PartialReader): string {
  if (!INCLUDE_ANYWHERE.test(body)) return body
  const cache = new Map<string, Map<string, string> | undefined>()
  const parts = (id: string) => {
    if (!cache.has(id)) {
      const text = read(id)
      cache.set(id, text === undefined ? undefined : partialParts(text))
    }
    return cache.get(id)
  }
  return body.replace(/\r\n/g, '\n').split('\n').map((line, i) => {
    const m = INCLUDE_LINE.exec(line)
    if (m === null) {
      if (INCLUDE_ANYWHERE.test(line)) throw new Error(`${file}:${i + 1}: an include takes a whole line`)
      return line
    }
    const target = INCLUDE_TARGET.exec(m[1] ?? '')
    const text = target === null ? undefined : parts(target[1] as string)?.get(target[2] as string)
    if (text === undefined || text === '') throw new Error(`${file}:${i + 1}: {{include:${m[1]}}} names no part of a file in canonical/${AGENT_PARTIALS_DIR}`)
    return text
  }).join('\n')
}

function diskReader(root: string | undefined): PartialReader {
  return id => {
    if (root === undefined || root === '') return undefined
    try { return readFileSync(join(root, AGENT_PARTIALS_DIR, `${id}.md`), 'utf8') } catch { return undefined }
  }
}

/**
 * The agents as a harness gets them: the same list as `canonical.agents`, each body complete. The generators call this
 * instead of reading `canonical.agents`, so the shared review body is written once in canonical/ and every generated
 * agent still stands alone.
 */
export function resolveAgents(canonical: Pick<CanonicalBundle, 'agents'> & { root?: string }, read: PartialReader = diskReader(canonical.root)): AgentDoc[] {
  return canonical.agents.map(a => {
    const body = expandIncludes(a.body, a.file, read)
    return body === a.body ? a : { ...a, body }
  })
}
