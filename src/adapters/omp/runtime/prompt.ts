import { OMP_BUILTIN_COMMANDS, OMP_UTILITY_COMMANDS } from './commands'

export const PROMPT_MESSAGE_TYPE = 'buracle.prompt'

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
