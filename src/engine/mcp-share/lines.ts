/**
 * Splits a byte stream of newline-delimited JSON-RPC (the MCP stdio framing) into lines. A multibyte
 * character that a chunk border cuts in two is kept whole; empty and blank lines are skipped.
 */
export class LineSplitter {
  private readonly decoder = new TextDecoder()
  private buf = ''

  push(chunk: Uint8Array | string): string[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    const out: string[] = []
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '')
      this.buf = this.buf.slice(nl + 1)
      if (line.trim() !== '') out.push(line)
    }
    return out
  }

  /** The rest of the stream: a last line that had no newline. */
  end(): string[] {
    this.buf += this.decoder.decode()
    const rest = this.buf.trim()
    this.buf = ''
    return rest === '' ? [] : [rest]
  }
}
