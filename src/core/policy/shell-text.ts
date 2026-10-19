export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export function withCd(dir: string, command: string): string {
  return `cd ${shellQuote(dir)}\n${command}`
}
