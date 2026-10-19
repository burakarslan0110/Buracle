import { icon } from './dom.js'
import { t } from './i18n.js'

const KEY = 'buracle.brain.theme'
const PAGE_COLOR = { dark: '#05060a', light: '#f4f5f9' }
const system = matchMedia('(prefers-color-scheme: light)')

export function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

function chosen() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch { return null }
}

export function createTheme(button, onChange) {
  function apply(theme, remember) {
    document.documentElement.dataset.theme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PAGE_COLOR[theme])
    if (remember) { try { localStorage.setItem(KEY, theme) } catch {  } }
    const label = t(theme === 'light' ? 'btn.themeDark' : 'btn.themeLight')
    button.setAttribute('aria-label', label)
    button.setAttribute('title', label)
    button.replaceChildren(icon(theme === 'light' ? 'moon' : 'sun'))
    onChange(theme)
  }
  const toggle = () => apply(currentTheme() === 'light' ? 'dark' : 'light', true)
  button.addEventListener('click', toggle)
  system.addEventListener('change', (e) => { if (chosen() === null) apply(e.matches ? 'light' : 'dark', false) })
  apply(currentTheme(), false)
  return { toggle, get theme() { return currentTheme() } }
}
