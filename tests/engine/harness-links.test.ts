import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { harnessLinks } from '../../src/engine/toolchain/links'
import { withSandbox } from '../helpers/sandbox'

// omp installed with `bun add -g` sits in ~/.bun/bin, which no shell of the user has on PATH (Homebrew's bun does not add
// it). The doctor still found it there and said "ok", so the install looked fine while typing `omp` printed
// "command not found". The install now links such a program into ~/.local/bin, the folder it already puts on PATH.
const file = (p: string): string => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, '#!/bin/sh\n'); return p }

describe('harnessLinks', () => {
  test('a harness program that PATH does not reach gets a link in ~/.local/bin; one that PATH finds gets none', () => withSandbox(({ home }) => {
    const omp = file(join(home, '.bun', 'bin', 'omp'))
    const codex = file(join(home, 'apps', 'codex'))
    const found = [
      { harness: 'omp', included: true, path: omp },
      { harness: 'codex', included: true, path: codex },
    ]
    const none = () => undefined
    expect(harnessLinks(found, '/usr/bin', none)).toEqual([
      { bin: 'omp', path: join(paths.localBinDir(), 'omp'), target: omp },
      { bin: 'codex', path: join(paths.localBinDir(), 'codex'), target: codex },
    ])
    expect(harnessLinks(found, '/usr/bin', bin => (bin === 'codex' ? codex : undefined)).map(l => l.bin)).toEqual(['omp'])
    expect(harnessLinks(found, '/usr/bin', bin => `/usr/bin/${bin}`)).toEqual([])
  }))

  test('nothing is linked for a harness that is off or not installed, for a program already in ~/.local/bin, for a missing file or an odd name', () => withSandbox(({ home }) => {
    const omp = file(join(home, '.bun', 'bin', 'omp'))
    const inLocal = file(join(paths.localBinDir(), 'claude'))
    const none = () => undefined
    expect(harnessLinks([{ harness: 'omp', included: false, path: omp }], '', none)).toEqual([])
    expect(harnessLinks([{ harness: 'omp', included: true }], '', none)).toEqual([])
    expect(harnessLinks([{ harness: 'claude', included: true, path: inLocal }], '', none)).toEqual([])
    expect(harnessLinks([{ harness: 'omp', included: true, path: join(home, '.bun', 'bin', 'gone') }], '', none)).toEqual([])
    const odd = file(join(home, 'bin', 'o m p; rm'))
    expect(harnessLinks([{ harness: 'omp', included: true, path: odd }], '', none)).toEqual([])
  }))

  test('only a program in the user\'s own folders is linked: one in a system folder (/opt/homebrew/bin, say) is on the real PATH of the login shell, and a link first on PATH would pin it past a version manager', () => withSandbox(({ root }) => {
    const system = file(join(root, 'system-bin', 'opencode'))
    expect(harnessLinks([{ harness: 'opencode', included: true, path: system }], '/usr/bin', () => undefined)).toEqual([])
  }))

  test('PATH is read from the PATH it is given, and a link to the same program is not asked for twice', () => withSandbox(({ home }) => {
    const omp = file(join(home, '.bun', 'bin', 'omp'))
    const seen: string[] = []
    const out = harnessLinks([{ harness: 'omp', included: true, path: omp }, { harness: 'omp', included: true, path: omp }], '/a:/b', (bin, PATH) => { seen.push(`${bin}@${PATH}`); return undefined })
    expect(out).toHaveLength(1)
    expect(seen[0]).toBe('omp@/a:/b')
  }))
})
