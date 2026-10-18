import { describe, expect, test } from 'bun:test'
import { cpSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handle, UI_ASSETS, uiContext, type UiContext } from '../../src/memory/ui'
import { withSandbox } from '../helpers/sandbox'

const UI_DIR = join(import.meta.dir, '../../src/memory/ui')

function get(c: UiContext, path: string): Promise<Response> {
  return handle(new Request(`http://127.0.0.1:${c.port}${path}`, { headers: { host: `127.0.0.1:${c.port}` } }), c)
}

describe('the page files of a running server', () => {
  test('are still served after their folder is removed, none of them asked for before', async () => {
    await withSandbox(async ({ root }) => {
      const dir = join(root, 'runtime-ui')
      cpSync(UI_DIR, dir, { recursive: true })
      const c = uiContext({ version: '9.9.9', port: 41999, uiDir: dir })
      const page = readFileSync(join(dir, 'index.html'), 'utf8')
      const assets = Object.keys(UI_ASSETS).map(name => ({ name, body: readFileSync(join(dir, name)) }))
      rmSync(dir, { recursive: true, force: true })

      const r = await get(c, '/')
      expect(r.status).toBe(200)
      expect(await r.text()).toBe(page)
      for (const { name, body } of assets) {
        const a = await get(c, `/assets/${name}`)
        expect(a.status).toBe(200)
        expect(Buffer.from(await a.arrayBuffer()).equals(body)).toBe(true)
      }
      expect((await get(c, '/favicon.ico')).status).toBe(200)
      expect((await get(c, '/assets/api.ts')).status).toBe(404)
    })
  })

  test('show an edit made in place at once, and keep the edited copy once the folder is gone', async () => {
    await withSandbox(async ({ root }) => {
      const dir = join(root, 'checkout-ui')
      cpSync(UI_DIR, dir, { recursive: true })
      const c = uiContext({ version: '9.9.9', port: 41999, uiDir: dir })
      const css = join(dir, 'app.css')
      writeFileSync(css, '/* edited */\n')
      utimesSync(css, new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1)))
      expect(await (await get(c, '/assets/app.css')).text()).toBe('/* edited */\n')
      rmSync(dir, { recursive: true, force: true })
      expect(await (await get(c, '/assets/app.css')).text()).toBe('/* edited */\n')
    })
  })
})
