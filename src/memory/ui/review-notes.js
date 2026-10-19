import { h, icon } from './dom.js'
import { fmtDate, relTime, t } from './i18n.js'
import { errorText, postJson } from './manage.js'

export const NOTE_MAX = 4000

export function addNote(target, fields) {
  return postJson('/api/review/note/add', { ...target, ...fields })
}

function editNote(target, id, text) {
  return postJson('/api/review/note/edit', { ...target, id, text })
}

function deleteNote(target, id) {
  return postJson('/api/review/note/delete', { ...target, id })
}

export function clip(s, n) {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function failure(el, r) {
  el.hidden = false
  el.replaceChildren(h('p', null, icon('alert', 'icon xs'), h('span', null, errorText(r))))
}

function quoteEl(quote, code) {
  return code ? h('pre', { class: 'note-quote code-quote' }, String(quote).split('\n').slice(0, 8).join('\n')) : h('p', { class: 'note-quote' }, clip(quote, 320))
}

export function composer({ quote, code = false, where, initial = '', label, onSave, onCancel }) {
  const area = h('textarea', { class: 'note-input', name: 'note', rows: 4, maxlength: NOTE_MAX, 'aria-label': label ?? t('review.noteLabel'), placeholder: t('review.notePlaceholder') })
  area.value = initial
  const err = h('div', { class: 'form-err', role: 'alert', hidden: true })
  const save = h('button', { type: 'button', class: 'btn sm' }, t('review.save'))
  const cancel = h('button', { type: 'button', class: 'btn sm quiet' }, t('act.cancel'))
  const el = h('div', { class: 'composer', role: 'group', 'aria-label': label ?? t('review.newNote') },
    quote ? quoteEl(quote, code) : null,
    where ? h('p', { class: 'note-meta' }, where) : null,
    area, err,
    h('div', { class: 'composer-actions' }, save, cancel, h('span', { class: 'composer-hint' }, t('review.saveHint'))))
  let busy = false
  const submit = async () => {
    if (busy) return
    const text = area.value.trim()
    if (text === '') { area.focus(); return }
    busy = true
    save.disabled = true
    save.textContent = t('act.working')
    const r = await onSave(text)
    busy = false
    save.disabled = false
    save.textContent = t('review.save')
    if (r !== undefined && !r.ok) failure(err, r)
  }
  save.addEventListener('click', () => { void submit() })
  cancel.addEventListener('click', () => onCancel())
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
  })
  requestAnimationFrame(() => area.focus({ preventScroll: true }))
  return el
}

export function noteCard(n, ctx) {
  const done = n.done !== undefined
  const card = h('article', { class: `note${done ? ' is-done' : ''}`, 'data-note': n.id, tabindex: '-1', 'aria-label': t(done ? 'review.noteDoneLabel' : 'review.noteOpenLabel', { where: ctx.where(n) }) })
  const meta = h('p', { class: 'note-meta' },
    h('span', null, ctx.where(n)),
    h('i', { class: 'sep', 'aria-hidden': 'true' }, '·'),
    h('time', { datetime: n.at, title: fmtDate(n.at) }, relTime(n.at)),
    n.edited !== undefined ? h('span', null, t('review.edited')) : null)
  const state = done
    ? h('span', { class: 'badge ok-badge' }, icon('check', 'icon xs'), t('review.applied', { t: relTime(n.done) }))
    : h('span', { class: 'badge' }, t('review.open'))
  const body = h('div', { class: 'note-body' })
  const showText = () => body.replaceChildren(h('p', { class: 'note-text' }, n.text))
  showText()
  const err = h('div', { class: 'form-err', role: 'alert', hidden: true })
  const actions = h('div', { class: 'note-actions' })
  const restore = () => { showText(); actions.hidden = false; err.hidden = true }
  const edit = h('button', { type: 'button', class: 'link' }, t('review.edit'))
  edit.addEventListener('click', (e) => {
    e.stopPropagation()
    actions.hidden = true
    body.replaceChildren(composer({
      initial: n.text, label: t('review.editNote'),
      onSave: async (text) => {
        const r = await editNote(ctx.target, n.id, text)
        if (r.ok) { ctx.changed(r.body, t('review.savedEdit')); return r }
        return r
      },
      onCancel: restore,
    }))
  })
  const del = h('button', { type: 'button', class: 'link danger-link' }, t('review.delete'))
  del.addEventListener('click', (e) => {
    e.stopPropagation()
    actions.hidden = true
    const yes = h('button', { type: 'button', class: 'btn sm danger' }, t('review.delete'))
    const no = h('button', { type: 'button', class: 'btn sm quiet' }, t('act.cancel'))
    const box = h('div', { class: 'confirm' }, h('p', null, t(done ? 'review.deleteDoneAsk' : 'review.deleteAsk')), h('div', { class: 'composer-actions' }, yes, no))
    body.append(box)
    no.addEventListener('click', (ev) => { ev.stopPropagation(); box.remove(); actions.hidden = false })
    yes.addEventListener('click', async (ev) => {
      ev.stopPropagation()
      yes.disabled = true
      const r = await deleteNote(ctx.target, n.id)
      if (r.ok) ctx.changed(r.body, t('review.deleted'))
      else { box.remove(); actions.hidden = false; failure(err, r) }
    })
    requestAnimationFrame(() => no.focus())
  })
  if (!done) actions.append(edit)
  actions.append(del)
  card.append(h('div', { class: 'note-head' }, meta, state))
  if (n.quote) card.append(quoteEl(n.quote, n.kind === 'code'))
  card.append(body, err, actions)
  card.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('button, textarea, a')) return
    ctx.focus?.(n)
  })
  return card
}

export function notesList(notes, ctx) {
  const open = notes.filter((n) => n.done === undefined)
  const done = notes.filter((n) => n.done !== undefined).sort((a, b) => (b.done ?? '').localeCompare(a.done ?? ''))
  const wrap = h('div', { class: 'notes-list' })
  if (open.length === 0) wrap.append(h('p', { class: 'empty' }, ctx.emptyText))
  for (const n of open) wrap.append(noteCard(n, ctx))
  if (done.length > 0) {
    const det = h('details', { class: 'done-notes' }, h('summary', null, t('review.doneCount', { n: done.length })))
    for (const n of done) det.append(noteCard(n, ctx))
    wrap.append(det)
  }
  return wrap
}
