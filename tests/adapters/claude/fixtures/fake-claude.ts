import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

const state = process.env['FAKE_CLAUDE_STATE'] ?? '.'
mkdirSync(state, { recursive: true })
const args = process.argv.slice(2)
appendFileSync(join(state, 'calls.log'), args.join(' ') + '\n')

function load<T>(name: string, fallback: T): T {
  const p = join(state, name)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as T : fallback
}
function save(name: string, v: unknown): void {
  writeFileSync(join(state, name), JSON.stringify(v, null, 2))
}

interface Mkt { name: string, source: string, path?: string, repo?: string }
interface Plug { id: string, scope: string, enabled: boolean, version: string }

const fail = process.env['FAKE_CLAUDE_FAIL']
if (fail !== undefined && fail !== '' && args.join(' ').includes(fail)) { process.stderr.write('fake failure\n'); process.exit(1) }

const [a0, a1, a2, a3] = args
const mkts = load<Mkt[]>('marketplaces.json', [])
const plugs = load<Plug[]>('plugins.json', [])
const names = load<Record<string, string>>('names.json', {})

if (a0 === 'plugin' && a1 === 'marketplace') {
  if (a2 === 'list') { process.stdout.write(JSON.stringify(mkts, null, 2) + '\n'); process.exit(0) }
  if (a2 === 'add' && a3 !== undefined) {
    const isDir = isAbsolute(a3) && existsSync(a3) && statSync(a3).isDirectory()
    const name = isDir ? 'buracle' : (names[a3] ?? a3.split('/').pop() ?? a3)
    const entry: Mkt = isDir ? { name, source: 'directory', path: a3 } : { name, source: 'github', repo: a3 }
    const i = mkts.findIndex(m => m.name === name)
    if (i >= 0) mkts[i] = entry; else mkts.push(entry)
    save('marketplaces.json', mkts)
    process.stdout.write(`Successfully added marketplace: ${name}\n`)
    process.exit(0)
  }
  if (a2 === 'remove' && a3 !== undefined) {
    const i = mkts.findIndex(m => m.name === a3)
    if (i < 0) { process.stderr.write(`Marketplace '${a3}' not found\n`); process.exit(1) }
    mkts.splice(i, 1)
    save('marketplaces.json', mkts)
    save('plugins.json', plugs.filter(p => !p.id.endsWith(`@${a3}`)))
    process.exit(0)
  }
}
if (a0 === 'plugin') {
  if (a1 === 'list') { process.stdout.write(JSON.stringify(plugs, null, 2) + '\n'); process.exit(0) }
  if (a1 === 'install' && a2 !== undefined) {
    const mk = a2.split('@')[1]
    if (!mkts.some(m => m.name === mk)) { process.stderr.write(`marketplace ${mk} not found\n`); process.exit(1) }
    if (!plugs.some(p => p.id === a2)) plugs.push({ id: a2, scope: 'user', enabled: true, version: 'unknown' })
    save('plugins.json', plugs)
    process.exit(0)
  }
  if (a1 === 'uninstall' && a2 !== undefined) {
    const i = plugs.findIndex(p => p.id === a2)
    if (i < 0) { process.stderr.write(`Plugin "${a2}" not found\n`); process.exit(1) }
    plugs.splice(i, 1)
    save('plugins.json', plugs)
    process.exit(0)
  }
}
process.stderr.write(`fake claude: unsupported ${args.join(' ')}\n`)
process.exit(2)
