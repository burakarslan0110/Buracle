export const VAGUE_PHRASES: readonly RegExp[] = [
  /\bimplement(?:ed)? later\b/i,
  /\bfill in (?:the )?details\b/i,
  /\bdetails below\b/i,
  /\b(?:similar to|same as) task \d+\b/i,
  /\b(?:add )?appropriate error handling\b/i,
  /\bhandle (?:the |all |any )?edge cases\b/i,
]

export function vaguePhrase(text: string): string | undefined {
  for (const re of VAGUE_PHRASES) {
    const m = re.exec(text)
    if (m) return m[0].trim()
  }
  return undefined
}
