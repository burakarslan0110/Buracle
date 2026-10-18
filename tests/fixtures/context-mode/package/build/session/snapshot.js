function escape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function buildResumeSnapshot(events, opts) {
  const searchTool = opts?.searchTool ?? 'ctx_search'
  const lines = [`<session_resume events="${events.length}" compact_count="${opts?.compactCount ?? 1}">`]
  for (const e of events) lines.push(`  <${e.category}>${escape(e.data)}</${e.category}>`)
  lines.push(`  ${searchTool}(queries: ["..."], source: "session-events")`)
  lines.push('</session_resume>')
  return lines.join('\n')
}
