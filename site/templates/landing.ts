// The landing page: home.json rendered as five short scenes. The hero puts the seven harnesses on an orbit around the
// layer, the film follows, the memory is a brain with the project brain and the person brain as its halves, each
// workflow is a ring with a light running round it, and the tools section routes a question to the MCP server that
// answers it, over a strip of the language servers and the guards' answers. Every word comes from home.json, every logo
// from site/assets/logos/SOURCES.json; this file only places them. Each scene is whole without script and under reduced
// motion: home.js sets it in motion and wires its controls.

import { brainSvg, layoutBrain } from './brain'
import { commandBlock, escapeHtml, inline, page } from './layout'
import type { BrainMemory, HomeData, LandingExtras, Logo, Loop, Media, PageContext, Server } from './types'

const FAVICON = '/assets/favicon.svg'
const GLOBE = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
const PLAY = '<svg class="icon i-play" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 5.5v13l10-6.5z"/></svg>'
const BACK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4"/></svg>'
const SHELL = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 7l5 5-5 5M12 17h7"/></svg>'
const PEN = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>'

const r1 = (v: number): number => Math.round(v * 10) / 10

/** A logo image, or a globe for a project without a logo file. `alt` is empty where the name is printed beside it. */
function mark(logo: Logo | undefined, px: number, alt = ''): string {
  if (logo?.src === undefined) return GLOBE
  return `<img src="${logo.src}" alt="${escapeHtml(alt)}" width="${px}" height="${px}" loading="lazy" decoding="async">`
}

function head(id: string, eyebrow: string, title: string, lead?: string): string {
  return `<div class="sec-head">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h2 id="${id}">${escapeHtml(title)}</h2>${lead !== undefined ? `
      <p class="lead">${inline(lead)}</p>` : ''}
    </div>`
}

const harnessLogo = (x: LandingExtras, id: string, home: HomeData): Logo | undefined => x.logos.get(home.harnesses.find(h => h.id === id)?.source ?? '')
/** The logo a server shows: its upstream project's, or for the language servers the TypeScript mark. */
const serverLogo = (x: LandingExtras, s: Server): Logo | undefined => (s.source !== undefined ? x.logos.get(s.source) : undefined)

// ---------------------------------------------------------------------------------------------------------------
// 1. Hero: the headline and the install command beside the orbit, the numbers under both.

function orbit(home: HomeData, x: LandingExtras): string {
  const h = home.hero
  const n = home.harnesses.length
  const agents = home.harnesses.map((a, i) => {
    const angle = r1(-90 + (360 * i) / n)
    return `<li class="orbit-item agent-item" style="--a:${angle}deg"><button class="agent" type="button" data-harness="${escapeHtml(a.id)}" aria-pressed="false"><span class="face">${mark(x.logos.get(a.source), 30)}</span><span class="agent-name">${escapeHtml(a.name)}</span></button></li>`
  }).join('')
  const threads = home.harnesses.map((_a, i) => {
    const t = ((-90 + (360 * i) / n) * Math.PI) / 180
    // A faint track from the harness to the layer, and a spark that runs along it toward the layer.
    const ends = `x1="${r1(50 + 37 * Math.cos(t))}" y1="${r1(50 + 37 * Math.sin(t))}" x2="${r1(50 + 16 * Math.cos(t))}" y2="${r1(50 + 16 * Math.sin(t))}"`
    return `<line class="thread" ${ends}/><line class="spark" ${ends} style="--i:${i}"/>`
  }).join('')
  const tools = home.tools.servers.map((s, i) => {
    const angle = r1(-90 + 20 + (360 * i) / home.tools.servers.length)
    const logo = s.source !== undefined ? serverLogo(x, s) : x.logos.get('typescript')
    return `<span class="orbit-item tool-item" style="--a:${angle}deg"><span class="face">${mark(logo, 18)}</span></span>`
  }).join('')
  const captions = home.harnesses.map(a => `<template data-cap="${escapeHtml(a.id)}"><span class="cap-name">${escapeHtml(a.name)}</span><span class="cap-invoke">${escapeHtml(h.invoke)} <code>${escapeHtml(a.invoke)}</code></span><span class="cap-plugs">${inline(a.plugs)}</span></template>`).join('')
  return `<figure class="orbit-fig" data-orbit aria-labelledby="orbit-label">
      <figcaption class="sr-only" id="orbit-label">${escapeHtml(h.orbitLabel)}</figcaption>
      <div class="orbit">
        <div class="orbit-rings" aria-hidden="true"><i></i><i></i><i></i></div>
        <div class="ring ring-tools" aria-hidden="true">${tools}</div>
        <div class="ring ring-agents">
          <svg class="threads" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${threads}</svg>
          <ul class="agents">${agents}</ul>
        </div>
        <div class="core" aria-hidden="true"><span class="core-pulse"></span><span class="core-pulse"></span><img src="${FAVICON}" alt="" width="40" height="40"><span class="core-name">Buracle Stack</span></div>
      </div>
      <p class="orbit-caption" data-orbit-caption aria-live="polite"><span class="cap-hint">${escapeHtml(h.pick)}</span></p>
      ${captions}
    </figure>`
}

function hero(ctx: PageContext, home: HomeData, x: LandingExtras): string {
  const h = home.hero
  const n = home.numbers
  return `<section class="hero" aria-labelledby="hero-title">
  <div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
  <div class="wrap hero-in">
    <div class="hero-copy">
      <p class="eyebrow">${escapeHtml(h.eyebrow)}</p>
      <h1 id="hero-title">${escapeHtml(h.title)}</h1>
      <p class="lede">${inline(h.lede)}</p>
      <div class="install">
        <p class="sr-only" id="install-label">${escapeHtml(h.installLabel)}</p>
        ${commandBlock(ctx.ui, h.command, 'install-label')}
      </div>
      <p class="hero-cta"><a class="btn btn-solid" href="${escapeHtml(h.docs.href)}">${escapeHtml(h.docs.text)}</a><a class="btn btn-line" href="#film">${PLAY}<span>${escapeHtml(h.film)}</span></a></p>
    </div>
    ${orbit(home, x)}
  </div>
  <div class="wrap">
    <h2 class="sr-only" id="numbers-title">${escapeHtml(n.label)}</h2>
    <ul class="numbers" aria-labelledby="numbers-title">${n.items.map(it => `<li><span class="num-v" data-count="${it.value}">${it.value}</span><span class="num-l">${escapeHtml(it.label)}</span></li>`).join('')}</ul>
  </div>
</section>`
}

// ---------------------------------------------------------------------------------------------------------------
// 2. The film.

function film(home: HomeData, media: Media): string {
  if (media.video === undefined) return ''
  const v = home.video
  return `<section class="film-sec" id="film" aria-labelledby="film-title">
  <div class="wrap">
    ${head('film-title', v.eyebrow, v.label)}
    <div class="film reveal"><video controls playsinline preload="${media.poster !== undefined ? 'none' : 'metadata'}"${media.poster !== undefined ? ` poster="${media.poster}"` : ''} width="1920" height="1080" aria-labelledby="film-title">
      <source src="${media.video}" type="video/mp4">
    </video></div>
  </div>
</section>`
}

// ---------------------------------------------------------------------------------------------------------------
// 3. The memory: the brain beside its card. The card shows the first memory without script.

function card(home: HomeData, x: LandingExtras, m: BrainMemory): string {
  const g = home.memory
  const layer = m.layer === 'project' ? g.project.name : g.person.name
  const agent = (id: string, label: string): string => {
    const name = home.harnesses.find(hh => hh.id === id)?.name ?? id
    return `<span class="bc-agent">${mark(harnessLogo(x, id, home), 20)}<span>${escapeHtml(label)} <b>${escapeHtml(name)}</b></span></span>`
  }
  const files = (m.files ?? []).map(f => `<code>${escapeHtml(f)}</code>`).join(' ')
  return `<p class="bc-head"><code class="bc-kind">${escapeHtml(m.kind)}</code><span class="bc-layer" data-side="${m.layer}">${escapeHtml(layer)}</span></p>
        <p class="bc-title">${escapeHtml(m.title)}</p>
        <dl class="bc-facts"><div><dt>${escapeHtml(g.card.origin)}</dt><dd>${escapeHtml(m.origin === 'explicit' ? g.card.explicit : g.card.inferred)}</dd></div>${files !== '' ? `<div><dt>${escapeHtml(g.card.cites)}</dt><dd>${files}</dd></div>` : ''}</dl>
        <p class="bc-path">${agent(m.written, g.card.written)}<span class="bc-arrow" aria-hidden="true"></span>${agent(m.recalled, g.card.recalled)}</p>`
}

function memory(home: HomeData, x: LandingExtras): string {
  const g = home.memory
  const model = layoutBrain(g.memories)
  const first = g.memories.find(m => m.id === model.nodes.find(nd => nd.mem !== undefined)?.mem) ?? (g.memories[0] as BrainMemory)
  const list = (['project', 'person'] as const).map(side => {
    const mems = g.memories.filter(m => m.layer === side)
    return `<li><h3>${escapeHtml(side === 'project' ? g.project.name : g.person.name)}</h3><ul>${mems.map(m => `<li><code>${escapeHtml(m.kind)}</code> ${escapeHtml(m.title)}</li>`).join('')}</ul></li>`
  }).join('')
  // Each memory's card, rendered here so home.js only swaps it in: no copy is built in the browser.
  const cards = g.memories.map(m => `<template data-card="${escapeHtml(m.id)}">${card(home, x, m)}</template>`).join('')
  return `<section class="memory" id="memory" aria-labelledby="memory-title">
  <div class="wrap memory-grid">
    <div class="memory-copy">
      ${head('memory-title', g.eyebrow, g.title)}
      <div class="memory-text">${g.body.map(p => `<p>${inline(p)}</p>`).join('')}</div>
      <div class="brain-card" data-brain-card data-side="${first.layer}">
        ${card(home, x, first)}
      </div>
    </div>
    <figure class="brain reveal" data-brain>
      <p class="brain-example" id="brain-title"><span class="sr-only">${escapeHtml(g.label)} </span>${escapeHtml(g.example)}</p>
      <div class="brain-stage">
        <p class="hemi" data-side="project"><span>${escapeHtml(g.project.name)}</span><small>${escapeHtml(g.project.sub)}</small></p>
        <p class="hemi" data-side="person"><span>${escapeHtml(g.person.name)}</span><small>${escapeHtml(g.person.sub)}</small></p>
        ${brainSvg(model, g.memories, 'brain-title')}
      </div>
    </figure>
    ${cards}
  </div>
  <div class="wrap"><details class="brain-list"><summary>${escapeHtml(g.listLabel)}</summary><ul>${list}</ul></details></div>
</section>`
}

// ---------------------------------------------------------------------------------------------------------------
// 4. The workflows: each a ring with numbered phases, the gates as diamonds and the way back as an arc inside.

const RING = { size: 520, r: 190 }
const slug = (command: string): string => command.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
const ringPoint = (k: number, n: number, r = RING.r): { x: number, y: number } => {
  const t = ((-90 + (360 * k) / n) * Math.PI) / 180
  return { x: r1(RING.size / 2 + r * Math.cos(t)), y: r1(RING.size / 2 + r * Math.sin(t)) }
}

function loopPanel(home: HomeData, loop: Loop, i: number): string {
  const l = home.loops
  const id = slug(loop.command)
  const n = loop.phases.length
  const c = RING.size / 2
  const nodes = loop.phases.map((ph, k) => {
    const p = ringPoint(k, n)
    const shape = ph.gate === true
      ? `<rect x="${r1(p.x - 13)}" y="${r1(p.y - 13)}" width="26" height="26" rx="4" transform="rotate(45 ${p.x} ${p.y})"/>`
      : `<circle cx="${p.x}" cy="${p.y}" r="17"/>`
    return `<g class="rn${ph.gate === true ? ' is-gate' : ''}${k === n - 1 ? ' is-end' : ''}" data-k="${k}">${shape}<text x="${p.x}" y="${r1(p.y + 5)}" text-anchor="middle">${k + 1}</text></g>`
  }).join('')
  const back = loop.loopBack
  let again = ''
  if (back !== undefined) {
    const a = ringPoint(back.from, n, RING.r - 30)
    const b = ringPoint(back.to, n, RING.r - 30)
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    again = `<path class="ring-back" d="M${a.x} ${a.y}Q${r1(mx + (c - mx) * 0.75)} ${r1(my + (c - my) * 0.75)} ${b.x} ${b.y}" marker-end="url(#arrow-${id})"/>`
  }
  const phases = loop.phases.map((p, k) => `<li class="phase${p.gate === true ? ' is-gate' : ''}" data-k="${k}"><span class="phase-k" aria-hidden="true">${k + 1}</span><span class="phase-text"><span class="phase-name">${inline(p.name)}</span>${p.detail !== undefined ? `<span class="phase-detail">${escapeHtml(p.detail)}</span>` : ''}</span></li>`).join('')
  const firstPhase = loop.phases[0] as Loop['phases'][number]
  return `<div class="tabpanel loop" role="tabpanel" id="panel-${id}" aria-labelledby="tab-${id}" tabindex="0" data-loop data-n="${n}"${i === 0 ? '' : ' data-later'}>
      <div class="ring-fig" aria-hidden="true">
        <svg class="ring-svg" viewBox="0 0 ${RING.size} ${RING.size}" focusable="false"><defs><linearGradient id="grad-${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="stop-from"/><stop offset="1" class="stop-to"/></linearGradient><marker id="arrow-${id}" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z" class="ring-arrow"/></marker></defs><circle class="ring-base" cx="${c}" cy="${c}" r="${RING.r}"/><circle class="ring-prog" data-prog cx="${c}" cy="${c}" r="${RING.r}" stroke="url(#grad-${id})" transform="rotate(-90 ${c} ${c})" pathLength="1000"/>${again}<circle class="ring-dot" data-dot cx="${c}" cy="${c - RING.r}" r="8"/><g class="ring-nodes">${nodes}</g></svg>
        <div class="ring-centre"><span class="rc-k" data-rc-k>1 / ${n}</span><span class="rc-name" data-rc-name>${inline(firstPhase.name)}</span><span class="rc-detail" data-rc-detail>${escapeHtml(firstPhase.detail ?? '')}</span></div>
      </div>
      <div class="loop-info">
        <h3 class="loop-cmd"><code>${escapeHtml(loop.command)}</code></h3>
        <p class="loop-when"><span class="label">${escapeHtml(l.when)}</span>${escapeHtml(loop.when)}</p>
        <ol class="phases" aria-label="${escapeHtml(l.phasesLabel)}">${phases}</ol>
        ${back !== undefined ? `<p class="loop-return">${BACK}<span>${escapeHtml(back.text)}</span></p>` : ''}
        <p class="loop-example"><span class="label">${escapeHtml(l.example)}</span><code>${escapeHtml(loop.example)}</code></p>
      </div>
    </div>`
}

function loops(home: HomeData): string {
  const l = home.loops
  const tabs = l.items.map((loop, i) => {
    const id = slug(loop.command)
    return `<button class="tab" type="button" role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}"><code>${escapeHtml(loop.command)}</code></button>`
  }).join('')
  return `<section class="loops" id="loops" aria-labelledby="loops-title">
  <div class="wrap">
    ${head('loops-title', l.eyebrow, l.title, l.sub)}
    <div class="tabs" data-tabs>
      <div class="tablist" role="tablist" aria-label="${escapeHtml(l.tabsLabel)}" hidden>${tabs}</div>
      ${l.items.map((loop, i) => loopPanel(home, loop, i)).join('\n      ')}
    </div>
    <p class="loops-foot">${inline(l.footnote)} <a class="go" href="${escapeHtml(l.cases.href)}">${escapeHtml(l.cases.text)}</a></p>
  </div>
</section>`
}

// ---------------------------------------------------------------------------------------------------------------
// 5. The tools: a question routed to the server that answers it, the language servers and tools, the guards.

function serverFace(x: LandingExtras, s: Server, px: number): string {
  if (s.source !== undefined) return mark(serverLogo(x, s), px)
  // The language servers: four of the six marks in a small square, the strip below shows all six.
  const marks = ['typescript', 'pyright', 'go', 'rust'].map(id => mark(x.logos.get(id), Math.round(px / 2) - 1)).join('')
  return `<span class="lsp-marks">${marks}</span>`
}

function tools(home: HomeData, x: LandingExtras): string {
  const t = home.tools
  const n = t.servers.length
  const servers = t.servers.map((s, i) => {
    const u = n === 1 ? 0.5 : i / (n - 1)
    // A fan under the question: the middle servers sit high, the outer ones lower, so every beam runs down to its server.
    const y = r1(20 + 42 * (2 * u - 1) ** 2)
    return `<li style="--x:${r1(5 + 90 * u)}%;--y:${y}%"><button class="srv" type="button" data-srv="${i}" aria-pressed="${i === 0}"><span class="srv-face">${serverFace(x, s, 30)}</span><span class="srv-id">${escapeHtml(s.id)}</span></button></li>`
  }).join('')
  const answers = t.servers.map((s, i) => {
    const logo = serverLogo(x, s)
    const by = logo !== undefined ? `<a href="${escapeHtml(logo.href)}">${escapeHtml(s.by)}</a>` : `<span>${escapeHtml(s.by)}</span>`
    return `<div class="answer" data-answer="${i}"${i === 0 ? '' : ' hidden'}><p class="answer-q"><span class="label">${escapeHtml(t.ask)}</span><span class="answer-q-text">${escapeHtml(s.q)}</span></p><p class="answer-who"><code>${escapeHtml(s.id)}</code>${by}</p><p class="answer-adds">${escapeHtml(s.adds)}</p></div>`
  }).join('')
  const strip = t.strip.map(s => {
    const logo = x.logos.get(s.source)
    return `<li>${logo?.src !== undefined ? `<img src="${logo.src}" alt="" width="22" height="22" loading="lazy" decoding="async">` : ''}<span>${escapeHtml(s.name)}</span></li>`
  }).join('')
  const guards = t.guards.items.map(g => `<li class="guard" data-verdict="${g.verdict}"><span class="guard-tool">${g.tool === 'write' ? PEN : SHELL}</span><code>${escapeHtml(g.command)}</code><span class="verdict">${escapeHtml(g.label)}</span></li>`).join('')
  return `<section class="tools" id="tools" aria-labelledby="tools-title">
  <div class="wrap">
    ${head('tools-title', t.eyebrow, t.title, t.sub)}
    <div class="router reveal" data-router>
      <div class="answers" data-answers>${answers}</div>
      <div class="router-stage">
        <svg class="router-beam" aria-hidden="true" focusable="false"><path data-beam d=""/><circle data-beam-dot r="4"/></svg>
        <ul class="servers" aria-label="${escapeHtml(t.routerLabel)}">${servers}</ul>
      </div>
    </div>
    <div class="strip-box">
      <p class="strip-label" id="strip-label">${escapeHtml(t.stripLabel)}</p>
      <div class="marquee" aria-labelledby="strip-label"><div class="marquee-track"><ul class="strip">${strip}</ul><ul class="strip" aria-hidden="true">${strip}</ul></div></div>
    </div>
    <div class="guards reveal">
      <h3 class="guards-title">${escapeHtml(t.guards.title)}</h3>
      <ul class="guard-list">${guards}</ul>
    </div>
  </div>
</section>`
}

function openSource(home: HomeData, x: LandingExtras): string {
  const c = home.credits
  const items = x.credits.map(l => `<li><a href="${escapeHtml(l.href)}">${l.src !== undefined ? `<img src="${l.src}" alt="" width="18" height="18" loading="lazy" decoding="async">` : ''}<span>${escapeHtml(l.name)}</span></a></li>`).join('')
  return `<section class="oss" aria-labelledby="oss-title">
      <div class="oss-head">
        <h2 id="oss-title">${escapeHtml(c.title)}</h2>
        <p>${escapeHtml(c.body)}</p>
        ${x.creditsPath !== undefined ? `<a class="go" href="${x.creditsPath}">${escapeHtml(c.link)}</a>` : ''}
      </div>
      <ul class="oss-list">${items}</ul>
    </section>
    `
}

export function landingPage(ctx: PageContext, home: HomeData, media: Media, extras: LandingExtras): string {
  return page(ctx, 'home', `<main id="main">
${hero(ctx, home, extras)}
${film(home, media)}
${memory(home, extras)}
${loops(home)}
${tools(home, extras)}
</main>`, home.close, openSource(home, extras))
}
