const WRITE_PATH_KEYS: ReadonlySet<string> = new Set([
  'path', 'filepath', 'filename', 'outputpath', 'outputfile', 'outpath', 'outfile', 'savepath', 'savefile', 'saveto',
  'destination', 'dest', 'destpath', 'targetpath', 'outputdir', 'outputdirpath', 'outputdirectory', 'savedir', 'downloadpath',
])

const READ_ONLY_SERVERS: ReadonlySet<string> = new Set(['codegraph', 'semble', 'context7', 'grep', 'web-search'])

const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['chrome-devtools/upload_file'])

function keyOf(k: string): string {
  return k.toLowerCase().replace(/[_-]/g, '')
}

function plain(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
}

function mcpParts(tool: string): { server: string, tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  if (!m || m[1] === undefined || m[2] === undefined) return undefined
  return { server: m[1].replace(/^plugin_[^_]+_/, ''), tool: m[2] }
}

export function mcpWritePaths(tool: string, input: Record<string, unknown>, mcp?: { server: string, tool: string }): string[] {
  const given = mcp !== null && typeof mcp === 'object' && typeof mcp.server === 'string' && typeof mcp.tool === 'string' && mcp.server !== '' ? mcp : undefined
  if (given === undefined && (typeof tool !== 'string' || !tool.startsWith('mcp__'))) return []
  const parts = given ?? mcpParts(tool)
  if (parts !== undefined) {
    const server = parts.server.toLowerCase().replace(/^plugin_[^_]+_/, '')
    if (READ_ONLY_SERVERS.has(server) || READ_ONLY_TOOLS.has(`${server}/${parts.tool.toLowerCase()}`)) return []
  }
  const out: string[] = []
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim() !== '' && !out.includes(v)) out.push(v)
  }
  const scan = (o: Record<string, unknown>, depth: number): void => {
    for (const [k, v] of Object.entries(o)) {
      if (WRITE_PATH_KEYS.has(keyOf(k))) add(v)
      else if (depth === 0) {
        const inner = plain(v)
        if (inner !== undefined) scan(inner, 1)
      }
    }
  }
  const top = plain(input)
  if (top !== undefined) scan(top, 0)
  return out
}
