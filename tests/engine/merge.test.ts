import { describe, expect, test } from 'bun:test'
import {
  getIn, jsoncGet, jsoncParse, jsoncSet, mdBlockGet, mdBlockRemove, mdBlockUpsert, parseKeyPath, stableStringify,
  tomlParse, tomlPatchTables, tomlRemove, tomlValue, valueHash, withoutValueAt, withValueAt, yamlAliasAt, yamlGet, yamlLayout, yamlParse, yamlSet,
} from '../../src/engine/merge'

describe('key paths and hashing', () => {
  test('parseKeyPath', () => {
    expect(parseKeyPath('a.b-c.d_e')).toEqual(['a', 'b-c', 'd_e'])
    expect(parseKeyPath('mcp_servers."buracle.memory".env')).toEqual(['mcp_servers', 'buracle.memory', 'env'])
    expect(parseKeyPath("a.'x y'")).toEqual(['a', 'x y'])
    expect(parseKeyPath(['a', 0, 'b'])).toEqual(['a', 0, 'b'])
    for (const bad of ['', 'a..b', 'a.', '"open', 'a."b"c']) expect(() => parseKeyPath(bad)).toThrow()
  })
  test('stable hashing ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}')
    expect(valueHash({ x: 1, y: 2 })).toBe(valueHash({ y: 2, x: 1 }))
    expect(getIn({ a: [{ b: 1 }] }, ['a', '0', 'b'])).toEqual({ found: true, value: 1 })
    expect(getIn({ a: 1 }, ['a', 'b'])).toEqual({ found: false, value: undefined })
  })
})

const CODEX = `# Codex config (user)
model = "gpt-6.1-sol"   # keep my model

[tui]
status_line = ["model-with-reasoning"]

# My own server
[mcp_servers.mine]
command = "my-mcp"
args = [
  "--flag", # multi-line array with a comment
  "x",
]

[mcp_servers.context7]
command = "old"
# old note
args = ["old"]

# comment that belongs to [profiles.work]
[profiles.work]
model = "o9"
`

describe('tomlPatchTables', () => {
  test('replaces one table body and leaves every other byte alone', () => {
    const out = tomlPatchTables(CODEX, { 'mcp_servers.context7': { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.2.0'] } })
    expect(out).toBe(CODEX.replace('command = "old"\n# old note\nargs = ["old"]\n', 'command = "npx"\n# old note\nargs = ["-y", "@upstash/context7-mcp@4.2.0"]\n'))
    expect(tomlParse(out)['mcp_servers']).toEqual({
      mine: { command: 'my-mcp', args: ['--flag', 'x'] },
      context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp@4.2.0'] },
    })
  })

  test('creates missing tables at the end, with nested values as inline tables', () => {
    const out = tomlPatchTables(CODEX, {
      'mcp_servers.buracle-memory': { command: '/h/.buracle/bin/buracle', args: ['mcp', 'memory'], env_vars: ['API_KEY'], env: { MODE: 'stdio', N: 3 } },
    })
    expect(out.startsWith(CODEX)).toBe(true)
    expect(out.slice(CODEX.length)).toBe('\n[mcp_servers.buracle-memory]\ncommand = "/h/.buracle/bin/buracle"\nargs = ["mcp", "memory"]\nenv_vars = ["API_KEY"]\nenv = { MODE = "stdio", N = 3 }\n')
    expect(getIn(tomlParse(out), ['mcp_servers', 'buracle-memory', 'env'])).toEqual({ found: true, value: { MODE: 'stdio', N: 3 } })
  })

  test('is idempotent', () => {
    const tables = { 'mcp_servers.context7': { command: 'npx' }, 'tools.update_plan': { enabled: true } }
    const once = tomlPatchTables(CODEX, tables, { 'tui.status_line': ['model-with-reasoning', 'context-used'] })
    expect(tomlPatchTables(once, tables, { 'tui.status_line': ['model-with-reasoning', 'context-used'] })).toBe(once)
  })

  test('sets keys in place, inside the deepest existing table, or at the root', () => {
    const out = tomlPatchTables(CODEX, {}, {
      model: 'gpt-x',
      'tui.status_line': ['a', 'b'],
      'tui.terminal_title': ['project-name'],
      'features.hooks': true,
    })
    expect(out).toContain('model = "gpt-x"   # keep my model\nfeatures.hooks = true\n\n[tui]\nstatus_line = ["a", "b"]\nterminal_title = ["project-name"]\n')
    const parsed = tomlParse(out)
    expect(parsed['features']).toEqual({ hooks: true })
    expect(parsed['tui']).toEqual({ status_line: ['a', 'b'], terminal_title: ['project-name'] })
  })

  test('root keys go before the comment block of the first table when the root has no keys', () => {
    const text = '# header comment\n\n# about tui\n[tui]\nx = 1\n'
    expect(tomlPatchTables(text, {}, { approval: 'never' })).toBe('# header comment\n\napproval = "never"\n\n# about tui\n[tui]\nx = 1\n')
    expect(tomlPatchTables('', {}, { a: 1 })).toBe('a = 1\n')
    expect(tomlPatchTables('', { t: { k: 'v' } })).toBe('[t]\nk = "v"\n')
  })

  test('replacing a table drops its sub-tables (their content is part of the value)', () => {
    const text = '[s.x]\na = 1\n\n[s.x.env]\nK = "v"\n\n[other]\nb = 2\n'
    const out = tomlPatchTables(text, { 's.x': { a: 2, env: { K: 'w' } } })
    expect(tomlParse(out)).toEqual({ s: { x: { a: 2, env: { K: 'w' } } }, other: { b: 2 } })
    expect(out).toContain('[other]\nb = 2\n')
  })

  test('multi-line strings and quoted keys in untouched tables survive', () => {
    const text = '[a]\ns = """\nline [not.a.header]\n"""\n"quoted key" = 1\n\n[b]\nx = 1\n'
    const out = tomlPatchTables(text, { b: { x: 2 } })
    expect(out).toBe('[a]\ns = """\nline [not.a.header]\n"""\n"quoted key" = 1\n\n[b]\nx = 2\n')
    const tricky = "[a]\ns = \"\"\"esc \\\"\"\" still\n[x]\nnot = 'a header'\"\"\"\nlit = '''raw \\''''\n\n[b]\nx = 1\n"
    expect(tomlParse(tricky)['a']).toEqual({ s: 'esc """ still\n[x]\nnot = \'a header\'', lit: "raw \\'" })
    expect(tomlPatchTables(tricky, { b: { x: 3 } })).toBe(tricky.replace('x = 1', 'x = 3'))
  })

  test('CRLF files are patched without breaking their line endings elsewhere', () => {
    const text = '# c\r\n[a]\r\nx = 1\r\n\r\n[b]\r\ny = 2\r\n'
    const out = tomlPatchTables(text, { a: { x: 5 } }, { 'b.z': 'new' })
    expect(tomlParse(out)).toEqual({ a: { x: 5 }, b: { y: 2, z: 'new' } })
    expect(out).toBe('# c\r\n[a]\r\nx = 5\r\n\r\n[b]\r\ny = 2\r\nz = "new"\r\n')
    expect(yamlSet('a: 1\r\nb: 2\r\n', 'c', 3)).toBe('a: 1\r\nb: 2\r\nc: 3\r\n')
    expect(mdBlockUpsert('# t\r\n', 'x', 'y')).toBe('# t\r\n\r\n<!-- buracle:x:start -->\r\ny\r\n<!-- buracle:x:end -->\r\n')
  })

  test('refuses what it cannot patch safely', () => {
    expect(() => tomlPatchTables('a = [1,', { t: { x: 1 } })).toThrow(/not valid TOML/)
    expect(() => tomlPatchTables('[[arr]]\nx = 1\n', { arr: { x: 2 } })).toThrow(/array of tables/)
    expect(() => tomlPatchTables('[mcp_servers]\ncontext7.command = "x"\n', { 'mcp_servers.context7': { command: 'y' } })).toThrow(/not valid TOML/)
    expect(() => tomlPatchTables('a = { b = 1 }\n', {}, { 'a.c': 2 })).toThrow(/not valid TOML/)
  })

  test('value writer round-trips through the TOML parser', () => {
    const value = { s: 'quote " back \\ tab \t nl \n unicode ğüşıöç \u0001', i: 42, f: 1.5, neg: -3, b: false, arr: [1, 'two', true], nested: { k: [{ a: 1 }] } }
    const out = tomlPatchTables('', { t: value })
    expect(tomlParse(out)).toEqual({ t: value })
    expect(tomlValue(Infinity)).toBe('inf')
    expect(tomlValue(NaN)).toBe('nan')
    expect(() => tomlValue([null])).toThrow()
    expect(() => tomlValue(null)).toThrow()
  })

  test('null/undefined entries are skipped', () => {
    expect(tomlPatchTables('', { t: { a: 1, b: undefined, c: null } })).toBe('[t]\na = 1\n')
  })
})

describe('tomlRemove', () => {
  test('removes tables with their sub-tables and keys, keeping the rest', () => {
    const once = tomlPatchTables(CODEX, { 'mcp_servers.buracle-memory': { command: 'b' } }, { 'tui.terminal_title': ['x'] })
    const back = tomlRemove(once, { tables: ['mcp_servers.buracle-memory'], keys: ['tui.terminal_title'] })
    expect(back).toBe(CODEX)
    expect(tomlRemove(CODEX, { tables: ['nope'], keys: ['also.nope'] })).toBe(CODEX)
  })
})

describe('jsoncSet', () => {
  const TEXT = '{\n  // user comment\n  "theme": "dark", /* inline */\n  "nested": { "keep": 1 },\n}\n'

  test('sets nested keys and preserves comments', () => {
    const out = jsoncSet(TEXT, 'mcp.servers.context7', { command: ['npx'], codemode: false })
    expect(out).toContain('// user comment')
    expect(out).toContain('/* inline */')
    expect(jsoncGet(out, 'mcp.servers.context7')).toEqual({ found: true, value: { command: ['npx'], codemode: false } })
    expect(jsoncGet(out, 'theme')).toEqual({ found: true, value: 'dark' })
    expect(out.endsWith('\n')).toBe(true)
  })

  test('replaces and removes values', () => {
    const out = jsoncSet(TEXT, 'nested.keep', 2)
    expect(jsoncGet(out, 'nested')).toEqual({ found: true, value: { keep: 2 } })
    const removed = jsoncSet(out, ['nested', 'keep'], undefined)
    expect(jsoncGet(removed, 'nested')).toEqual({ found: true, value: {} })
    expect(removed).toContain('// user comment')
  })

  test('empty text becomes an object; indentation is detected', () => {
    expect(JSON.parse(jsoncSet('', 'a.b', true))).toEqual({ a: { b: true } })
    const four = '{\n    "a": 1\n}\n'
    expect(jsoncSet(four, 'b', 2)).toBe('{\n    "a": 1,\n    "b": 2\n}\n')
    const tabs = '{\n\t"a": 1\n}\n'
    expect(jsoncSet(tabs, 'b', 2)).toBe('{\n\t"a": 1,\n\t"b": 2\n}\n')
  })

  test('refuses unparsable text', () => {
    expect(() => jsoncSet('{ "a": ', 'b', 1)).toThrow(/unparsable/)
    expect(jsoncParse('{ "a": ').ok).toBe(false)
    expect(jsoncParse('{ "a": 1, } // ok').ok).toBe(true)
  })

  test('refuses to cross a non-object', () => {
    expect(() => jsoncSet('{"a": "str"}', 'a.b', 1)).toThrow()
  })
})

describe('yamlSet', () => {
  const TEXT = '# OMP config (user)\nstatusLine:\n  preset: default # inline note\ntools:\n  # approval tier\n  approvalMode: ask\nlist: [a, b]\n'

  test('preserves comments and untouched nodes', () => {
    const out = yamlSet(TEXT, 'tools.approvalMode', 'write')
    expect(out).toBe(TEXT.replace('approvalMode: ask', 'approvalMode: write'))
  })

  test('creates nested maps and deletes keys', () => {
    const out = yamlSet(TEXT, 'memory.backend', 'off')
    expect(yamlGet(out, 'memory')).toEqual({ found: true, value: { backend: 'off' } })
    expect(out).toContain('# approval tier')
    const removed = yamlSet(out, 'memory.backend', undefined)
    expect(yamlGet(removed, 'memory.backend').found).toBe(false)
  })

  test('empty documents and long strings', () => {
    expect(yamlSet('', 'a.b', 1)).toBe('a:\n  b: 1\n')
    const long = 'x '.repeat(80).trim()
    const out = yamlSet('k: v\n', 'long', long)
    expect(out).toBe(`k: v\nlong: ${long}\n`)
  })

  test('refuses unparsable YAML and scalar roots', () => {
    expect(() => yamlSet('a: [1, 2\nb: 3\n', 'c', 1)).toThrow(/unparsable YAML/)
    expect(() => yamlSet('just a string\n', 'c', 1)).toThrow(/scalar/)
  })
})

describe('yamlSet keeps the existing formatting', () => {
  const USER = '# my omp settings\ntheme:\n  dark: titanium # I like this one\nstatusLine:\n  separator: pipe # keep pipes\nlist: [ x,  y ]   # padded\n'

  test('surgical: a scalar keeps its quoting; inside a flow map the padding stays', () => {
    const text = 'servers:\n  c7:\n    package: { registry: npm, name: "@upstash/context7-mcp", version: 4.2.0 }   # pinned\n  o:\n    v: "1.0.0" # q\n    w: \'it\'\'s\'\n'
    expect(yamlSet(text, 'servers.c7.package.version', '4.3.0')).toBe(text.replace('version: 4.2.0 }', 'version: 4.3.0 }'))
    expect(yamlSet(text, 'servers.o.v', '1.1.0')).toBe(text.replace('"1.0.0"', '"1.1.0"'))
    expect(yamlSet(text, 'servers.o.w', "x'y")).toBe(text.replace("'it''s'", "'x''y'"))
    expect(yamlGet(yamlSet(text, 'servers.c7.package.version', '1.10'), 'servers.c7.package.version').value).toBe('1.10')
    expect(yamlSet('p: { a: x, b: y }\n', 'p.a', 'q, r')).toBe('p: { a: "q, r", b: y }\n')
  })

  test('surgical: new keys go after the last pair of their map; untouched lines stay byte for byte', () => {
    let t = USER
    for (const [k, v] of [['statusLine.preset', 'custom'], ['statusLine.leftSegments', ['model', 'path']], ['memory.backend', 'off'], ['enabledProviders', []]] as const) t = yamlSet(t, k, v)
    expect(t).toBe('# my omp settings\ntheme:\n  dark: titanium # I like this one\nstatusLine:\n  separator: pipe # keep pipes\n  preset: custom\n  leftSegments:\n    - model\n    - path\nlist: [ x,  y ]   # padded\nmemory:\n  backend: off\nenabledProviders: []\n')
    const replaced = yamlSet(t, 'statusLine.leftSegments', ['git'])
    expect(replaced).toBe(t.replace('  leftSegments:\n    - model\n    - path\n', '  leftSegments:\n    - git\n'))
    let u = t
    for (const k of ['enabledProviders', 'memory', 'statusLine.leftSegments', 'statusLine.preset']) u = yamlSet(u, k, undefined)
    expect(u).toBe(USER)
  })

  test("surgical: new keys follow the document's indent and sequence style; `key:` without a value becomes a map", () => {
    expect(yamlSet('a:\n    b: 1\n', 'a.c.d', 'x')).toBe('a:\n    b: 1\n    c:\n        d: x\n')
    expect(yamlSet('x:\n- a\n- b\n', 'y', ['c', 'd'])).toBe('x:\n- a\n- b\ny:\n- c\n- d\n')
    expect(yamlSet('a:\nb: 1\n', 'a.c', 1)).toBe('a:\n  c: 1\nb: 1\n')
    expect(yamlSet('a: 1', 'b', 2)).toBe('a: 1\nb: 2')
    expect(yamlSet('# only a comment\n', 'a', 1)).toBe('# only a comment\na: 1\n')
    expect(yamlSet('a:\n  b: 1\n', 'a.c', 'line1\nline2')).toBe('a:\n  b: 1\n  c: |-\n    line1\n    line2\n')
    expect(yamlSet('a: |\n  x\n  y\nb: 1\n', 'a', 'z')).toBe('a: z\nb: 1\n')
    expect(yamlSet('a: 1\n', '1', 'x')).toBe('a: 1\n"1": x\n')
    expect(yamlSet('a: 1\r\nb:\r\n  c: 2\r\n', 'b.d', [1, 2])).toBe('a: 1\r\nb:\r\n  c: 2\r\n  d:\r\n    - 1\r\n    - 2\r\n')
    expect(yamlSet('a: 1\n', 'a', undefined)).toBe('')
  })

  test('Document API fallback (flow maps, a nested map losing its last key) re-serializes in the detected layout', () => {
    expect(yamlSet('a: { b: 1 }\nc: [ 1 ]\n', 'a.d', 2)).toBe('a: { b: 1, d: 2 }\nc: [ 1 ]\n')
    expect(yamlSet('a: {b: 1}\nc: [1]\n', 'a.d', 2)).toBe('a: {b: 1, d: 2}\nc: [1]\n')
    expect(yamlSet('x: [ 1 ]\nmemory:\n  backend: off\n', 'memory.backend', undefined)).toBe('x: [ 1 ]\nmemory: {}\n')
  })

  test('edits that would change other values are refused', () => {
    expect(() => yamlSet('k: &anc v\nr: *anc\n', 'k', 'w')).toThrow(/would change other values/)
    expect(() => yamlSet('a: 1\n', 'a.b', 2)).toThrow()
  })

  test('yamlLayout detects indent, sequence style and flow padding', () => {
    expect(yamlLayout('a:\n    b: 1\nl:\n- x\nf: {a: 1}\n')).toEqual({ indent: 4, indentSeq: false, flowCollectionPadding: false })
    expect(yamlLayout('a:\n  b: 1\nl:\n  - x\nf: { a: 1 }\n')).toEqual({ indent: 2, indentSeq: true, flowCollectionPadding: true })
    expect(yamlLayout('')).toEqual({ indent: 2, indentSeq: true, flowCollectionPadding: true })
    expect(yamlParse(yamlSet('', 'a', { b: [1] }))).toEqual({ a: { b: [1] } })
  })

  test('yamlAliasAt names the anchor of a value that is an alias, and nothing else', () => {
    const text = 'mode: &m ask\ntools:\n  approvalMode: *m\n  bash: { timeout: 1 }\nother: *m\n'
    expect(yamlAliasAt(text, ['tools', 'approvalMode'])).toBe('m')
    expect(yamlAliasAt(text, ['other'])).toBe('m')
    expect(yamlAliasAt(text, ['mode'])).toBeUndefined()
    expect(yamlAliasAt(text, ['tools', 'bash', 'timeout'])).toBeUndefined()
    expect(yamlAliasAt(text, ['tools', 'missing'])).toBeUndefined()
    expect(yamlAliasAt('a: [1, 2\n', ['a'])).toBeUndefined()
  })
})

describe('withValueAt / withoutValueAt', () => {
  test('copy, set and delete without touching the input', () => {
    const root = { a: { b: [1, 2] }, c: 1 }
    expect(withValueAt(root, ['a', 'x', 'y'], 3)).toEqual({ a: { b: [1, 2], x: { y: 3 } }, c: 1 })
    expect(withValueAt(root, ['a', 'b', '1'], 9)).toEqual({ a: { b: [1, 9] }, c: 1 })
    expect(withValueAt(root, ['c', 'd'], 1)).toBeUndefined()
    expect(withoutValueAt(root, ['a', 'b', '0'])).toEqual({ a: { b: [2] }, c: 1 })
    expect(withoutValueAt(root, ['nope', 'x'])).toEqual(root)
    expect(root).toEqual({ a: { b: [1, 2] }, c: 1 })
  })
})

describe('jsoncSet on array elements', () => {
  test('removing an element never merges its neighbours (jsonc-parser 3.3.1 does for the last one)', () => {
    expect(jsoncSet('[1, 2]', [1], undefined)).toBe('[1]')
    expect(jsoncSet('[1, 2]', [0], undefined)).toBe('[2]')
    expect(jsoncSet('{"a":[1,2,3]}', ['a', 2], undefined)).toBe('{"a":[1,2]}')
    expect(jsoncSet('{\n  "a": [\n    1\n  ]\n}\n', ['a', 0], undefined)).toBe('{\n  "a": []\n}\n')
    expect(jsoncSet('{ "a": [1, 2,] }', ['a', 1], undefined)).toBe('{ "a": [1,] }')
    expect(jsoncParse(jsoncSet('{\n  "a": [\n    1 // c\n  ]\n}\n', ['a', 0], undefined))).toEqual({ ok: true, value: { a: [] } })
  })

  test('replace in place and append (-1)', () => {
    const t = '{\n  "a": [\n    1,\n    2\n  ]\n}\n'
    expect(jsoncSet(t, ['a', 0], 5)).toBe('{\n  "a": [\n    5,\n    2\n  ]\n}\n')
    expect(jsoncSet(t, ['a', -1], 3)).toBe('{\n  "a": [\n    1,\n    2,\n    3\n  ]\n}\n')
  })
})

describe('Markdown blocks', () => {
  const S = '<!-- buracle:rules:start -->'
  const E = '<!-- buracle:rules:end -->'

  test('insert into empty text and append after existing content', () => {
    expect(mdBlockUpsert('', 'rules', 'hello')).toBe(`${S}\nhello\n${E}\n`)
    expect(mdBlockUpsert('# Mine\n', 'rules', 'hello\n\n')).toBe(`# Mine\n\n${S}\nhello\n${E}\n`)
    expect(mdBlockUpsert('# Mine', 'rules', 'hello')).toBe(`# Mine\n\n${S}\nhello\n${E}`)
    expect(mdBlockRemove(mdBlockUpsert('# Mine', 'rules', 'hello'), 'rules')).toBe('# Mine')
  })

  test('replace in place, idempotent, and get', () => {
    const text = `# Mine\n\n${S}\nold\n${E}\n\n## After\n`
    const out = mdBlockUpsert(text, 'rules', 'new\nlines')
    expect(out).toBe(`# Mine\n\n${S}\nnew\nlines\n${E}\n\n## After\n`)
    expect(mdBlockUpsert(out, 'rules', 'new\nlines')).toBe(out)
    expect(mdBlockGet(out, 'rules')).toBe('new\nlines')
    expect(mdBlockGet(out, 'other')).toBeUndefined()
  })

  test('remove restores the original text', () => {
    for (const original of ['', '# Mine\n', '# Mine\n\nmore\n']) {
      expect(mdBlockRemove(mdBlockUpsert(original, 'rules', 'x'), 'rules')).toBe(original)
    }
    expect(mdBlockRemove('nothing here\n', 'rules')).toBe('nothing here\n')
  })

  test('two blocks coexist', () => {
    const a = mdBlockUpsert('', 'one', '1')
    const b = mdBlockUpsert(a, 'two', '2')
    expect(mdBlockGet(b, 'one')).toBe('1')
    expect(mdBlockGet(b, 'two')).toBe('2')
    expect(mdBlockRemove(b, 'two')).toBe(a)
  })

  test('malformed markers and self-referencing content are refused', () => {
    expect(() => mdBlockGet(`${S}\nno end\n`, 'rules')).toThrow(/malformed/)
    expect(() => mdBlockUpsert(`${E}\n${S}\n`, 'rules', 'x')).toThrow(/malformed/)
    expect(() => mdBlockUpsert(`${S}\n${E}\n${S}\n${E}\n`, 'rules', 'x')).toThrow(/malformed/)
    expect(() => mdBlockUpsert('', 'rules', `sneaky ${E}`)).toThrow(/markers/)
    expect(() => mdBlockUpsert('', 'bad id', 'x')).toThrow(/invalid block id/)
  })

  test('CRLF content is normalized', () => {
    expect(mdBlockUpsert('', 'rules', 'a\r\nb\r\n')).toBe(`${S}\na\nb\n${E}\n`)
  })
})
