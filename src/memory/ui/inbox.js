import { fill, getJson, h, icon } from './dom.js'
import { fmtDate, num, relTime, t } from './i18n.js'
import { errorBlock, postJson } from './manage.js'
import { harnessName } from './work.js'

const POLL_MS = 30_000
const view = { unread: false }

function typeLabel(type) {
  const s = t(`inbox.type.${type}`)
  return s === `inbox.type.${type}` ? String(type) : s
}

export function createInbox(opts) {
  const btn = document.getElementById('btn-inbox')
  const badge = document.getElementById('inbox-count')
  let unread = 0
  let loaded = false
  let timer = 0

  function paint() {
    badge.hidden = unread === 0
    badge.textContent = unread > 99 ? '99+' : String(unread)
    const label = unread > 0 ? `${t('btn.inbox')}: ${t('inbox.unreadCount', { n: num(unread) })}` : t('btn.inbox')
    btn.setAttribute('aria-label', label)
    btn.setAttribute('title', label)
  }

  async function refresh() {
    const r = await getJson('/api/notifications')
    if (r.ok && typeof r.body?.unread === 'number') {
      const before = unread
      unread = r.body.unread
      paint()
      if (loaded && unread > before) opts?.arrived?.(unread - before)
      loaded = true
    }
    return r
  }

  function start() {
    clearInterval(timer)
    timer = setInterval(() => { if (!document.hidden) void refresh() }, POLL_MS)
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() })
  paint()
  return { refresh, start, set: (n) => { unread = n; paint() } }
}

function item(e, ctx, now, done) {
  const note = h('div', { class: 'note-box' })
  const read = e.read ? null : h('button', { type: 'button', class: 'btn sm quiet', 'data-key': `read-${e.id}` }, t('inbox.markRead'))
  read?.addEventListener('click', async () => {
    read.setAttribute('aria-disabled', 'true')
    const r = await postJson('/api/notifications/read', { ids: [e.id] })
    if (!r.ok) { read.removeAttribute('aria-disabled'); fill(note, errorBlock(r)); return }
    done(r.body?.unread)
  })
  const plan = typeof e.plan === 'string' ? h('span', null, icon('file', 'icon xs'), ' ', h('code', null, e.plan)) : null
  const open = typeof e.reviewDoc === 'string' && typeof ctx.openPlan === 'function' ? h('button', { type: 'button', class: 'link', 'data-key': `plan-${e.id}` }, t('inbox.openPlan')) : null
  open?.addEventListener('click', () => ctx.openPlan(e.reviewDoc))
  return h('li', { class: `inbox-item${e.read ? '' : ' is-unread'}` },
    h('i', { class: 'inbox-mark', 'aria-hidden': 'true' }),
    h('div', { class: 'inbox-body' },
      h('span', { class: 'inbox-top' },
        h('span', null, typeLabel(e.type), e.harness ? ` · ${harnessName(e.harness)}` : '', e.read ? '' : h('span', { class: 'sr-only' }, ` · ${t('inbox.unread')}`)),
        h('time', { datetime: e.ts, title: fmtDate(e.ts) }, relTime(e.ts, now))),
      h('strong', { class: 'inbox-title' }, e.title),
      e.message ? h('span', { class: 'inbox-msg' }, e.message) : null,
      e.folder || plan ? h('span', { class: 'inbox-meta' }, e.folder ? h('code', null, e.folder) : null, plan, open) : null,
      read ? h('div', { class: 'btn-row' }, read) : null,
      note))
}

export function inboxView(body, data, ctx, now) {
  const items = Array.isArray(data.items) ? data.items : []
  const unread = typeof data.unread === 'number' ? data.unread : items.filter(e => !e.read).length
  const after = (n) => {
    if (typeof n === 'number') ctx.inbox?.set(n)
    ctx.refresh(null)
  }
  const all = h('button', { type: 'button', class: 'btn sm quiet', 'data-key': 'read-all', 'aria-disabled': unread === 0 ? 'true' : undefined }, t('inbox.markAll'))
  const note = h('div', { class: 'note-box' })
  all.addEventListener('click', async () => {
    if (all.getAttribute('aria-disabled') === 'true') return
    all.setAttribute('aria-disabled', 'true')
    const r = await postJson('/api/notifications/read', { all: true })
    if (!r.ok) { all.removeAttribute('aria-disabled'); fill(note, errorBlock(r)); return }
    ctx.announce(t('inbox.allRead'))
    after(r.body?.unread)
  })
  const only = h('button', { type: 'button', class: 'filter', 'data-key': 'unread-only', 'aria-pressed': String(view.unread) }, t('inbox.unreadOnly'), h('b', null, num(unread)))
  only.addEventListener('click', () => { view.unread = !view.unread; ctx.refresh(null) })
  const shown = view.unread ? items.filter(e => !e.read) : items
  fill(body,
    h('p', { class: 'set-lead' }, t('inbox.lead')),
    h('div', { class: 'toolbar' }, h('div', { class: 'filters' }, only), h('span', { class: 'grow' }), all),
    note,
    shown.length > 0 ? h('ul', { class: 'inbox-list' }, shown.map(e => item(e, ctx, now, after))) : h('p', { class: 'empty' }, t(view.unread && items.length > 0 ? 'inbox.noneUnread' : 'inbox.none')),
    h('p', { class: 'meta' }, t('inbox.cli'), ' ', h('code', null, 'buracle notify list --unread')))
  return { kicker: unread > 0 ? t('inbox.unreadCount', { n: num(unread) }) : t('inbox.allClear'), title: t('inbox.title') }
}
