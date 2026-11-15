import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { which } from '../../../src/engine/proc'

// Pi runs extensions on Node, so the shim that stands in for Bun's APIs is run by a real Node.

const NODE = which('node')
const SHIM = join(import.meta.dir, '..', '..', '..', 'src', 'adapters', 'pi', 'runtime', 'bun-shim.ts')

const script = `
await import(${JSON.stringify(SHIM)})
const out = {}
out.global = typeof Bun
out.which = Bun.which('sh') !== null && Bun.which('definitely-not-a-program-x') === null
out.hash = new Bun.CryptoHasher('sha256').update('abc').digest('hex')
const sync = Bun.spawnSync(['sh', '-c', 'echo hi; exit 3'], { stdout: 'pipe', stderr: 'ignore' })
out.sync = [sync.exitCode, sync.success, new TextDecoder().decode(sync.stdout)]
const p = Bun.spawn(['sh', '-c', 'cat; echo err >&2'], { stdin: new TextEncoder().encode('from stdin'), stdout: 'pipe', stderr: 'pipe' })
out.async = [await p.exited, await new Response(p.stdout).text(), await new Response(p.stderr).text()]
const missing = Bun.spawn(['/nonexistent/x'], { stdout: 'pipe', stderr: 'pipe' })
out.missing = await missing.exited
const t0 = Date.now(); Bun.sleepSync(30); out.slept = Date.now() - t0 >= 25
try { Bun.TOML.parse('a = 1'); out.toml = 'parsed' } catch { out.toml = 'throws' }
console.log(JSON.stringify(out))
`

describe.skipIf(NODE === undefined)('the Bun stand-in under Node', () => {
  test('which, spawn, spawnSync, sleepSync and CryptoHasher behave as the engine code expects', async () => {
    const proc = Bun.spawn([NODE as string, '--input-type=module', '-e', script], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, err: err.replace(/\(node:\d+\)[^\n]*\n?|\(Use `node[^\n]*\n?|ExperimentalWarning[^\n]*\n?/g, '').trim() }).toEqual({ code: 0, err: '' })
    expect(JSON.parse(out.trim().split('\n').at(-1) as string)).toEqual({
      global: 'object', which: true, hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sync: [3, false, 'hi\n'], async: [0, 'from stdin', 'err\n'], missing: 127, slept: true, toml: 'throws',
    })
  })
})
