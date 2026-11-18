// Buracle Stack site: the theme toggle, the copy buttons and the tabs, on every page. Everything on the page reads and
// works without this file; it only shows the controls it wires (they carry `hidden` in the HTML). The landing page's
// motion and players live in home.js and graph.js.
(() => {
  const root = document.documentElement
  const KEY = 'buracle-theme'

  // Theme: the system setting until the visitor picks one; the pick is kept in localStorage.
  const system = window.matchMedia('(prefers-color-scheme: dark)')
  const current = () => root.getAttribute('data-theme') || (system.matches ? 'dark' : 'light')
  const toggle = document.querySelector('[data-theme-toggle]')
  if (toggle) {
    const label = () => toggle.setAttribute('aria-label', current() === 'dark' ? toggle.dataset.toLight : toggle.dataset.toDark)
    toggle.hidden = false
    label()
    toggle.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark'
      root.setAttribute('data-theme', next)
      try { localStorage.setItem(KEY, next) } catch { /* private mode: the pick lasts for this page */ }
      label()
    })
    system.addEventListener('change', label)
  }

  // Copy buttons: a command carries its text in data-copy; a code block copies its own text.
  const status = document.querySelector('[data-copy-status]')
  const say = (text) => {
    if (!status) return
    status.textContent = ''
    window.setTimeout(() => { status.textContent = text }, 30)
  }
  const fallback = (text) => {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    area.remove()
    return ok
  }
  for (const button of document.querySelectorAll('[data-copy-button]')) {
    const label = button.querySelector('[data-copy-label]')
    let timer = 0
    button.hidden = false
    button.addEventListener('click', async () => {
      const block = button.closest('.code, .cmd')
      const text = button.dataset.copy ?? (block?.querySelector('pre code')?.textContent ?? '').replace(/\n$/, '')
      let ok = false
      try {
        await navigator.clipboard.writeText(text)
        ok = true
      } catch {
        ok = fallback(text)
      }
      const message = ok ? root.dataset.copied : root.dataset.copyFailed
      if (label) label.textContent = message
      button.dataset.state = ok ? 'done' : 'failed'
      say(message)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (label) label.textContent = root.dataset.copy
        delete button.dataset.state
      }, 2000)
    })
  }

  // Tabs: roving tabindex, arrow keys, Home and End; the selected tab's panel is the only one shown.
  for (const tabs of document.querySelectorAll('[data-tabs]')) {
    const list = tabs.querySelector('[role="tablist"]')
    if (!list) continue
    const buttons = [...list.querySelectorAll('[role="tab"]')]
    const panels = buttons.map(b => document.getElementById(b.getAttribute('aria-controls')))
    const select = (k, focus) => {
      buttons.forEach((b, j) => {
        b.setAttribute('aria-selected', String(j === k))
        b.tabIndex = j === k ? 0 : -1
        if (panels[j]) panels[j].hidden = j !== k
      })
      if (focus) buttons[k].focus()
      tabs.dispatchEvent(new CustomEvent('tabchange', { detail: k }))
    }
    list.hidden = false
    tabs.classList.add('is-tabbed')
    select(Math.max(0, buttons.findIndex(b => b.getAttribute('aria-selected') === 'true')), false)
    buttons.forEach((b, j) => b.addEventListener('click', () => select(j, false)))
    list.addEventListener('keydown', (e) => {
      const k = buttons.indexOf(document.activeElement)
      if (k < 0) return
      const n = buttons.length
      const to = { ArrowRight: (k + 1) % n, ArrowDown: (k + 1) % n, ArrowLeft: (k - 1 + n) % n, ArrowUp: (k - 1 + n) % n, Home: 0, End: n - 1 }[e.key]
      if (to === undefined) return
      e.preventDefault()
      select(to, true)
    })
  }
})()
