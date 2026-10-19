export function fold(s: string): string {
  return s
    .replace(/[İIı]/g, 'i')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘ʼ´`]/g, "'")
    .replace(/ß/g, 'ss')
    .replace(/[øœ]/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n[\s]*/g, '\n')
    .trim()
}

export function stripQuoted(s: string): string {
  return s
    .replace(/(^|\n)\s*(```|~~~)[\s\S]*?(\n\s*\2|$)/g, '$1 ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/"[^"\n]{0,400}"/g, ' ')
    .replace(/“[^”\n]{0,400}”/g, ' ')
    .replace(/«[^»\n]{0,400}»/g, ' ')
    .replace(/(^|\n)\s*>[^\n]*/g, '$1 ')
}

export function word(body: string): string {
  return `(?<![a-z0-9_'-])(?:${body})(?![a-z0-9_'-])`
}
