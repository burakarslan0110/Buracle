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

interface Rule { kind: string; re: RegExp; keep?: (m: RegExpExecArray) => { prefix: string, suffix: string } | undefined }

const REF = String.raw`(?!\[REDACTED)(?!\$\{?[A-Za-z_])(?!\$\()(?!\{\{)(?!<[A-Za-z_])(?!process\.env)(?!os\.environ)`

const TR_LETTERS = 'çğıöşüÇĞİÖŞÜ'
const BARE_PASS = String.raw`(?:(?<=[A-Za-z0-9][_.-])|(?<=(?:^|[\n{,["'])[ \t]*))(?:pass|pwd)(?![A-Za-z])`
const KEY_WORDS = String.raw`api[_-]?key|apikey|secret|token(?!i[sz](?:e|ation))|password|passwd|pass[_-]?phrase|${BARE_PASS}|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|private[_-]?key|client[_-]?secret|auth(?!or(?!iz)|enticat(?:ion|ed))|credentials?`
const TR_WORDS = String.raw`[şsŞS][iİıI]fre|parola|g[iİıI]zl[iİıI](?:[ _-]?anahtar)?|anahtar|jeton`
const PASS_WORDS = String.raw`password|passwd|pass[_-]?phrase|[şsŞS][iİıI]fre|parola|g[iİıI]zl[iİıI][ _-]?anahtar`
const KEY_SUFFIX = `[A-Za-z0-9_${TR_LETTERS}]{0,32}`
const WORD_START = `(?<![A-Za-z0-9_${TR_LETTERS}])`
const ARG = String.raw`(?![-<>|&;()])(?:[^\s'"]{1,512}|'[^'\n]{0,512}'|"[^"\n]{0,512}")`

const PASS_RE = new RegExp(PASS_WORDS, 'i')
const URL_GENERIC_PARAMS = String.raw`key|sig|signature|x-amz-signature|x-goog-signature|hmac`
const URL_SECRET_PARAMS = String.raw`api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|x-amz-security-token|client[_-]?secret|secret|password|passwd|pwd|auth`
const URL_GENERIC_RE = new RegExp(String.raw`^[?&](?:${URL_GENERIC_PARAMS})=$`, 'i')
const PROSE_LINK = String.raw`(?:is|was|is[ \t]+now|set[ \t]+to|olarak|ise)`

const PHRASE_WORD = String.raw`[\p{L}\p{N}][\p{L}\p{N}'’-]{0,39}`
const CODE_WORDS = /^(?:if|else|elif|return|await|typeof|instanceof|lambda|null|none|nil|undefined|function|def)$/i
const TYPE_WORDS = /^(?:string|str|int|integer|number|bool|boolean|text|varchar|char|bytes|required|optional|any|unknown|hidden|masked)$/i

function passphrase(value: string, keySuffix: string): boolean {
  if (!/^(?:[a-zçğıöşü]{0,4}|\d{1,2})$/.test(keySuffix)) return false
  const words = value.split(/[ \t]+/)
  if (words.some(w => PASS_RE.test(w) || CODE_WORDS.test(w)) || TYPE_WORDS.test(words[0] ?? '')) return false
  return words.join('').length >= 8
}

const unquote = (v: string): string => (/^(["']).*\1$/s.test(v) ? v.slice(1, -1) : v)
const isRef = (v: string): boolean => /^(?:\[REDACTED|\$\{?[A-Za-z_]|\$\(|\{\{|<[A-Za-z_]|process\.env|os\.environ)/.test(v)
const has = (m: RegExpExecArray, i: number): string => m[i] ?? ''
const secretArg = (v: string): boolean => { const u = unquote(v); return u !== '' && !isRef(u) }

function isBasicCredential(b64: string): boolean {
  try {
    const raw = atob(b64)
    return /^[^:\s]{0,256}:\S/.test(raw) && !/[\x00-\x08\x0e-\x1f]/.test(raw)
  } catch {
    return false
  }
}

const RULES: readonly Rule[] = [
  { kind: 'pem', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----|$)/g },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { kind: 'openai', re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { kind: 'gitlab', re: /\bgl(?:pat|dt|ptt|rt|cbt|oas|ft|imt|agent|soat|ffct)-[A-Za-z0-9_.-]{20,}/g },
  { kind: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g },
  { kind: 'slack', re: /\b(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}/g },
  { kind: 'slack', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: 'stripe', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'npm', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'twilio', re: /\bSK[0-9a-f]{32}\b/g },
  { kind: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}/g },
  { kind: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  {
    kind: 'url-password',
    re: /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/]{1,256}:)(\S{1,256}?)(?=@[A-Za-z0-9.-]{1,253}(?::\d{1,5})?(?:[/?#\s"'`)>\]}]|$))/gi,
    keep: m => {
      const pw = has(m, 2)
      return isRef(pw) || /^\d{1,5}(?:\/|$)/.test(pw) ? undefined : { prefix: has(m, 1), suffix: '' }
    },
  },
  {
    kind: 'url-param',
    re: new RegExp(String.raw`([?&](?:${URL_GENERIC_PARAMS}|${URL_SECRET_PARAMS})=)${REF}([^&#\s"'<>\`]{6,1024})`, 'gi'),
    keep: m => {
      const v = has(m, 2)
      const ok = URL_GENERIC_RE.test(has(m, 1)) ? randomValue(v) : looksLikeSecretValue(v) && !TEMPLATE.test(v)
      return ok ? { prefix: has(m, 1), suffix: '' } : undefined
    },
  },
  {
    kind: 'bearer',
    re: new RegExp(String.raw`\b([Bb]earer\s+)${REF}([A-Za-z0-9._~+/-]{12,}=*)`, 'g'),
    keep: m => (/[0-9]/.test(has(m, 2)) || /[._~+/-]/.test(has(m, 2)) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'basic-auth',
    re: new RegExp(String.raw`\b((?:proxy-)?authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?basic[ \t]+)${REF}([A-Za-z0-9+/=._~-]{4,})`, 'gi'),
    keep: m => ({ prefix: has(m, 1), suffix: '' }),
  },
  {
    kind: 'basic-auth',
    re: new RegExp(String.raw`\b((?:proxy-)?authorization["']?[ \t]{0,8}[:=][ \t]{0,8}["']?(?:digest|ntlm|negotiate)[ \t]+)${REF}([^\r\n'"]{1,4096}(?:"[^"\r\n]{0,1024}"[^\r\n'"]{0,4096}){0,32})`, 'gi'),
    keep: m => (has(m, 2).trim().length >= 4 ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'basic-auth',
    re: new RegExp(String.raw`\b(Basic[ \t]+)${REF}([A-Za-z0-9+/]{8,}={0,2})(?![A-Za-z0-9+/=])`, 'g'),
    keep: m => (isBasicCredential(has(m, 2)) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'cli-flag',
    re: new RegExp(String.raw`(\b(?:mysql|mariadb|mysqldump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mysqlsh|mariadb-dump|mariadb-admin)\b[^\n|;&]{0,300}?[ \t]-p)${REF}(${ARG})`, 'g'),
    keep: m => (secretArg(has(m, 2)) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'cli-flag',
    re: new RegExp(String.raw`(\b(?:sshpass|(?:docker|podman|nerdctl|helm|buildah|skopeo|oras)\b[^\n|;&]{0,200}?\blogin)\b[^\n|;&]{0,200}?[ \t]-p[ \t]*)${REF}(${ARG})`, 'g'),
    keep: m => (secretArg(has(m, 2)) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'cli-flag',
    re: new RegExp(String.raw`((?<![^\s"'=])--(?:[A-Za-z0-9]{1,20}-){0,3}(?:password|passwd|pass|passphrase|pwd|secret|token|api-?key|access-?key|secret-?key|private-?key|client-?secret|credentials?)(?:=|[ \t]+))${REF}(${ARG})`, 'gi'),
    keep: m => (secretArg(has(m, 2)) && !isPlainValue(unquote(has(m, 2))) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'cli-flag',
    re: new RegExp(String.raw`((?<![^\s"'])-pass(?:in|out)?[ \t]+pass:)${REF}(\S{1,512})`, 'g'),
    keep: m => ({ prefix: has(m, 1), suffix: '' }),
  },
  {
    kind: 'cli-flag',
    re: new RegExp(String.raw`((?<![^\s"'=])(?:-u|-U|--user|--proxy-user)(?:=|[ \t]*)(["']?)[^\s:'"@/]{1,128}:)${REF}([^\s'"]{1,256})(?=\2)`, 'g'),
    keep: m => (looksLikeSecretValue(has(m, 3), 4) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'netrc',
    re: new RegExp(String.raw`(\b(?:machine[ \t]+\S{1,256}|default)\s{1,16}login\s{1,16}\S{1,256}\s{1,16}password\s{1,16})${REF}(\S{1,512})`, 'g'),
    keep: m => ({ prefix: has(m, 1), suffix: '' }),
  },
  {
    kind: 'secret',
    re: new RegExp(String.raw`((?:${KEY_WORDS}|${TR_WORDS})${KEY_SUFFIX}["']?\s{0,32}[:=]\s{0,32}(["']))${REF}((?:(?!\2)[^\r\n\\]|\\.){1,1024}?)\2`, 'gi'),
    keep: m => (!countKey(m) && quotedSecret(has(m, 3), has(m, 1)) ? { prefix: has(m, 1), suffix: has(m, 2) } : undefined),
  },
  {
    kind: 'secret',
    re: new RegExp(String.raw`((?:${PASS_WORDS})(${KEY_SUFFIX})["']?[ \t]{0,32}[:=][ \t]{0,32})${REF}(${PHRASE_WORD}(?:[ \t]{1,4}${PHRASE_WORD}){1,15})(?=[ \t]*(?:[.,;!?…#)\]}]|\r?$))`, 'gimu'),
    keep: m => (passphrase(has(m, 3), has(m, 2)) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'secret',
    re: new RegExp(String.raw`((?:${KEY_WORDS}|${TR_WORDS})${KEY_SUFFIX}["']?\s{0,32}[:=]\s{0,32}["'\`]?)${REF}([^\s"'\`,;]{6,})`, 'gi'),
    keep: m => (unquotedSecret(m) ? { prefix: has(m, 1), suffix: '' } : undefined),
  },
  {
    kind: 'secret',
    re: new RegExp(String.raw`${WORD_START}((?:${PASS_WORDS})${KEY_SUFFIX}[ \t]{1,8}(?:${PROSE_LINK}[ \t]{1,8})?)${REF}(["'][^"'\r\n]{4,256}["']|[^\s"'<>(){}[\]]{6,256})`, 'gi'),
    keep: m => {
      const v = has(m, 2)
      if (/^["']/.test(v)) return quotedSecret(unquote(v), has(m, 1)) ? { prefix: `${has(m, 1)}${v[0]}`, suffix: v.slice(-1) } : undefined
      const tail = /[.,;:!?]+$/.exec(v)?.[0] ?? ''
      const core = v.slice(0, v.length - tail.length)
      if (isRef(core.replace(/^`|`$/g, ''))) return undefined
      return core.length >= 6 && !isPlainValue(core) && /[0-9!@#$%^&*+=?~|]/.test(core) ? { prefix: has(m, 1), suffix: tail } : undefined
    },
  },
  {
    kind: 'secret',
    re: new RegExp(String.raw`${WORD_START}((?:secret|token|(?:api|signing|secret|private|access|encryption|hmac|master|webhook|license)[ _-]?key|${PASS_WORDS})${KEY_SUFFIX}[ \t]{1,8}(?:${PROSE_LINK}[ \t]{1,8})?)${REF}([0-9a-fA-F]{32,256})(?![0-9A-Za-z_])`, 'gi'),
    keep: m => ({ prefix: has(m, 1), suffix: '' }),
  },
  {
    kind: 'env',
    re: new RegExp(
      String.raw`^([ \t]*(?:export[ \t]+)?[A-Z][A-Z0-9_]{0,63}(?:KEY|SECRET|TOKEN(?!I[SZ](?:E|ATION))|PASSWORD|PASSWD|(?<![A-Z])(?:PASS|PWD)(?![A-Z])|CREDENTIALS?|AUTH(?!OR(?!IZ)|ENTICAT(?:ION|ED))|DSN|PRIVATE|SIFRE|PAROLA)[A-Z0-9_]{0,63}[ \t]*=[ \t]*)${REF}(?!["']?\s*$)(\S.*)$`,
      'gm',
    ),
    keep: m => {
      const v = has(m, 2).replace(/^["']|["']$/g, '')
      if (isPlainValue(v) || isRef(v) || /\$\{[A-Za-z_]/.test(v)) return undefined
      if (/[ \t]=/.test(has(m, 1)) && codeValue(v, PASS_RE.test(has(m, 1)))) return undefined
      return { prefix: has(m, 1), suffix: '' }
    },
  },
  {
    kind: 'secret',
    re: new RegExp(String.raw`${WORD_START}((?:[A-Za-z][A-Za-z0-9]{0,31}[_-]){1,4}(?:key|KEY|Key)|[a-z][A-Za-z0-9]{0,31}Key)(["']?[ \t]{0,8}[:=][ \t]{0,8}["'\`]?)${REF}([A-Za-z0-9+/=_.~-]{6,256})(?![A-Za-z0-9+/=_.~-])`, 'g'),
    keep: m => (!NOT_SECRET_KEY.test(has(m, 1).toLowerCase().replace(/[^a-z0-9]/g, '')) && randomValue(has(m, 3)) ? { prefix: has(m, 1) + has(m, 2), suffix: '' } : undefined),
  },
  {
    kind: 'aws',
    re: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/g,
    keep: m => (looksLikeAwsSecret(m[0]) ? { prefix: '', suffix: '' } : undefined),
  },
]

function isPlainValue(v: string): boolean {
  if (/^[-+]?\d+(?:_\d+)*(?:[.,]\d+(?:_\d+)*)?[kKmM%]?$/.test(v)) return true
  if (/^(?:true|false|yes|no|on|off|null|none)$/i.test(v)) return true
  return /^(?:[a-z][a-z0-9+.-]*:\/\/|\/|\.{1,2}\/|~\/)/i.test(v)
}

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*'
const PATH_HEAD = new RegExp(String.raw`^${IDENT}(?:\??\.${IDENT}|\[[^\]\s]{0,64}\]|!)*`)
const IDENTS = new RegExp(IDENT, 'g')
const COMPOUND_NAME = /^(?:[a-z]{2,}|[A-Z][a-z]{2,})(?:[A-Z][a-z]{2,})+$/
const CONSTANT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
const TEMPLATE = /\$\{[A-Za-z_]|<[A-Za-z_][\w.-]{0,32}>/
const CREDENTIAL_FIELD = /pass|pwd?|secret|token|key|cred|auth|[şs]ifre|parola/i
const COUNT_KEY = /(?:input|output|max|min|total|prompt|completion|reasoning|thinking|context|cache|cached|read|write|creation|num|used|remaining|reserved)tokens?$|^tokens?(?:count|used|limit|budget|usage|total|estimate)$/

function readsAsWords(id: string): boolean {
  if (/^[A-Za-z_$]{1,4}$/.test(id)) return true
  let letters = 0
  let words = 0
  for (const part of id.split(/[_$]+/)) {
    if (/^\d*$/.test(part)) continue
    for (const w of part.match(/[A-Z]+(?![a-z])\d*|[A-Z]?[a-z]+\d*|\d+/g) ?? []) {
      const l = w.replace(/\d+$/, '').length
      if (l < 2 && l !== w.length) return false
      letters += l
      words++
    }
  }
  return words > 0 && letters / words >= 2.5
}

function codeValue(v: string, strict: boolean, after = ''): boolean {
  if (/^[[{(]/.test(v) || TEMPLATE.test(v)) return true
  const head = PATH_HEAD.exec(v)?.[0] ?? ''
  if (head === '') return false
  const names = head.match(IDENTS) ?? []
  if (!names.every(readsAsWords)) return false
  const rest = v.slice(head.length)
  const call = rest.startsWith('(')
  const type = head.endsWith('[]') || /^<[A-Za-z_$]/.test(rest)
  const path = /[.[!]/.test(head)
  if (!call && !type && !path) {
    const name = COMPOUND_NAME.test(head) || (CONSTANT_NAME.test(head) && !/_\d+(?=_|$)/.test(head))
    return !strict && /^[)\]}>]*$/.test(rest) && name
  }
  if (type) return true
  const lower = /^[a-z_$]/.test(head)
  if (call) return !strict || lower
  if (/^(?:this|self)\b/.test(head) || CREDENTIAL_FIELD.test(names[names.length - 1] ?? '')) return !strict || lower
  if (strict) return false
  return names.length < 3 || /[?![]/.test(head) || names.some(n => /[a-z0-9][A-Z]|[_$]/.test(n)) || CODE_AFTER.test(rest !== '' ? rest : after)
}

const CODE_AFTER = /^[ \t]*(?:[,;)\]}>]|\?\?|\|\||&&|[=!]==?|\?[ \t]|\+[ \t])/

function keyOf(m: RegExpExecArray): string {
  let start = m.index
  while (start > 0 && m.index - start < 64 && /[A-Za-z0-9_$-]/.test(m.input[start - 1] ?? '')) start--
  return m.input.slice(start, m.index) + (/^[^\s"':=]*/.exec(m[0])?.[0] ?? '')
}

const countKey = (m: RegExpExecArray): boolean => COUNT_KEY.test(keyOf(m).toLowerCase().replace(/[^a-z]/g, ''))

function unquotedSecret(m: RegExpExecArray): boolean {
  const v = has(m, 2)
  const prefix = has(m, 1)
  const core = v.replace(/[)\]}>:]+$/, '')
  if (countKey(m) || isPlainValue(core) || /\$\{[A-Za-z_]/.test(v)) return false
  const envStyle = /^[A-Z][A-Z0-9_]*$/.test(keyOf(m)) && /\S=["'`]?$/.test(prefix)
  const end = m.index + m[0].length
  const after = /^[^\r\n]*/.exec(m.input.slice(end, end + 8))?.[0] ?? ''
  if (!envStyle && codeValue(v, PASS_RE.test(prefix), after)) return false
  if (core.length < 8) {
    const passLike = PASS_RE.test(prefix) || /(?:^|[^a-z])(?:pass|pwd)(?:[^a-z]|$)/i.test(keyOf(m))
    return passLike ? /[0-9!@#$%^&*+=?~|]/.test(core) : randomValue(core)
  }
  return looksLikeSecretValue(core)
}

function looksLikeSecretValue(v: string, minLength = 1): boolean {
  if (v.length < minLength || isPlainValue(v)) return false
  if (v.length >= 20) return true
  if (/[0-9]/.test(v)) return true
  if (/[a-z]/.test(v) && /[A-Z]/.test(v)) return true
  return /[^A-Za-z]/.test(v)
}

const wordRun = (r: string): boolean => /^\d+$/.test(r) || /^[A-Za-z]{1,3}\d{0,3}$/.test(r) || readsAsWords(r)

function randomValue(v: string): boolean {
  if (v.length < 6 || isPlainValue(v) || /^v?\d+(?:[._-]\d+)+$/i.test(v)) return false
  if (!/[A-Za-z]/.test(v) || (!/[0-9]/.test(v) && !(/[a-z]/.test(v) && /[A-Z]/.test(v)))) return false
  return !v.split(/[^A-Za-z0-9]+/).filter(r => r !== '').every(wordRun)
}

const NOT_SECRET_KEY = /(?:primary|foreign|sort|sorting|order|partition|range|hash|cache|public|pub|group|lookup|map|row|index|unique|composite|natural|shard|routing|dedupe?|object|i18n|translation|react|list|query|field|column|attr|attribute|record|table|item|state|store|config|settings?|message|event|idempotency|hot|shortcut|search|label|name|lang|locale)key$/

function quotedSecret(v: string, prefix: string): boolean {
  const t = v.trim()
  if (t === '' || isPlainValue(t) || isRef(t) || TEMPLATE.test(t)) return false
  const pass = PASS_RE.test(prefix)
  if (/\s/.test(t)) return t.length >= 6 && pass
  return t.length >= 6 && looksLikeSecretValue(t)
}

function looksLikeAwsSecret(tok: string): boolean {
  if (!/[/+]/.test(tok) || !/[A-Z]/.test(tok) || !/[a-z]/.test(tok) || !/[0-9]/.test(tok)) return false
  if (/^(?:\/|~\/|\.\.?\/)/.test(tok)) return false
  const segs = tok.split('/').filter(s => s !== '')
  const wordish = segs.filter(s => PATH_SEGMENT.test(s)).length
  return !(segs.length >= 2 && wordish * 3 >= segs.length * 2)
}

const HIGH_ENTROPY = /[A-Za-z0-9+/=_-]{32,}/g
const INTEGRITY_HASH = /^(?:sha(?:1|224|256|384|512)|md5)-[A-Za-z0-9+/_-]+={0,2}$/i
const HASH_LABEL = /(?:^|[^A-Za-z0-9])(?:h1|sha(?:1|224|256|384|512)|md5):$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORDISH = '(?:[a-z0-9]+|[A-Z][a-z0-9]*)'
const PATH_SEGMENT = new RegExp(`^${WORDISH}(?:[-_.]${WORDISH})*$`)

function entropy(s: string): number {
  const counts = new Map<string, number>()
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1)
  let h = 0
  for (const n of counts.values()) {
    const p = n / s.length
    h -= p * Math.log2(p)
  }
  return h
}

function switchRate(s: string): number {
  const cls = (c: string): number => (c >= 'a' && c <= 'z' ? 0 : c >= 'A' && c <= 'Z' ? 1 : c >= '0' && c <= '9' ? 2 : 3)
  let switches = 0
  for (let i = 1; i < s.length; i++) if (cls(s[i] as string) !== cls(s[i - 1] as string)) switches++
  return s.length > 1 ? switches / (s.length - 1) : 0
}

export function memLooksRandom(tok: string): boolean {
  if (tok.length < 32) return false
  if (/^[0-9a-f]+$/i.test(tok)) return false
  if (UUID.test(tok)) return false
  if (!/[0-9]/.test(tok) || !/[A-Za-z]/.test(tok)) return false
  if (tok.includes('/')) {
    if (/^(?:\/|~\/|\.\.?\/)/.test(tok)) return false
    const segs = tok.split('/').filter(s => s !== '')
    const wordish = segs.filter(s => PATH_SEGMENT.test(s)).length
    if (segs.length >= 2 && wordish * 3 >= segs.length * 2) return false
  }
  const h = entropy(tok)
  const lower = !/[A-Z]/.test(tok)
  if (lower) {
    if (/[-_]/.test(tok) && tok.split(/[-_]/).every(p => p.length <= 12 || /^[a-z]+$/.test(p) || /^[0-9]+$/.test(p))) return false
    const digits = (tok.match(/[0-9]/g) ?? []).length / tok.length
    return h >= 4.0 && digits >= 0.15
  }
  const upperOnly = !/[a-z]/.test(tok)
  if (upperOnly) {
    if (/_/.test(tok) && tok.split('_').every(p => p.length <= 12)) return false
    return h >= 4.0 && switchRate(tok) >= 0.15
  }
  return h >= 4.0 && switchRate(tok) >= 0.42
}

const PRIVATE_TAG = /<(\/?)[p]rivate>/gi
const TAG_MENTION = /[`'"/\\]/
const PLACEHOLDER = /^\s*(?:…|\.{3})?\s*$/

function redactPrivate(text: string): { text: string; count: number } {
  const tags: Array<{ at: number; end: number; close: boolean }> = []
  PRIVATE_TAG.lastIndex = 0
  for (let t = PRIVATE_TAG.exec(text); t !== null; t = PRIVATE_TAG.exec(text)) tags.push({ at: t.index, end: t.index + t[0].length, close: t[1] === '/' })
  if (tags.length === 0) return { text, count: 0 }
  const nextClose = new Array<number>(tags.length).fill(-1)
  for (let i = tags.length - 1, c = -1; i >= 0; i--) {
    if (tags[i]?.close) c = i
    nextClose[i] = c
  }
  let out = ''
  let pos = 0
  let count = 0
  for (let i = 0; i < tags.length; i++) {
    const open = tags[i] as { at: number; end: number; close: boolean }
    if (open.close || open.at < pos) continue
    const mention = open.at > 0 && TAG_MENTION.test(text[open.at - 1] ?? '')
    const c = nextClose[i + 1] ?? -1
    const close = c >= 0 ? tags[c] : undefined
    if (!close) {
      if (mention) continue
      out += `${text.slice(pos, open.at)}[REDACTED:private]`
      pos = text.length
      count++
      break
    }
    const innerOpen = tags[i + 1]?.close === false
    if (PLACEHOLDER.test(text.slice(open.end, close.at)) || (mention && innerOpen)) continue
    out += `${text.slice(pos, open.at)}[REDACTED:private]`
    pos = close.end
    count++
  }
  return { text: count === 0 ? text : out + text.slice(pos), count }
}

export function redact(text: string): { text: string; count: number; kinds: string[] } {
  const priv = redactPrivate(text)
  let out = priv.text
  let count = priv.count
  const kinds = new Set<string>(count > 0 ? ['private'] : [])
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    out = out.replace(rule.re, (...args: unknown[]) => {
      const match = args[0] as string
      if (!rule.keep) {
        count++
        kinds.add(rule.kind)
        return `[REDACTED:${rule.kind}]`
      }
      const groups = args.slice(1, -2).map(g => (typeof g === 'string' ? g : undefined))
      const m = Object.assign([match, ...groups], { index: args[args.length - 2] as number, input: args[args.length - 1] as string }) as unknown as RegExpExecArray
      const kept = rule.keep(m)
      if (!kept) return match
      count++
      kinds.add(rule.kind)
      return `${kept.prefix}[REDACTED:${rule.kind}]${kept.suffix}`
    })
  }
  out = out.replace(HIGH_ENTROPY, (tok: string, offset: number, whole: string) => {
    const before = offset > 0 ? whole[offset - 1] ?? '' : ''
    const after = whole[offset + tok.length] ?? ''
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) return tok
    const dotFolder = before === '.' && whole[offset - 2] === '/' && tok.includes('/')
    if (INTEGRITY_HASH.test(tok) || HASH_LABEL.test(whole.slice(Math.max(0, offset - 8), offset))) return tok
    if (!memLooksRandom(dotFolder ? `/${tok}` : tok)) return tok
    count++
    kinds.add('entropy')
    return '[REDACTED:entropy]'
  })
  return { text: out, count, kinds: [...kinds].sort() }
}

export const MEM_REDACT_MARGIN = 1024

export function redactClip(text: string, max: number): { text: string; count: number; kinds: string[] } {
  const scanned = text.length > max + MEM_REDACT_MARGIN ? text.slice(0, max + MEM_REDACT_MARGIN) : text
  const r = redact(scanned)
  const clipped = r.text.length <= max ? r.text : r.text.slice(0, Math.max(0, max - 1)) + '…'
  return { text: clipped, count: r.count, kinds: r.kinds }
}

export function memIsSensitivePath(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (/^\.env(?:\..*)?$/i.test(base)) return true
  if (/\.pem$/i.test(base) || /\.key$/i.test(base) || /\.p12$/i.test(base)) return true
  if (/^id_[a-z0-9]+(?:\.pub)?$/i.test(base) && !/\.pub$/i.test(base)) return true
  if (/credentials/i.test(base)) return true
  return /(?:^|\/)\.ssh\//.test(p)
}
