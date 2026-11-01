// Runs beautiful-mermaid inside a Bun Worker. Its text renderer can loop forever on large drawings
// (a flowchart chain of about 25 boxes), so src/workflow/diagram.ts gives every job a time limit and
// terminates this worker when the limit passes. Nothing else imports the library.
import type { DiagramJob, WorkerReply } from './diagram'

declare var self: Worker

// The review page's colors (src/memory/ui/tokens.css): dark is the default theme, light the other.
const THEMES = {
  light: { bg: '#f4f5f9', fg: '#111827', accent: '#0284c7', transparent: true, font: 'system-ui' },
  dark: { bg: '#05060a', fg: '#e7edf5', accent: '#7dd3fc', transparent: true, font: 'system-ui' },
} as const

type Library = typeof import('beautiful-mermaid')
let library: Promise<Library> | undefined

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

self.onmessage = async (event: MessageEvent<DiagramJob>) => {
  const job = event.data
  let lib: Library
  try {
    library ??= import('beautiful-mermaid')
    lib = await library
  } catch (err) {
    const reply: WorkerReply = { id: job.id, ok: false, reason: 'worker', error: `cannot load beautiful-mermaid: ${message(err)}` }
    self.postMessage(reply)
    return
  }
  let reply: WorkerReply
  try {
    reply = job.kind === 'text'
      ? { id: job.id, ok: true, kind: 'text', text: lib.renderMermaidASCII(job.source, { useAscii: job.ascii, colorMode: 'none' }) }
      : { id: job.id, ok: true, kind: 'svg', light: lib.renderMermaidSVG(job.source, THEMES.light), dark: lib.renderMermaidSVG(job.source, THEMES.dark) }
  } catch (err) {
    reply = { id: job.id, ok: false, reason: 'invalid', error: message(err) }
  }
  self.postMessage(reply)
}
