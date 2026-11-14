import { describe, expect, test } from 'bun:test'
import { mcpCatalogOf, validateMcpCatalog } from '../../src/core/catalog'

const base = { description: 'x', transport: 'http', url: 'https://x.example', pin: 'monitor', critical: false, routing: [] }

describe('mcp.yaml: which harnesses a server ships to', () => {
  test('every harness by default, in harness order; except leaves some out; harnesses names a few, as written', () => {
    const raw = {
      servers: {
        all: base,
        most: { ...base, except: ['omp'] },
        few: { ...base, harnesses: ['opencode', 'codex'] },
        listed: { ...base, harnesses: ['claude', 'codex', 'opencode', 'omp'] },
      },
    }
    expect(validateMcpCatalog(raw)).toEqual([])
    const { servers } = mcpCatalogOf(raw)
    expect(servers['all']?.harnesses).toEqual(['claude', 'codex', 'opencode', 'omp'])
    expect(servers['most']?.harnesses).toEqual(['claude', 'codex', 'opencode'])
    expect(servers['few']?.harnesses).toEqual(['opencode', 'codex'])
    expect(servers['listed']?.harnesses).toEqual(['claude', 'codex', 'opencode', 'omp'])
    expect(Object.keys(servers['most'] ?? {})).not.toContain('except')
    expect(Object.keys(servers['all'] ?? {})).toEqual(['description', 'transport', 'url', 'harnesses', 'pin', 'critical', 'routing'])
    expect(Object.keys(servers['most'] ?? {})).toEqual(['description', 'transport', 'url', 'harnesses', 'pin', 'critical', 'routing'])
    expect(raw.servers.most).toEqual({ ...base, except: ['omp'] })
  })

  test('except must name harnesses, once each, and leave one; it does not go with harnesses', () => {
    const errors = validateMcpCatalog({
      servers: {
        unknown: { ...base, except: ['vim'] },
        empty: { ...base, except: [] },
        twice: { ...base, except: ['omp', 'omp'] },
        none: { ...base, except: ['claude', 'codex', 'opencode', 'omp'] },
        both: { ...base, harnesses: ['claude'], except: ['omp'] },
      },
    })
    expect(errors).toEqual([
      'servers.unknown.except: expected a non-empty list of claude | codex | opencode | omp',
      'servers.empty.except: expected a non-empty list of claude | codex | opencode | omp',
      'servers.twice.except: duplicates',
      'servers.none.except: leaves no harness',
      'servers.both: name the harnesses a server ships to with harnesses or with except, not both',
    ])
  })

  test('harness_env names only harnesses the server ships to', () => {
    const stdio = { description: 'x', transport: 'stdio', package: { registry: 'npm', name: 'p', version: 'latest' }, pin: 'latest', critical: false, routing: [] }
    expect(validateMcpCatalog({ servers: { a: { ...stdio, harness_env: { omp: { A: '1' } } } } })).toEqual([])
    expect(validateMcpCatalog({ servers: { a: { ...stdio, except: ['omp'], harness_env: { omp: { A: '1' } } } } })).toEqual(['servers.a.harness_env.omp: not one of this server\'s harnesses'])
  })
})
