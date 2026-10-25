import { fill, getJson, h, icon } from './dom.js'
import { fmtDate, num, relTime, t } from './i18n.js'
import { switchesGroup } from './switches.js'

let token = null

async function fetchToken() {
  const r = await getJson('/api/token')
  token = r.ok && typeof r.body?.token === 'string' ? r.body.token : null
  if (token !== null) return null
  return r.ok ? { ok: false, status: r.status, body: { error: 'no_token', message: t('write.noToken') } } : r
}

async function post(url, body) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-buracle-token': token },
      body: JSON.stringify(body),
    })
    let out = null
    try { out = await r.json() } catch {  }
    return { ok: r.ok, status: r.status, body: out }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}

async function withToken(send) {
  if (token === null) {
    const failed = await fetchToken()
    if (failed !== null) return failed
  }
  const r = await send()
  if (r.status !== 403 || r.body?.error !== 'bad_token') return r
  const failed = await fetchToken()
  return failed ?? send()
}

export function postJson(url, body = {}) {
  return withToken(() => post(url, body))
}

export function getJsonWithToken(url) {
  return withToken(() => getJson(url, undefined, { 'x-buracle-token': token }))
}

export function errorText(r) {
  if (typeof r.body?.message === 'string' && r.body.message !== '') return r.body.message
  if (r.status === 0) return t('state.noServer')
  if (r.status === 404 || r.status === 405) return t('write.missingApi')
  return t('write.failed', { status: r.status })
}

export function errorBlock(r) {
  const fix = typeof r.body?.fix === 'string' && r.body.fix !== '' ? r.body.fix : null
  return h('div', { class: 'form-err', role: 'alert' },
    h('p', null, icon('alert', 'icon xs'), h('span', null, errorText(r))),
    fix !== null ? h('code', { class: 'fix' }, fix) : null)
}

function tOr(key, fallback) {
  const s = t(key)
  return s === key ? fallback : s
}

function button(label, attrs = {}) {
  return h('button', { type: 'button', class: 'btn sm', ...attrs }, label)
}

function isOff(b) {
  return b.getAttribute('aria-disabled') === 'true'
}

function setOff(buttons, off) {
  for (const b of buttons) {
    if (b === null) continue
    if (off) b.setAttribute('aria-disabled', 'true')
    else b.removeAttribute('aria-disabled')
  }
}

function section(title, ...children) {
  return h('section', { class: 'sec' }, h('h3', null, title), ...children)
}

function props(rows) {
  return h('dl', { class: 'props' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]))
}

const LEVELS = new Set(['ok', 'warn', 'error'])

export function createHealth(ctx) {
  const btn = document.getElementById('btn-health')
  const dot = document.getElementById('health-dot')
  let data = null
  let seq = 0
  let at = 0

  function paint() {
    const level = LEVELS.has(data?.health) ? data.health : 'unknown'
    dot.dataset.state = level
    const label = `${t('btn.health')}: ${t(`health.state.${level}`)}`
    btn.setAttribute('aria-label', label)
    btn.setAttribute('title', label)
  }

  async function refresh() {
    const scope = ctx.scope()
    if (scope === null) return { ok: false, status: 0, body: null }
    const mine = ++seq
    const r = await getJson(`/api/health?scope=${encodeURIComponent(scope)}`)
    if (mine !== seq) return r
    at = Date.now()
    data = r.ok ? r.body : null
    paint()
    return r
  }

  return {
    refresh,
    paint,
    stale: (ms) => Date.now() - at > ms,
    reset: () => { seq++; data = null; paint() },
  }
}

function holdLine(x, now) {
  const named = typeof x.window === 'string' ? tOr(`health.why.${x.window}`, null) : null
  const why = named !== null ? (typeof x.pct === 'number' ? `${named} (${num(x.pct)}%)` : named) : typeof x.why === 'string' ? x.why.replace(/^[a-z]+: /, '') : ''
  const parts = [t('health.held', { harness: String(x.harness ?? '?'), why })]
  if (typeof x.until === 'string' && x.until !== '') parts.push(t('health.resets', { t: relTime(x.until, now), at: fmtDate(x.until) }))
  return parts.join(' · ')
}

function pickLine(p) {
  const model = typeof p.model === 'string' && p.model !== '' ? p.model : t('model.defaultModel')
  const used = typeof p.used === 'number' ? ` · ${t('model.used', { pct: num(p.used) })}` : ''
  return `${String(p.harness ?? '?')} · ${model}${used}`
}

function harnessLists(picks, holds, now) {
  const ok = Array.isArray(picks) ? picks : []
  const held = Array.isArray(holds) ? holds : []
  return [
    ok.length > 0
      ? h('ul', { class: 'held' }, ok.map((p, i) => h('li', null, icon(i === 0 ? 'check' : 'clock', 'icon xs'), h('span', null, pickLine(p)))))
      : h('p', { class: 'warn-text' }, t(held.length > 0 ? 'model.noneFree' : 'model.noneKnown')),
    held.length > 0 ? h('ul', { class: 'held' }, held.map(x => h('li', null, icon('alert', 'icon xs'), h('span', null, holdLine(x, now))))) : null,
  ]
}

function reasonItem(r) {
  return h('li', { class: 'is-error' },
    h('p', { class: 'hr-title' }, icon('alert', 'icon xs'), h('span', null, tOr(`health.reason.${r.code}`, String(r.code)))),
    r.detail ? h('p', { class: 'hr-detail' }, r.detail) : null,
    typeof r.fix === 'string' && r.fix !== '' ? h('code', { class: 'fix' }, r.fix) : null)
}

function storeSection(data) {
  const store = data.store ?? {}
  const mcp = typeof data.mcp === 'string' ? data.mcp : 'unknown'
  const last = data.lastCapture
  return section(t('health.brain'), props([
    [t('health.store'), store.ok ? h('span', null, t('health.storeOk'), store.version ? ` · ${store.version}` : '') : h('span', { class: 'warn-text' }, t('health.storeBad'))],
    [t('health.mcp'), mcp === 'down' ? h('span', { class: 'warn-text' }, t('health.mcp.down')) : tOr(`health.mcp.${mcp}`, mcp)],
    [t('health.captures'), num(data.captures ?? 0)],
    [t('health.lastCapture'), last !== undefined && last !== null ? h('time', { datetime: last.at, title: fmtDate(last.at) }, relTime(last.at, Date.now())) : t('health.noCapture')],
  ]))
}

function sizeText(bytes) {
  const n = typeof bytes === 'number' && bytes > 0 ? bytes : 0
  return n < 1024 * 1024 ? `${num(Math.max(1, Math.round(n / 1024)))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

function migrationItem(mig) {
  const failed = mig.state === 'failed'
  return h('li', { class: failed ? 'is-error' : 'is-warn' },
    h('p', { class: 'hr-title' }, icon('alert', 'icon xs'), h('span', null, t(`health.migration.${mig.state}`))),
    failed && typeof mig.error === 'string' ? h('p', { class: 'hr-detail' }, mig.error) : null,
    typeof mig.fix === 'string' && mig.fix !== '' ? h('code', { class: 'fix' }, mig.fix) : null)
}

function migrationRows(mig) {
  if (mig === undefined || mig === null) return []
  const finished = mig.state === 'complete' && typeof mig.finishedAt === 'string' ? t('health.migrationFinished', { t: relTime(mig.finishedAt, Date.now()) }) : tOr(`health.migration.${mig.state}`, String(mig.state))
  return [
    [t('health.migration'), mig.state === 'failed' ? h('span', { class: 'warn-text' }, finished) : finished],
    mig.legacy > 0 ? [t('health.legacyWaiting', { n: num(mig.legacy) }), null] : null,
    mig.keptLegacy ? [t('health.legacyKept'), null] : null,
  ]
}

function brainFileSection(data) {
  const b = data.brain
  const rows = []
  if (b !== undefined && b !== null) {
    const slugs = Object.keys(b.projects ?? {})
    rows.push([t('health.file'), h('code', null, String(b.file ?? ''))])
    rows.push([t('health.size'), sizeText(b.bytes)])
    rows.push([t('health.buckets'), h('ul', { class: 'buckets' },
      h('li', null, t('health.bucketPerson'), ' · ', t('health.bucketCount', { n: num(b.person ?? 0) })),
      slugs.map(slug => h('li', null, h('code', null, slug), ' · ', t('health.bucketCount', { n: num(b.projects[slug]) }))))])
  }
  const mig = migrationRows(data.migration).filter(Boolean)
  return section(t('health.brainFile'),
    h('p', { class: 'set-lead' }, t('health.brainFileLead')),
    rows.length > 0 ? props(rows) : h('p', { class: 'empty' }, t('health.noBrainFile')),
    mig.length > 0 ? h('ul', { class: 'notes' }, mig.map(([k, v]) => h('li', null, v === null ? k : [k, ': ', v]))) : null)
}

function backupSection(b, ctx, now) {
  if (b === undefined || b === null) return null
  const list = Array.isArray(b.list) ? b.list : []
  const note = h('div', { class: 'note-box' })
  const make = button(t('health.backupNow'), { 'data-key': 'backup' })
  make.addEventListener('click', async () => {
    if (isOff(make)) return
    setOff([make], true)
    make.setAttribute('aria-busy', 'true')
    fill(note, h('p', { class: 'note' }, t('health.backingUp')))
    const r = await postJson('/api/backup', { scope: ctx.scope() })
    make.removeAttribute('aria-busy')
    setOff([make], false)
    if (!r.ok) { fill(note, errorBlock(r)); return }
    const msg = t('health.backedUp', { id: String(r.body?.id ?? ''), n: num(r.body?.buckets ?? 0) })
    ctx.announce(msg)
    ctx.refresh(msg)
  })
  const mine = list.find(x => x.here === true)
  return section(t('health.backups'),
    h('p', { class: 'set-lead' }, t('health.backupsLead')),
    list.length > 0
      ? h('ul', { class: 'steps' }, list.map(x => h('li', { class: 'is-ok' },
        icon(x.here === true ? 'check' : 'clock', 'icon xs'),
        h('span', null,
          h('b', null, String(x.id ?? '')), ' · ',
          h('time', { datetime: x.at, title: fmtDate(x.at) }, relTime(x.at, now)), ' · ',
          h('span', { class: 'meta-inline' }, [
            tOr(`health.backup.${x.trigger}`, String(x.trigger ?? '')),
            t(x.buckets === 1 ? 'health.backupBucket' : 'health.backupBuckets', { n: num(x.buckets ?? 0), size: sizeText(x.bytes) }),
            x.here === true ? t('health.backupHere') : '',
          ].filter(Boolean).join(' · '))))))
      : h('p', { class: 'empty' }, t('health.noBackups')),
    mine !== undefined && typeof b.restore === 'string' ? h('p', { class: 'meta' }, t('health.restoreHint')) : null,
    mine !== undefined && typeof b.restore === 'string' ? h('code', { class: 'fix' }, b.restore) : null,
    h('div', { class: 'btn-row' }, make),
    note)
}

function projectSection(p, ctx) {
  if (p === undefined || p === null) return null
  const slug = String(p.slug ?? '')
  const folders = Array.isArray(p.roots) ? p.roots : []
  const n = typeof p.memories === 'number' ? p.memories : 0
  const rows = [
    [t('health.projectId'), h('code', null, slug)],
    typeof p.name === 'string' && p.name !== '' ? [t('health.projectRepo'), p.name] : null,
    [t('health.projectFolders'), folders.length > 0
      ? h('ul', { class: 'folders' }, folders.map(f => h('li', null, h('code', null, String(f.path ?? '')), f.exists === false ? h('span', { class: 'badge warn' }, t('health.folderMissing')) : null)))
      : t('health.noFolders')],
    [t('health.projectMemories'), num(n)],
  ]
  const note = h('div', { class: 'note-box' })
  const remove = button([icon('trash', 'icon xs'), t('health.removeProject')], { class: 'btn sm danger', 'data-key': 'remove-project' })
  const yes = button(t('health.removeYes'), { class: 'btn sm danger', 'data-key': 'remove-confirm' })
  const no = button(t('act.cancel'), { class: 'btn sm quiet', 'data-key': 'remove-cancel' })
  const confirm = h('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'remove-confirm-text', hidden: true },
    h('p', { id: 'remove-confirm-text' }, t('health.removeConfirm', { slug, n: num(n) })),
    h('div', { class: 'btn-row' }, yes, no))
  const all = [remove, yes, no]
  const closeConfirm = () => {
    confirm.hidden = true
    remove.focus()
  }
  remove.addEventListener('click', () => {
    if (isOff(remove)) return
    confirm.hidden = false
    no.focus()
  })
  no.addEventListener('click', () => { if (!isOff(no)) closeConfirm() })
  yes.addEventListener('click', async () => {
    if (isOff(yes)) return
    setOff(all, true)
    yes.setAttribute('aria-busy', 'true')
    fill(note, h('p', { class: 'note' }, t('health.removing')))
    const r = await postJson('/api/project/remove', { scope: ctx.scope() })
    if (!r.ok) {
      setOff(all, false)
      yes.removeAttribute('aria-busy')
      confirm.hidden = true
      fill(note, errorBlock(r))
      remove.focus()
      return
    }
    const msg = t('health.removed', { slug: String(r.body?.slug ?? slug), n: num(typeof r.body?.memories === 'number' ? r.body.memories : n) })
    ctx.announce(msg)
    ctx.projectRemoved?.(msg)
  })
  confirm.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    e.preventDefault()
    if (!isOff(no)) closeConfirm()
  })
  return section(t('health.project'),
    h('p', { class: 'set-lead' }, t('health.projectLead')),
    props(rows),
    h('div', { class: 'btn-row' }, remove),
    confirm,
    note)
}

export function healthView(body, data, ctx, now) {
  const level = data.migration?.state === 'failed' ? 'error' : LEVELS.has(data.health) ? data.health : 'warn'
  const reasons = Array.isArray(data.reasons) ? data.reasons : []
  const migrating = data.migration?.state === 'failed' || data.migration?.state === 'running'
  const settings = button(t('health.openSettings'), { class: 'btn sm quiet', 'data-key': 'settings' })
  settings.addEventListener('click', () => ctx.open('settings'))
  fill(body,
    h('p', { class: `health-head is-${level}` }, icon(level === 'ok' ? 'check' : 'alert', 'icon'), h('span', null, t(`health.head.${level}`))),
    data.computedAt ? h('p', { class: 'meta' }, t('health.checked', { t: relTime(data.computedAt, now) })) : null,
    reasons.length > 0 ? section(t('health.reasons'), h('ul', { class: 'hreasons' }, reasons.map(reasonItem))) : null,
    migrating ? section(t('health.migration'), h('ul', { class: 'hreasons' }, migrationItem(data.migration))) : null,
    storeSection(data),
    brainFileSection(data),
    backupSection(data.backups, ctx, now),
    projectSection(data.project, ctx),
    h('div', { class: 'btn-row sec' }, settings))
  return { kicker: t(`health.state.${level}`), title: t('health.title') }
}

function group(g, rows) {
  const lead = tOr(`settings.groupLead.${g}`, null)
  return h('fieldset', { class: 'set-group' },
    h('legend', null, h('h3', null, tOr(`settings.group.${g}`, g))),
    lead !== null ? h('p', { class: 'set-lead' }, lead) : null,
    ...rows)
}

function modelGroup(m, now) {
  const headroom = m.headroom ?? {}
  const rows = [
    props([[t('model.rule'), t('model.ruleLine', { h5: num(headroom.max5hPct ?? 0), d7: num(headroom.max7dPct ?? 0) })]]),
    h('h4', null, t('model.now')),
    ...harnessLists(m.harnesses, m.held, now),
  ]
  return group('llm', rows)
}

export function settingsView(body, data, ctx) {
  const now = Date.now()
  const m = data.model ?? {}
  fill(body,
    h('p', { class: 'lead' }, t('settings.lead')),
    switchesGroup(data.workflow, ctx, { postJson, errorText }),
    modelGroup(m, now),
    data.ui && typeof data.ui.port === 'number' ? h('p', { class: 'meta' }, t('settings.port', { port: String(data.ui.port) }), data.file ? h('span', null, ' · ', t('settings.file'), ' ', h('code', null, String(data.file))) : null) : null)
  return { kicker: t('settings.kicker'), title: t('settings.title') }
}

const PROTECTED = new Set(['core', 'profile'])

export function memoryActions(m, ctx) {
  if (PROTECTED.has(m.kind) || typeof ctx.memoryScope !== 'string' || typeof ctx.memoryChanged !== 'function') return null
  const flip = m.status === 'active' ? 'retire' : m.status === 'deprecated' ? 'restore' : null
  const msg = h('div', { class: 'note-box' })
  const flipBtn = flip !== null ? button(t(`act.${flip}`), { class: 'btn sm quiet', 'data-key': 'flip' }) : null
  const delBtn = button([icon('trash', 'icon xs'), t('act.delete')], { class: 'btn sm danger', 'data-key': 'delete' })
  const yes = button(t('act.confirmDelete'), { class: 'btn sm danger', 'data-key': 'confirm' })
  const no = button(t('act.cancel'), { class: 'btn sm quiet', 'data-key': 'cancel' })
  const confirm = h('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'act-confirm-text', hidden: true },
    h('p', { id: 'act-confirm-text' }, t('act.confirm')),
    h('div', { class: 'btn-row' }, yes, no))
  const all = [flipBtn, delBtn, yes, no]

  const run = async (op) => {
    setOff(all, true)
    fill(msg, h('p', { class: 'note' }, t('act.working')))
    const r = await postJson(`/api/memory/${op}`, { scope: ctx.memoryScope, id: m.id })
    if (!r.ok) {
      setOff(all, false)
      confirm.hidden = true
      fill(msg, errorBlock(r))
      const back = op === 'delete' ? delBtn : flipBtn
      back?.focus()
      return
    }
    ctx.announce(t(`act.done.${op}`, { title: m.title }))
    ctx.memoryChanged(op)
  }
  const closeConfirm = () => {
    confirm.hidden = true
    delBtn.focus()
  }

  flipBtn?.addEventListener('click', () => { if (!isOff(flipBtn)) void run(flip) })
  delBtn.addEventListener('click', () => {
    if (isOff(delBtn)) return
    confirm.hidden = false
    no.focus()
  })
  yes.addEventListener('click', () => { if (!isOff(yes)) void run('delete') })
  no.addEventListener('click', () => { if (!isOff(no)) closeConfirm() })
  confirm.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    e.preventDefault()
    if (!isOff(no)) closeConfirm()
  })
  return h('section', { class: 'sec' },
    h('h3', null, t('act.title')),
    h('p', { class: 'set-lead' }, t(flip === 'restore' ? 'act.leadRetired' : flip === 'retire' ? 'act.lead' : 'act.leadDelete')),
    h('div', { class: 'btn-row' }, flipBtn, delBtn),
    confirm,
    msg)
}

const REVIEWS = ['pending', 'ok']

function listText(list) {
  return Array.isArray(list) ? list.join(', ') : ''
}

function listOf(text) {
  return [...new Set(String(text).split(',').map(x => x.trim()).filter(x => x !== ''))]
}

function sameList(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function formField(id, label, control, help) {
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    control,
    help !== undefined ? h('p', { class: 'field-help', id: `${id}-help` }, help) : null)
}

/**
 * The form that corrects a memory: it replaces the detail in the panel, sends only what changed to /api/memory/update with the
 * version it read, and shows the server's own error (a stale version, a refused edit) under the buttons.
 */
export function memoryEditor(body, m, ctx, back) {
  const field = (k) => `edit-${k}`
  const text = (k, value, extra = {}) => h('input', { class: 'inp', id: field(k), type: 'text', value, autocomplete: 'off', 'aria-describedby': `${field(k)}-help`, ...extra })
  const title = text('title', m.title, { maxlength: 200, required: true })
  const summary = text('summary', m.summary, { maxlength: 300 })
  const bodyBox = h('textarea', { class: 'inp', id: field('body'), rows: 10, 'aria-describedby': `${field('body')}-help`, spellcheck: 'false' }, m.body)
  const tags = text('tags', listText(m.tags), { spellcheck: 'false' })
  const about = text('about', listText(m.about), { spellcheck: 'false' })
  const level = h('select', { class: 'inp', id: field('importance') }, [1, 2, 3, 4, 5].map(n => h('option', { value: n, selected: n === m.importance }, t('edit.importanceOption', { n }))))
  const review = h('select', { class: 'inp', id: field('review'), 'aria-describedby': `${field('review')}-help` }, REVIEWS.map(r => h('option', { value: r, selected: r === m.review }, t(r === 'ok' ? 'edit.reviewOk' : 'edit.reviewPending'))))
  const save = h('button', { type: 'submit', class: 'btn sm', 'data-key': 'save' }, t('edit.save'))
  const cancel = h('button', { type: 'button', class: 'btn sm quiet', 'data-key': 'cancel-edit' }, t('edit.cancel'))
  const note = h('div', { class: 'note-box', role: 'status' })
  const form = h('form', { class: 'edit-form', novalidate: true, 'aria-labelledby': 'edit-heading' },
    h('h3', { id: 'edit-heading', class: 'edit-heading' }, t('edit.heading')),
    h('p', { class: 'set-lead' }, t('edit.lead')),
    formField(field('title'), t('edit.title'), title, t('edit.helpTitle')),
    formField(field('summary'), t('edit.summary'), summary, t('edit.helpSummary')),
    formField(field('body'), t('edit.body'), bodyBox, t('edit.helpBody')),
    formField(field('tags'), t('edit.tags'), tags, t('edit.helpTags')),
    formField(field('about'), t('edit.about'), about, t('edit.helpAbout')),
    formField(field('importance'), t('edit.importance'), level),
    formField(field('review'), t('edit.review'), review, t('edit.helpReview')),
    h('div', { class: 'btn-row' }, save, cancel),
    note)

  // What the form holds that differs from the memory as it was read.
  const changes = () => {
    const patch = {}
    const claim = []
    if (title.value.trim() !== m.title) { patch.title = title.value.trim(); claim.push('title') }
    if (summary.value.trim() !== m.summary) { patch.summary = summary.value.trim(); claim.push('summary') }
    if (bodyBox.value.trim() !== m.body.trim()) { patch.body = bodyBox.value.trim(); claim.push('body') }
    if (!sameList(listOf(tags.value), m.tags)) patch.tags = listOf(tags.value)
    if (!sameList(listOf(about.value), m.about)) patch.about = listOf(about.value)
    if (Number(level.value) !== m.importance) patch.importance = Number(level.value)
    if (review.value !== m.review || (claim.length > 0 && review.value === 'ok')) patch.review = review.value
    return patch
  }
  const dirty = () => Object.keys(changes()).length > 0
  const all = [save, cancel]
  let busy = false

  cancel.addEventListener('click', () => { if (!busy) back() })
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    e.preventDefault()
    if (busy) return
    if (dirty()) fill(note, h('p', { class: 'note' }, t('edit.dirtyEscape')))
    else back()
  })
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (busy) return
    const patch = changes()
    if (patch.title === '') { title.focus(); fill(note, h('p', { class: 'form-err' }, t('edit.needTitle'))); return }
    if (Object.keys(patch).length === 0) { fill(note, h('p', { class: 'note' }, t('edit.nothing'))); return }
    busy = true
    setOff(all, true)
    save.setAttribute('aria-busy', 'true')
    fill(note, h('p', { class: 'note' }, t('edit.saving')))
    const r = await postJson('/api/memory/update', { scope: ctx.memoryScope, id: m.id, patch, expected_version: m.version })
    busy = false
    save.removeAttribute('aria-busy')
    setOff(all, false)
    if (!r.ok) {
      fill(note, errorBlock(r), r.status === 409 && typeof r.body?.version === 'number' ? h('p', { class: 'note' }, t('edit.conflict', { v: r.body.version })) : null)
      return
    }
    ctx.announce(t('edit.saved', { title: patch.title ?? m.title }))
    ctx.memoryChanged('update')
  })
  fill(body, form)
  body.scrollTop = 0
  title.focus({ preventScroll: true })
  title.select()
}
