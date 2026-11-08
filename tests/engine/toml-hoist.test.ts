import { describe, expect, test } from 'bun:test'
import { tomlParse } from '../../src/engine/merge'
import { tomlHoistDotted } from '../../src/engine/toml-hoist'

// The file herdr's Codex integration left behind: Buracle had written `features.memories` as a dotted root key, and herdr
// then appended a [features] table. TOML does not allow both, so Codex refused to start ("duplicate key").
const COLLIDED = `# my codex
model = "gpt-x"   # keep
features.memories = false # native memories stay off
agents.enabled = true

[tui]
a = 1

[projects."/work"]
trust_level = "trusted"

[features]
hooks = true
`

describe('tomlHoistDotted', () => {
  test('repairs a dotted root key that collides with a [table] header: its keys move into the table, everything else stays', () => {
    expect(() => tomlParse(COLLIDED)).toThrow()
    const out = tomlHoistDotted(COLLIDED, ['features', 'agents'])
    expect(tomlParse(out)).toEqual({
      model: 'gpt-x', tui: { a: 1 }, projects: { '/work': { trust_level: 'trusted' } },
      features: { hooks: true, memories: false }, agents: { enabled: true },
    })
    expect(out).toBe(`# my codex
model = "gpt-x"   # keep

[tui]
a = 1

[projects."/work"]
trust_level = "trusted"

[features]
hooks = true
memories = false # native memories stay off

[agents]
enabled = true
`)
  })

  test('only the tables it is asked about move; no change returns the very same text; the result is stable', () => {
    expect(tomlHoistDotted(COLLIDED, [])).toBe(COLLIDED)
    expect(tomlHoistDotted('a = 1\n\n[tui]\nx = 1\n', ['features'])).toBe('a = 1\n\n[tui]\nx = 1\n')
    const once = tomlHoistDotted(COLLIDED, ['features', 'agents'])
    expect(tomlHoistDotted(once, ['features', 'agents'])).toBe(once)
    // A valid file with a dotted key and no header also moves into a table: nothing can collide with it afterwards.
    expect(tomlHoistDotted('model = "x"\nfeatures.memories = false\n', ['features'])).toBe('model = "x"\n\n[features]\nmemories = false\n')
    // Another dotted key that collides with its own header is not this call's business; the file stays invalid, so it throws.
    expect(() => tomlHoistDotted(COLLIDED, ['agents'])).toThrow(/not valid TOML/)
  })

  test('keeps a CRLF file CRLF, and refuses when the table already holds the same key', () => {
    const crlf = COLLIDED.replace(/\n/g, '\r\n')
    const out = tomlHoistDotted(crlf, ['features', 'agents'])
    expect(/(^|[^\r])\n/.test(out)).toBe(false)
    expect(tomlParse(out)).toEqual(tomlParse(tomlHoistDotted(COLLIDED, ['features', 'agents'])))
    expect(() => tomlHoistDotted('features.hooks = false\n\n[features]\nhooks = true\n', ['features'])).toThrow(/hooks/)
  })

  test('keeps a file that ends without a newline, and the tables a key moves out of keep their other keys', () => {
    expect(tomlHoistDotted('a = 1\nfeatures.x = 2', ['features'])).toBe('a = 1\n\n[features]\nx = 2')
    expect(tomlHoistDotted('features.x = 2\n\n[features]\ny = 3', ['features'])).toBe('\n[features]\ny = 3\nx = 2')
  })
})
