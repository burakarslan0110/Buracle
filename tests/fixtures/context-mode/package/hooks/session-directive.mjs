import { writeFileSync } from 'node:fs'

export function writeSessionEventsFile(events, eventsPath) {
  const lines = ['# Session Resume', '', `Events: ${events.length}`, '']
  let lastPrompt = ''
  for (const e of events) {
    if (e.category === 'prompt') { lastPrompt = e.data; continue }
    lines.push(`- ${e.category}: ${e.data}`)
  }
  if (lastPrompt) lines.push('', '## Last User Prompt', '', lastPrompt)
  writeFileSync(eventsPath, lines.join('\n'), 'utf-8')
  return { lastPrompt }
}
