import { svg } from './dom.js'

export const LOGO = [
  '██                                             ██          ',
  '██                                             ██          ',
  '██████▄   ██    ██  ██▄███   ▄██████   ▄█████  ██   ▄████▄ ',
  '██ ▄▄ ██  ██    ██  ██▀     ██    ██  ██       ██  ██▄▄▄▄██',
  '██ ▀▀ ██  ██    ██  ██      ██    ██  ██       ██  ██▀▀▀▀▀▀',
  '██████▀    ▀██████  ██       ▀██████   ▀█████  ██   ▀█████ ',
]

export const EYE = [[3, 3], [3, 4], [4, 3], [4, 4]]

export const MARK = LOGO.map((row) => row.slice(0, 8))

const LOGO_WIDTH = Math.max(...LOGO.map((row) => [...row].length))
const TOP = new Set(['█', '▀'])
const BOTTOM = new Set(['█', '▄'])

export function pixelPaths(rows, { dx = 0, dy = 0, scale = 1 } = {}) {
  const eye = new Set(EYE.map(([r, c]) => `${r}:${c}`))
  let body = ''
  let iris = ''
  rows.forEach((row, r) => {
    const cells = [...row]
    for (const [half, lit] of [[0, TOP], [1, BOTTOM]]) {
      const y = dy + (r * 2 + half) * scale
      let c = 0
      while (c < cells.length) {
        if (!lit.has(cells[c])) { c++; continue }
        const inEye = eye.has(`${r}:${c}`)
        let e = c + 1
        while (e < cells.length && lit.has(cells[e]) && eye.has(`${r}:${e}`) === inEye) e++
        const w = (e - c) * scale
        const d = `M${dx + c * scale} ${y}h${w}v${scale}h-${w}z`
        if (inEye) iris += d
        else body += d
        c = e
      }
    }
  })
  return { body, eye: iris, width: Math.max(...rows.map((row) => [...row].length)) * scale, height: rows.length * 2 * scale }
}

export function pixelArt(rows, cls, gradientId) {
  const { body, eye, width, height } = pixelPaths(rows)
  const el = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: cls, 'aria-hidden': 'true', focusable: 'false', 'shape-rendering': 'crispEdges' })
  const grad = svg('linearGradient', { id: gradientId, gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: LOGO_WIDTH, y2: 0 })
  grad.append(svg('stop', { offset: 0, class: 'art-from' }), svg('stop', { offset: 1, class: 'art-to' }))
  const defs = svg('defs')
  defs.append(grad)
  el.append(defs, svg('path', { class: 'art-body', d: body, fill: `url(#${gradientId})` }), svg('path', { class: 'art-eye', d: eye }))
  return el
}

export function markTile() {
  const { body, eye } = pixelPaths(MARK, { dx: 8, dy: 4, scale: 2 })
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" shape-rendering="crispEdges">',
    '  <rect width="32" height="32" rx="7" fill="#0b0d14" shape-rendering="geometricPrecision"/>',
    `  <path fill="#a78bfa" d="${body}"/>`,
    `  <path fill="#22d3ee" d="${eye}"/>`,
    '</svg>',
    '',
  ].join('\n')
}

export const WORDMARK_THEMES = {
  dark: { from: '#a78bfa', to: '#22d3ee', eye: '#22d3ee' },
  light: { from: '#7c3aed', to: '#0891b2', eye: '#0891b2' },
}

export function wordmarkSvg(theme) {
  const c = WORDMARK_THEMES[theme]
  const { body, eye, width, height } = pixelPaths(LOGO)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width * 8}" height="${height * 8}" shape-rendering="crispEdges">`,
    `  <linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${width}" y2="0"><stop offset="0" stop-color="${c.from}"/><stop offset="1" stop-color="${c.to}"/></linearGradient>`,
    `  <path fill="url(#fill)" d="${body}"/>`,
    `  <path fill="${c.eye}" d="${eye}"/>`,
    '</svg>',
    '',
  ].join('\n')
}
