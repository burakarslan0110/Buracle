// The "detected" block an older Buracle kept current inside a core page. Nothing writes it any more; a page that
// still carries one keeps it, and an export or import treats the text around it as the page's own.

export const DETECTED_OPEN = '<!-- buracle:detected:start -->'
export const DETECTED_CLOSE = '<!-- buracle:detected:end -->'

export function withDetectedBlock(body: string, block: string): string {
  const start = body.indexOf(DETECTED_OPEN)
  const end = start >= 0 ? body.indexOf(DETECTED_CLOSE, start) : -1
  if (start >= 0 && end > start) {
    const before = body.slice(0, start).trimEnd()
    const after = body.slice(end + DETECTED_CLOSE.length).trimStart()
    return [before, block, after].filter(s => s !== '').join('\n\n')
  }
  if (block === '') return body
  return body.trim() === '' ? block : `${body.trimEnd()}\n\n${block}`
}

export function detectedBlockOf(body: string): string {
  const start = body.indexOf(DETECTED_OPEN)
  const end = start >= 0 ? body.indexOf(DETECTED_CLOSE, start) : -1
  return start >= 0 && end > start ? body.slice(start, end + DETECTED_CLOSE.length) : ''
}

export function coreHumanPart(body: string): string {
  return withDetectedBlock(body, '').trim()
}
