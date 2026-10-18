import type { ToolKind } from '../../core/events'
import { maskSecrets } from '../../core/receipt'

export const MASK_MAX_CHARS = 400_000

const MASKED_KINDS: ReadonlySet<ToolKind> = new Set<ToolKind>(['bash', 'eval', 'read', 'search', 'mcp'])

export function masksToolKind(kind: ToolKind): boolean {
  return MASKED_KINDS.has(kind)
}

export function maskToolOutput(value: unknown): { value: unknown, count: number } {
  try {
    return maskSecrets(value, MASK_MAX_CHARS)
  } catch {
    return { value, count: 0 }
  }
}

export function maskNotice(count: number): string {
  return `Buracle: ${count === 1 ? '1 secret value' : `${count} secret values`} hidden from the model`
}
