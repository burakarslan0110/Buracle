const TR_FOLD: Readonly<Record<string, string>> = {
  'ğ': 'g', 'Ğ': 'g', 'ü': 'u', 'Ü': 'u', 'ş': 's', 'Ş': 's', 'ı': 'i', 'I': 'i', 'İ': 'i',
  'ö': 'o', 'Ö': 'o', 'ç': 'c', 'Ç': 'c',
}

function fold(text: string): string {
  return text
    .replace(/[ğĞüÜşŞıIİöÖçÇ]/g, c => TR_FOLD[c] ?? c)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

export function slugify(title: string): string {
  const base = fold(title)
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (base === '') return 'note'
  if (base.length <= 60) return base
  let cut = base.slice(0, 60)
  if (base[60] !== '-') {
    const at = cut.lastIndexOf('-')
    if (at >= 30) cut = cut.slice(0, at)
  }
  return cut.replace(/-+$/g, '')
}

export function normalizeForSearch(text: string): string {
  return text
    .replace(/[İI]/g, 'i')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
}

export function memClip(text: string, max: number): string {
  if (max <= 0) return ''
  if (text.length <= max) return text
  if (max === 1) return '…'
  return text.slice(0, max - 1).replace(/\s+\S*$/, m => (m.length < 20 ? '' : m)) + '…'
}

export function memOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function memShortSid(sid: string): string {
  const alnum = sid.replace(/[^A-Za-z0-9]/g, '').toLowerCase()
  return alnum.length <= 6 ? (alnum === '' ? 'x' : alnum) : alnum.slice(-6)
}
