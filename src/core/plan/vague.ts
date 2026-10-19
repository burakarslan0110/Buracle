export const VAGUE_PHRASES: readonly RegExp[] = [
  /\bimplement(?:ed)? later\b/i,
  /\bfill in (?:the )?details\b/i,
  /\bdetails below\b/i,
  /\b(?:similar to|same as) task \d+\b/i,
  /\b(?:add )?appropriate error handling\b/i,
  /\bhandle (?:the |all |any )?edge cases\b/i,
  /(?<!\p{L})(?:daha )?sonra (?:uygulan|yap[ıi]l|eklen|doldurul)\p{L}*/iu,
  /(?<!\p{L})(?:ayr[ıi]nt[ıi]|detay)\p{L}* (?:sonra|doldur)\p{L}*/iu,
  /(?<!\p{L})(?:task|g[öo]rev) \d+(?:'\p{L}+)?(?: ile)? (?:benzer|gibi)(?!\p{L})/iu,
  /(?<!\p{L})uygun (?:bir )?hata (?:y[öo]netim|i[şs]le|ele al)\p{L}*/iu,
  /(?<!\p{L})(?:u[çc]|kenar|s[ıi]n[ıi]r) durum\p{L}* (?:ele al|i[şs]le)\p{L}*/iu,
]

export function vaguePhrase(text: string): string | undefined {
  for (const re of VAGUE_PHRASES) {
    const m = re.exec(text)
    if (m) return m[0].trim()
  }
  return undefined
}
