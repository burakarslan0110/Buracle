import { fill, h, md } from './dom.js'
import { t } from './i18n.js'

function labelOf(key) {
  const s = t(`switch.${key}`)
  return s === `switch.${key}` ? key : s
}

function firstSentence(text) {
  const m = /^(.+?[.!?])(?:\s|$)/s.exec(String(text ?? '').trim())
  return m?.[1] ?? String(text ?? '')
}

function idOf(key) {
  return `sw-${key.replace(/[^a-z0-9]+/gi, '-')}`
}

function about(sw) {
  if (typeof sw.description !== 'string' || sw.description === '') return null
  const first = firstSentence(sw.description)
  const rest = sw.description.trim().slice(first.length).trim()
  return [h('div', { class: 'md' }, md(first)), rest !== '' ? h('details', { class: 'md' }, h('summary', null, t('switch.more')), md(rest)) : null]
}

function stateLine(sw) {
  return sw.value === sw.default ? '' : t('switch.changed', { value: String(sw.default) })
}

async function save(sw, value, msg, ctx) {
  fill(msg, t('switch.saving'))
  msg.className = 'field-msg'
  const r = await ctx.api.postJson('/api/settings', { key: sw.key, value })
  if (!r.ok) {
    msg.className = 'field-msg is-err'
    fill(msg, ctx.api.errorText(r))
    return false
  }
  sw.value = value
  msg.className = 'field-msg is-ok'
  fill(msg, r.body?.changed === false ? t('switch.unchanged') : t('switch.saved'))
  ctx.announce(t('switch.savedFor', { key: labelOf(sw.key) }))
  return true
}

function boolField(sw, ctx) {
  const id = idOf(sw.key)
  const input = h('input', { type: 'checkbox', id, role: 'switch', 'data-key': id, ...(sw.value === true ? { checked: true } : {}) })
  const msg = h('span', { class: 'field-msg', 'aria-live': 'polite' }, stateLine(sw))
  input.addEventListener('change', async () => {
    input.disabled = true
    const ok = await save(sw, input.checked, msg, ctx)
    if (!ok) input.checked = sw.value === true
    input.disabled = false
  })
  return h('div', { class: 'field is-bool' },
    h('div', { class: 'field-text' },
      h('label', { for: id }, labelOf(sw.key)),
      h('span', { class: 'switch-key' }, h('code', null, sw.key)),
      about(sw),
      msg),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' })))
}

function enumField(sw, ctx) {
  const id = idOf(sw.key)
  const msg = h('span', { class: 'field-msg', 'aria-live': 'polite' }, stateLine(sw))
  const radios = (sw.values ?? []).map(v => {
    const rid = `${id}-${v}`
    const input = h('input', { type: 'radio', id: rid, name: id, value: v, 'data-key': rid, ...(sw.value === v ? { checked: true } : {}) })
    input.addEventListener('change', async () => {
      if (!input.checked) return
      for (const r of radios) r.input.disabled = true
      const ok = await save(sw, v, msg, ctx)
      if (!ok) for (const r of radios) r.input.checked = r.value === sw.value
      for (const r of radios) r.input.disabled = false
    })
    return { value: v, input, el: h('div', { class: 'choice' }, input, h('label', { for: rid }, v)) }
  })
  return h('fieldset', { class: 'choices' },
    h('legend', null, labelOf(sw.key)),
    h('span', { class: 'switch-key' }, h('code', null, sw.key)),
    about(sw),
    h('div', { class: 'field-row' }, radios.map(r => r.el)),
    msg)
}

export function switchesGroup(w, ctx, api) {
  if (w === undefined || w === null) return null
  ctx = { ...ctx, api }
  const list = Array.isArray(w.switches) ? w.switches : []
  return h('fieldset', { class: 'set-group' },
    h('legend', null, h('h3', null, t('settings.group.workflow'))),
    h('p', { class: 'set-lead' }, t('settings.groupLead.workflow')),
    typeof w.error === 'string' ? h('p', { class: 'warn-text' }, w.error) : null,
    Array.isArray(w.problems) && w.problems.length > 0 ? h('p', { class: 'warn-text' }, t('switch.problems', { n: String(w.problems.length) })) : null,
    list.map(sw => (sw.type === 'enum' ? enumField(sw, ctx) : boolField(sw, ctx))),
    typeof w.file === 'string' ? h('p', { class: 'field-help' }, t('switch.file'), ' ', h('code', null, w.file)) : null)
}
