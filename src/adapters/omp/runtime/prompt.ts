import { OMP_BUILTIN_COMMANDS, OMP_UTILITY_COMMANDS } from './commands'

export const PROMPT_MESSAGE_TYPE = 'buracle.prompt'

export function fitPrompt(parts: ReadonlyArray<{ text: string | undefined, order: number }>, max: number): string[] {
  const kept: Array<{ text: string, order: number }> = []
  let size = 0
  for (const part of parts) {
    if (part.text === undefined || part.text.trim() === '') continue
    const n = part.text.length + 2
    if (kept.length > 0 && size + n > max) continue
    kept.push({ text: part.text, order: part.order })
    size += n
  }
  return kept.sort((a, b) => a.order - b.order).map(k => k.text)
}

export function noTurnCommand(text: string): boolean {
  const m = /^\/([^\s:]+)/.exec(typeof text === 'string' ? text.trim() : '')
  if (m === null) return false
  const name = (m[1] as string).toLowerCase()
  return OMP_UTILITY_COMMANDS.includes(name) || OMP_BUILTIN_COMMANDS.has(name)
}

export function isModelPrompt(text: string): boolean {
  const t = typeof text === 'string' ? text.trim() : ''
  return t !== '' && !t.startsWith('!') && !noTurnCommand(t)
}
