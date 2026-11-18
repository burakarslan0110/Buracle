import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildSite, type HomeData } from '../../site/build'
import { escapeHtml } from '../../site/templates/layout'
import { BRAIN_H, BRAIN_W, layoutBrain } from '../../site/templates/brain'
import { checkBash } from '../../src/core/policy/bash-guard'
import { consentNeeded } from '../../src/core/policy/consent'
import { checkWrite } from '../../src/core/policy/write-guard'
import { HARNESSES, harnessProfile, type Harness } from '../../src/core/harness'
import { MEM_KINDS, type MemKind } from '../../src/core/memory/brain'
import { makeSandboxDirs } from '../helpers/sandbox'

// The landing page: the numbers it shows are counted from the code, the orbit carries the seven harnesses in profile
// order, the brain places every example memory in its layer's half, each workflow ring has one node per phase, the
// router names the nine MCP servers and the guard examples get the answers the policy gives. The page is built through
// site/build.ts from the real landing data and the fixture docs.

const REPO = join(import.meta.dir, '..', '..')
const LANGS = ['en', 'tr'] as const
type L = typeof LANGS[number]
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8')
const homes = Object.fromEntries(LANGS.map(l => [l, JSON.parse(read(`site/content/${l}/home.json`)) as HomeData])) as Record<L, HomeData>

const sandbox = makeSandboxDirs('buracle-site-landing-')
afterAll(() => rmSync(sandbox.root, { recursive: true, force: true }))
const content = join(sandbox.root, 'content')
cpSync(join(REPO, 'tests', 'fixtures', 'site', 'content'), content, { recursive: true })
for (const l of LANGS) for (const f of ['home.json', 'ui.json']) cpSync(join(REPO, 'site', 'content', l, f), join(content, l, f))
const media = join(sandbox.root, 'no-media')
mkdirSync(media, { recursive: true })
const OUT = join(sandbox.root, 'out')
await buildSite({ out: OUT, content, media })
const page = (l: L): string => readFileSync(join(OUT, l === 'en' ? 'index.html' : 'tr/index.html'), 'utf8')
const between = (html: string, a: string, b: string): string => html.slice(html.indexOf(a), html.indexOf(b, html.indexOf(a)))

describe('landing: the numbers count the code', () => {
  test('7 harnesses, 9 MCP servers, 6 language servers, 26 hooks, 13 skills, 4 workflows, in both languages', () => {
    const mcp = read('canonical/mcp.yaml')
    const servers = [...mcp.slice(mcp.indexOf('servers:')).matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].length
    const lsp = [...read('canonical/tools.yaml').matchAll(/^\s+kind: lsp\s*$/gm)].length
    const hooks = [...read('canonical/hooks.yaml').matchAll(/^ {2}- id: H\d\d\s*$/gm)].length
    const skills = readdirSync(join(REPO, 'canonical', 'skills')).filter(d => existsSync(join(REPO, 'canonical', 'skills', d, 'SKILL.md'))).length
    const rule = read('canonical/rules/always/core.md').split('\n').find(l => l.includes('The workflows')) ?? ''
    const workflows = [...rule.slice(0, rule.indexOf('start only')).matchAll(/`([a-z-]+)`/g)].map(m => m[1])
    expect(workflows).toEqual(['plan-build', 'goal-build', 'bugfix', 'requirements'])
    const counted = [HARNESSES.length, servers, lsp, hooks, skills, workflows.length]
    expect(counted).toEqual([7, 9, 6, 26, 13, 4])
    for (const l of LANGS) {
      expect({ l, values: homes[l].numbers.items.map(i => i.value) }).toEqual({ l, values: counted })
      const band = between(page(l), 'class="numbers"', '</ul>')
      expect([...band.matchAll(/data-count="(\d+)">(\d+)</g)].map(m => [Number(m[1]), Number(m[2])])).toEqual(counted.map(n => [n, n]))
    }
  })
})

describe('landing: the orbit', () => {
  test('seven harness buttons in profile order, each with its logo, its name and how it starts a workflow', () => {
    for (const l of LANGS) {
      const fig = between(page(l), 'data-orbit', '</figure>')
      const agents = [...fig.matchAll(/<button class="agent" type="button" data-harness="([a-z]+)" aria-pressed="false"><span class="face"><img src="(\/assets\/logos\/[^"]+\.svg)" alt=""[^>]*><\/span><span class="agent-name">([^<]+)<\/span><\/button>/g)]
      expect(agents.map(a => a[1])).toEqual([...HARNESSES])
      for (const [i, a] of agents.entries()) {
        expect(a[3]).toBe(escapeHtml(homes[l].harnesses[i]?.name ?? ''))
        expect(existsSync(join(OUT, a[2] as string))).toBe(true)
        // The caption a harness shows names its own workflow command, from its profile.
        const cap = between(fig, `<template data-cap="${a[1]}">`, '</template>')
        expect(cap).toContain(`<code>${harnessProfile(a[1] as Harness).skills.mention('plan-build', true)}</code>`)
      }
      // The inner ring shows the nine MCP servers, as decoration: the tools section names them.
      expect([...fig.matchAll(/class="orbit-item tool-item"/g)]).toHaveLength(9)
      expect(fig).toContain('<div class="ring ring-tools" aria-hidden="true">')
      expect(fig).toContain('<figcaption class="sr-only" id="orbit-label">')
      expect(fig).toContain('data-motion-toggle')
    }
  })
})

describe('landing: the brain', () => {
  test('the same memories draw the same brain, inside the view box, each memory once and in its layer\'s half', () => {
    const mems = homes.en.memory.memories
    const a = layoutBrain(mems)
    expect(layoutBrain(mems)).toEqual(a)
    for (const n of a.nodes) expect({ inside: n.x > 0 && n.x < BRAIN_W && n.y > 0 && n.y < BRAIN_H }).toEqual({ inside: true })
    const placed = a.nodes.filter(n => n.mem !== undefined)
    expect(placed.map(n => n.mem).sort()).toEqual(mems.map(m => m.id).sort())
    for (const n of placed) {
      const m = mems.find(x => x.id === n.mem)
      const half: string = n.x < BRAIN_W / 2 ? 'project' : 'person'
      expect({ id: n.mem, side: n.side as string, half }).toEqual({ id: n.mem, side: m?.layer ?? '?', half: m?.layer ?? '?' })
    }
    // Links stay in their half, apart from the few across the middle.
    const across = a.links.filter(([p, q]) => a.nodes[p]?.side !== a.nodes[q]?.side)
    expect(across.length).toBeGreaterThan(0)
    expect(across.length).toBeLessThanOrEqual(3)
  })

  test('the example memories are real kinds in both brains, written in one harness and recalled in another', () => {
    for (const l of LANGS) {
      const mems = homes[l].memory.memories
      for (const m of mems) {
        expect({ id: m.id, kind: MEM_KINDS.includes(m.kind as MemKind) }).toEqual({ id: m.id, kind: true })
        expect({ id: m.id, crosses: m.written !== m.recalled }).toEqual({ id: m.id, crosses: true })
      }
      expect(new Set(mems.map(m => m.layer))).toEqual(new Set(['project', 'person']))
    }
    // Both editions draw the same brain: only the titles are translated.
    const skeleton = (l: L): unknown => homes[l].memory.memories.map(m => [m.id, m.kind, m.layer, m.origin, m.written, m.recalled, m.files])
    expect(skeleton('tr')).toEqual(skeleton('en'))
  })

  test('every memory is a named button with one tab stop, and its card is rendered for the script to show', () => {
    for (const l of LANGS) {
      const sec = between(page(l), 'class="memory"', '</section>')
      const nodes = [...sec.matchAll(/<g class="bm" data-mem="([^"]+)" data-side="(project|person)" role="button" tabindex="(0|-1)" aria-label="([^"]+)">/g)]
      const mems = homes[l].memory.memories
      expect(nodes.map(n => n[1]).sort()).toEqual(mems.map(m => m.id).sort())
      expect(nodes.filter(n => n[3] === '0')).toHaveLength(1)
      for (const n of nodes) {
        const m = mems.find(x => x.id === n[1])
        expect({ side: n[2], label: n[4] }).toEqual({ side: m?.layer, label: escapeHtml(`${m?.kind}: ${m?.title}`) })
        const card = between(sec, `<template data-card="${n[1]}">`, '</template>')
        for (const id of [m?.written, m?.recalled]) expect(card).toContain(`<b>${escapeHtml(homes[l].harnesses.find(h => h.id === id)?.name ?? '?')}</b>`)
      }
      expect(sec).toContain('<details class="brain-list">')
      expect(sec).toContain(escapeHtml(homes[l].memory.example))
    }
  })
})

describe('landing: the workflow rings', () => {
  test('each ring has one node and one listed phase per phase, the gates marked and the way back drawn when there is one', () => {
    for (const l of LANGS) {
      const html = page(l)
      for (const loop of homes[l].loops.items) {
        const id = loop.command.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
        const panel = between(html, `id="panel-${id}"`, '</ol>')
        const nodes = [...panel.matchAll(/<g class="rn([^"]*)" data-k="(\d+)">/g)]
        expect(nodes.map(n => Number(n[2]))).toEqual(loop.phases.map((_p, k) => k))
        expect(nodes.map(n => (n[1] ?? '').includes('is-gate'))).toEqual(loop.phases.map(p => p.gate === true))
        expect([...panel.matchAll(/<li class="phase/g)]).toHaveLength(loop.phases.length)
        expect(panel.includes('class="ring-back"')).toBe(loop.loopBack !== undefined)
      }
    }
  })

  test('every command a workflow shows is a shipped skill', () => {
    for (const l of LANGS) {
      for (const s of homes[l].loops.items.flatMap(x => [x.command, x.example])) {
        const name = (s.split(' ')[0] as string).replace(/^[/$]/, '')
        expect({ s, known: existsSync(join(REPO, 'canonical', 'skills', name, 'SKILL.md')) }).toEqual({ s, known: true })
      }
    }
  })
})

describe('landing: the router and the guards', () => {
  test('nine server buttons, the first pressed, each with the question routing sends it and what it adds', () => {
    for (const l of LANGS) {
      const sec = between(page(l), 'data-router', 'class="strip-box"')
      const t = homes[l].tools
      const buttons = [...sec.matchAll(/<button class="srv" type="button" data-srv="(\d+)" aria-pressed="(true|false)">/g)]
      expect(buttons.map(b => b[2])).toEqual(t.servers.map((_s, i) => String(i === 0)))
      const answers = [...sec.matchAll(/<div class="answer" data-answer="(\d+)"( hidden)?>/g)]
      expect(answers.map(a => a[2] === undefined)).toEqual(t.servers.map((_s, i) => i === 0))
      for (const s of t.servers) {
        expect(sec).toContain(`<span class="answer-q-text">${escapeHtml(s.q)}</span>`)
        expect(sec).toContain(`<p class="answer-adds">${escapeHtml(s.adds)}</p>`)
      }
      // The language servers have no project logo of their own: their button shows the language marks.
      expect(sec).toContain('<span class="lsp-marks">')
    }
  })

  test('the strip shows the six language servers with their logos', () => {
    for (const l of LANGS) {
      const strip = between(page(l), 'class="strip"', '</ul>')
      for (const id of ['typescript', 'pyright', 'go', 'rust', 'csharp', 'java']) expect(strip).toMatch(new RegExp(`<img src="/assets/logos/${id}[a-z-]*\\.svg"`))
    }
  })

  test('each guard example gets the answer the policy gives it', () => {
    let checked = 0
    for (const l of LANGS) {
      for (const g of homes[l].tools.guards.items) {
        if (g.tool === 'write') {
          expect({ g: g.command, deny: checkWrite([g.command], { cwd: '/home/u/acme-shop', home: '/home/u', vault: '/home/u/Documents/Buracle', protect: [] }).deny !== undefined }).toEqual({ g: g.command, deny: true })
        } else if (g.verdict === 'deny') {
          expect({ g: g.command, deny: checkBash(g.command, { extraDeny: [] }).deny !== undefined }).toEqual({ g: g.command, deny: true })
        } else {
          expect({ g: g.command, deny: checkBash(g.command, { extraDeny: [] }).deny, ask: consentNeeded(g.command) !== undefined }).toEqual({ g: g.command, deny: undefined, ask: true })
        }
        checked++
      }
    }
    expect(checked).toBe(6)
  })
})

describe('landing: the page stays short and the film is 40 seconds', () => {
  test('no terminal windows: the install command is the only shell line above the footer', () => {
    for (const l of LANGS) {
      const main = between(page(l), '<main id="main">', '</main>')
      expect(main).not.toContain('win-lights')
      expect([...main.matchAll(/<div class="cmd">/g)]).toHaveLength(1)
    }
  })

  test('the film is 40 seconds in every word the page says about it', () => {
    expect(homes.en.video.label).toContain('40 seconds')
    expect(homes.tr.video.label).toContain('40 saniye')
    for (const l of LANGS) expect(JSON.stringify(homes[l])).not.toMatch(/(30|45|55) (seconds|saniye)/)
  })
})
