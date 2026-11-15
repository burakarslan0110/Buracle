import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BUILT } from '../helpers/built-harness'

// Buracle runs on macOS and native Linux. This scan keeps code that exists only so that Buracle runs on a Windows
// host out of the repository. A few guard files still name Windows places in the paths and code an agent writes.

const ROOT = join(import.meta.dir, '..', '..')

const MARKERS = /\bwin32\b|\bisWindows\b|windowsHide|windowsVerbatim|commandWindows|buracle\.cmd|\.(?:cmd|bat)['"`]|USERPROFILE|APPDATA|\bwinget\b|\bscoop\b|taskkill|tasklist|\bjunctions?\b/

// The guard files that read Windows commands and paths in agent input, each with its reason.
const GUARD_FILES: Readonly<Record<string, string>> = {
}

// The tests that name win32 to prove it has no effect.
const TEST_FILES: Readonly<Record<string, string>> = {
  'tests/engine/no-windows-host.test.ts': 'this scan',
  'tests/engine/platform.test.ts': 'BURACLE_PLATFORM=win32 gives the real platform',
  'tests/engine/canonical.test.ts': 'the tools catalog refuses platforms: [win32]',
}

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'fixtures') out.push(...files(p, ext)) }
    else if (ext.test(e.name)) out.push(p)
  }
  return out
}

const rel = (p: string): string => relative(ROOT, p).split('\\').join('/')
const hits = (dir: string, re: RegExp, ext: RegExp): string[] => files(join(ROOT, dir), ext).filter(f => re.test(readFileSync(f, 'utf8'))).map(rel).sort()

describe('no Windows host code', () => {
  test('src/ names Windows host markers only in the guard files that read agent input (R4)', () => {
    expect(hits('src', MARKERS, /\.(?:ts|tsx|js|mjs)$/)).toEqual(Object.keys(GUARD_FILES).sort())
    for (const reason of Object.values(GUARD_FILES)) expect(reason.length).toBeGreaterThan(20)
  })

  test('no test runs or skips because of a Windows host (R9)', () => {
    expect(hits('tests', /\bIS_WINDOWS\b|\bKEEPS_MODES\b|\bwin32\b/, /\.(?:ts|tsx)$/)).toEqual(Object.keys(TEST_FILES).sort())
  })

  test('the generated harness/ has no Windows shim and no Codex Windows command (R5)', () => {
    // harness/ is not committed: this is the tree the run built
    const built = (p: string): string => relative(BUILT.root, p).split('\\').join('/')
    expect(existsSync(join(BUILT.harness, 'claude', 'bin', 'buracle.cmd'))).toBe(false)
    expect(files(BUILT.harness, /./).map(built).filter(f => /\.cmd$/.test(f))).toEqual([])
    expect(files(BUILT.harness, /\.(?:json|toml|js|ts)$/).filter(f => /commandWindows/.test(readFileSync(f, 'utf8'))).map(built)).toEqual([])
  })

  test('the tools catalog has no Windows package manager and the pins no Windows download (R6)', () => {
    expect(readFileSync(join(ROOT, 'canonical', 'tools.yaml'), 'utf8')).not.toMatch(/^\s*(?:winget|scoop):/m)
    expect(readFileSync(join(ROOT, 'src', 'engine', 'toolchain', 'system-pins.ts'), 'utf8')).not.toMatch(/win32/)
  })

  test('the scan catches a marker in a new file', () => {
    expect(MARKERS.test("Bun.spawn(['ls'], { env: {}, windowsHide: true })")).toBe(true)
    expect(MARKERS.test("const conjunction = 'and'")).toBe(false)
    expect(MARKERS.test("const isWindowsPath = (p: string) => p")).toBe(false)
  })
})
