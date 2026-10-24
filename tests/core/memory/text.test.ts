import { describe, expect, test } from 'bun:test'
import { memClip, memIsSensitivePath, memLooksRandom, memShortSid, normalizeForSearch, redact, redactClip, slugify } from '../../../src/core/memory/text'

describe('slugify', () => {
  test('folds Turkish letters and builds kebab-case ASCII', () => {
    expect(slugify('Çağrı Şeker ılık ÖĞÜ İstanbul')).toBe('cagri-seker-ilik-ogu-istanbul')
    expect(slugify('Use SQLite FTS5 as the default index; qmd for deep search')).toBe('use-sqlite-fts5-as-the-default-index-qmd-for-deep-search')
    expect(slugify('Use SQLite FTS5 as the default index; qmd only for deep search')).toBe('use-sqlite-fts5-as-the-default-index-qmd-only-for-deep')
    expect(slugify("Claude'un hafızası")).toBe('claudeun-hafizasi')
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu')
    expect(slugify('  ---  ')).toBe('note')
  })

  test('stays within 60 characters, preferring word boundaries', () => {
    const s = slugify('Kararlarını hızlı aramak için hafıza indeksinin Türkçe normalizasyonu gerekiyor ve önemli')
    expect(s.length).toBeLessThanOrEqual(60)
    expect(s.endsWith('-')).toBe(false)
    expect(s.startsWith('kararlarini-hizli-aramak-icin-hafiza')).toBe(true)
    expect(slugify('a'.repeat(80))).toBe('a'.repeat(60))
  })
})

describe('normalizeForSearch', () => {
  test('lowercases, folds ı/İ and strips diacritics', () => {
    expect(normalizeForSearch('Hafıza İstanbul ÇÖZÜM güncelleme Kararlarını')).toBe('hafiza istanbul cozum guncelleme kararlarini')
    expect(normalizeForSearch('IŞIK')).toBe('isik')
  })
})

describe('redact', () => {
  const cases: Array<[string, string]> = [
    ['export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234', 'openai'],
    ['key AKIAIOSFODNN7EXAMPLE here', 'aws'],
    ['token ghp_0123456789abcdefghijABCDEFGHIJ012345 x', 'github'],
    ['pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop', 'github'],
    ['anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'anthropic'],
    ['slack xoxb-1234567890-abcdefghij', 'slack'],
    ['google AIzaSyA-1234567890abcdefghijklmnopqrstu', 'google'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'jwt'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----', 'pem'],
    ['password: hunter2!x', 'secret'],
    ['DB_PASSWORD=supersecret', 'env'],
    ['postgres://user:p4ssw0rd@db:5432/x', 'url-password'],
    ['Authorization: Bearer abcdef1234567890xyz', 'bearer'],
    ['random Zx8pQ2mN7vR4tY6uI9oP1aS3dF5gH7jK0lZ3 end', 'entropy'],
    ['see <private>my plan</private> ok', 'private'],
  ]
  for (const [input, kind] of cases) {
    test(`detects ${kind}`, () => {
      const r = redact(input)
      expect(r.count).toBeGreaterThan(0)
      expect(r.kinds).toContain(kind)
      expect(r.text).toContain(`[REDACTED:${kind}]`)
    })
  }

  test('never writes the original value and keeps the surrounding text', () => {
    const r = redact('use api_key = "abcd1234efgh5678" and AKIAIOSFODNN7EXAMPLE')
    expect(r.text).toBe('use api_key = "[REDACTED:secret]" and [REDACTED:aws]')
    expect(r.count).toBe(2)
    expect(r.kinds).toEqual(['aws', 'secret'])
  })

  test('is idempotent', () => {
    const once = redact(cases.map(c => c[0]).join('\n'))
    const twice = redact(once.text)
    expect(twice.count).toBe(0)
    expect(twice.text).toBe(once.text)
  })

  test('leaves ids, hashes, paths, references and prose alone', () => {
    const benign = [
      'commit 9f3c2ab4d5e6f7081920a1b2c3d4e5f60718293a and session 3f2a9c1e-0000-4000-8000-000000000000',
      'see projects/buracle/decisions/2026-10-07-use-fts5-default-index-for-memory.md',
      'https://github.com/burakarslan0110/buracle/blob/main/docs/research/09-memory.md',
      'api_key="${ENV:CONTEXT7_KEY}" and token: {{secret}}',
      'token: the user asked; Tokens: 123456789; TOKEN_COUNT=12345678; PWD=/Users/x/y',
      'use the Bearer authentication scheme; authenticated: successfully',
      'TypeScriptLanguageServiceHost2Implementation and BURACLE_SESSION_ID_AND_SOME_OTHER_CONSTANT_2',
      's-20261007-2215-claude-3f2a9c and m-20261007-k3q9',
      'checkouts: [/private/var/folders/0w/vl9b4m6n3b5b9z_0q1b2c3d40000gn/T/buracle-sb-AbC1q9/repo]',
      'see var/folders/0w/vl9b4m6n3b5b9z_0q1b2c3d40000gn/T/buracle-sb-Zq8XkP/repo/src',
    ]
    for (const b of benign) expect(redact(b)).toEqual({ text: b, count: 0, kinds: [] })
  })

  test('a path behind a dot-folder stays whole (temp folders with random names)', () => {
    const paths = [
      '/private/var/folders/0w/vl9b4m6n3b5b9z_0q1b2c3d40000gn/T/.tmp-JzLi3O/buracle-smoke-AbC123/project/src/app.ts',
      'Read ~/.cache/Build-Qx7Lm2Np/Rt5Yk8Wz-Out/Gen9Kt/src/Main.java',
      'see ./.tmp/Run-JzLi3O/Qx7Lm2Np/Rt5Yk8Wz/out/index.js',
    ]
    for (const p of paths) expect(redact(p)).toEqual({ text: p, count: 0, kinds: [] })
  })

  test('a random token after a dot that opens no folder is still masked', () => {
    const token = 'Zx9Qw3Er7Ty1Ui5Op2As8Df4Gh6Jk0LmN'
    for (const [input, masked] of [
      [`config.${token}`, 'config.[REDACTED:entropy]'],
      [`/srv/app/settings.${token}`, '/srv/app/settings.[REDACTED:entropy]'],
      [`value .${token}`, 'value .[REDACTED:entropy]'],
      [`.${token}`, '.[REDACTED:entropy]'],
      [`https://example.com/.${token}`, 'https://example.com/.[REDACTED:entropy]'],
      [`KEY=/.${token}`, 'KEY=/.[REDACTED:entropy]'],
    ]) expect(redact(input as string)).toEqual({ text: masked as string, count: 1, kinds: ['entropy'] })
  })

  test('the entropy heuristic separates random tokens from identifiers', () => {
    expect(memLooksRandom('xR7kP2nQ9vL4mT8bW3cY6zH1jF5gD0sA/eK9uI2o')).toBe(true)
    expect(memLooksRandom('k3j4h5g6f7d8s9a0q1w2e3r4t5y6u7i8')).toBe(true)
    expect(memLooksRandom('getElementsByClassNameForTesting123')).toBe(false)
    expect(memLooksRandom('2026-10-11-buracles-brain-layer-starts-as-round-1-0-5-0-instrumentation')).toBe(false)
    expect(memLooksRandom('the-memory-bench-fixture-is-blind-for-recall-tests-fts5s-idf')).toBe(false)
    expect(memLooksRandom('session_2026_10_11_internationalization_1234567890123')).toBe(false)
    expect(memLooksRandom('q7x2k9m4p1z8w3n6v5b0r2t9-h4j7l1c3f8d2g6s5a9e0u1')).toBe(true)
    expect(memLooksRandom('a1b2c3d4-ab12-cd34-ef56-1234567890ab')).toBe(false)
  })
})

describe('helpers', () => {
  test('memShortSid takes the last six alphanumerics', () => {
    expect(memShortSid('0199a213-81c0-7800-8aa1-bbab2a035a53')).toBe('035a53')
    expect(memShortSid('ses_ABC')).toBe('sesabc')
    expect(memShortSid('---')).toBe('x')
  })

  test('memIsSensitivePath matches the denylist', () => {
    for (const p of ['.env', 'app/.env.local', 'certs/server.pem', '/Users/x/.ssh/config', 'id_rsa', 'aws-credentials.json']) expect(memIsSensitivePath(p)).toBe(true)
    for (const p of ['notes/env.md', 'id_rsa.pub', 'src/identity.ts', 'docs/pemberton.md']) expect(memIsSensitivePath(p)).toBe(false)
  })

  test('memClip ends with an ellipsis when it cuts', () => {
    expect(memClip('short', 10)).toBe('short')
    const c = memClip('one two three four five six seven', 15)
    expect(c.length).toBeLessThanOrEqual(15)
    expect(c.endsWith('…')).toBe(true)
  })
})

describe('redact: credential forms people type into commands, configs and Turkish prose', () => {
  const gitlabToken = ['glpat', 'Xy7Kq2Vb9Lm4Nc8Rt3Wz'].join('-')
  const twilioKey = 'SK' + '0123456789abcdef'.repeat(2)
  const leaks: Array<[string, string, string]> = [
    ['GitLab personal token', `token ${gitlabToken} used`, gitlabToken],
    ['GitLab deploy token', 'gldt-AbCdEfGhIjKlMnOpQrSt12 for the registry', 'gldt-AbCdEfGhIjKlMnOpQrSt12'],
    ['Slack app-level token', 'xapp-1-A01234ABCDE-1234567890123-0123456789abcdef0123456789abcdef', 'A01234ABCDE-1234567890123'],
    ['bare AWS secret access key', 'creds: AKIAIOSFODNN7EXAMPLE wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
    ['AWS key id with a glued Turkish suffix', 'anahtarı AKIAIOSFODNN7EXAMPLEdır', 'AKIAIOSFODNN7EXAMPLE'],
    ['Authorization: Basic', 'Authorization: Basic dXNlcjpodW50ZXIyMg==', 'dXNlcjpodW50ZXIyMg=='],
    ['curl -H Basic', `curl -H 'Authorization: Basic dXNlcjpodW50ZXIyMg==' https://api.example.com`, 'dXNlcjpodW50ZXIyMg=='],
    ['Authorization: Digest', 'Authorization: Digest username="burak", realm="api", nonce="abc", response="6629fae49393a05397450978507c4ef1"', '6629fae49393a05397450978507c4ef1'],
    ['a bare Basic credential', 'forward Basic dXNlcjpodW50ZXIyMg== upstream', 'dXNlcjpodW50ZXIyMg=='],
    ['mysql -p<password>', 'mysql -u root -pS3cr3tP4ss mydb', 'S3cr3tP4ss'],
    ["mysqldump -p'quoted'", "mysqldump -h db -p'S3cr3t P4ss' app", 'S3cr3t P4ss'],
    ['curl -u user:password', 'curl -u admin:Hunter22x https://api.example.com', 'Hunter22x'],
    ['curl --user=user:password', 'curl --user=admin:Hunter22x https://api.example.com', 'Hunter22x'],
    ['sshpass -p', 'sshpass -p Kedi2024xyz ssh deploy@host', 'Kedi2024xyz'],
    ['docker login -p', 'docker login -u me -p Kedi2024xyz registry.local', 'Kedi2024xyz'],
    ['--password value', 'psql --password Sup3rS3cret!', 'Sup3rS3cret!'],
    ['--db-password=value', 'migrate --db-password=Sup3rS3cret! up', 'Sup3rS3cret!'],
    ['--api-key value', 'datadog-agent --api-key 0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
    ['--token "quoted"', 'deploy --token "Ab1Cd2Ef3Gh4" now', 'Ab1Cd2Ef3Gh4'],
    ['openssl -pass pass:', 'openssl enc -aes256 -pass pass:Kedi2024xyz -in a.txt', 'Kedi2024xyz'],
    ['.netrc line', 'machine github.com login burak password Hunter22xyz', 'Hunter22xyz'],
    ['password in prose', 'the password Hunter22xyz works again', 'Hunter22xyz'],
    ['a short quoted password', 'password = "hunter2"', 'hunter2'],
    ['a quoted passphrase of several words', '"password": "correct horse battery staple"', 'correct horse battery staple'],
    ['şifresi: value', 'Veritabanı şifresi: Xk9mP2qL7', 'Xk9mP2qL7'],
    ['ŞİFRE=value (Turkish capitals)', 'ŞİFRE=Xk9mP2qL7abc', 'Xk9mP2qL7abc'],
    ['parola=value', 'parola=Gizli2026Kasa', 'Gizli2026Kasa'],
    ['sifre: value (ASCII)', 'sifre: Kasa2026!x', 'Kasa2026!x'],
    ["şifresi 'quoted'", "API şifresi 'Kedi2024!xyz' olarak ayarlandı", 'Kedi2024!xyz'],
    ['gizli anahtar: value', 'gizli anahtar: Zx9Yw8Vu7Ts6', 'Zx9Yw8Vu7Ts6'],
    ['parolası in prose', 'sunucu parolası Kedi2024xyz idi', 'Kedi2024xyz'],
    ['DB_SIFRE env line', 'export DB_SIFRE=Kedi2024xyz', 'Kedi2024xyz'],
    ['URL password with a slash', 'postgres://app:pa/ss9word@db.internal:5432/app', 'pa/ss9word'],
    ['URL password with an @', 'mongodb://app:p@ssw0rd99@db.internal/app', 'ssw0rd99'],
    ['Azure AccountKey', 'AccountName=acct;AccountKey=Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Ab1Cd2Ef3Gh4Ij5Kl6Mn7==;EndpointSuffix=core', 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0'],
    ['Twilio API key', twilioKey, twilioKey],
  ]
  for (const [label, input, secret] of leaks) {
    test(label, () => {
      const r = redact(input)
      expect(r.count).toBeGreaterThan(0)
      expect(r.text).not.toContain(secret)
      expect(redact(r.text)).toEqual({ text: r.text, count: 0, kinds: [] })
    })
  }

  test('keeps the words around a secret', () => {
    expect(redact('mysql -u root -pS3cr3tP4ss mydb').text).toBe('mysql -u root -p[REDACTED:cli-flag] mydb')
    expect(redact('curl -u admin:Hunter22x https://api.example.com').text).toBe('curl -u admin:[REDACTED:cli-flag] https://api.example.com')
    expect(redact('Veritabanı şifresi: Xk9mP2qL7').text).toBe('Veritabanı şifresi: [REDACTED:secret]')
    expect(redact('postgres://app:pa/ss9word@db.internal:5432/app').text).toBe('postgres://app:[REDACTED:url-password]@db.internal:5432/app')
    expect(redact('the password Hunter22xyz.').text).toBe('the password [REDACTED:secret].')
  })

  test('commands, references and prose that only look like credentials stay', () => {
    const path40 = ['packages', 'Core2', 'src', 'Utils', 'Helpers', 'Strings'].join('/')
    expect(path40).toHaveLength(40)
    const benign = [
      'git push -u origin main', 'docker run -u 1000:1000 img', 'docker run -u root:root img',
      'gh auth login --with-token <<< "$TOKEN"', 'curl --token-file ./tok https://x', 'echo "$PW" | docker login --password-stdin -u me ghcr.io',
      'mysql -p mydb', 'mysql -P 3306 -u root -h db', 'psql --password $PGPASSWORD', 'gh api --token "${GITHUB_TOKEN}"',
      'the password manager is open; set the password manually.', 'reset the password reset-link via email',
      'şifre değiştirildi ve parola sıfırlama bağlantısı gönderildi', 'anahtar kelime: arama',
      'http://localhost:3000/@user', 'https://github.com:443/user/repo@v1', 'Basic authentication is used here',
      '"auth": "required"', 'password: required', 'ssh -p 2222 user@host', 'sort -u file.txt', path40,
    ]
    for (const b of benign) expect([b, redact(b)]).toEqual([b, { text: b, count: 0, kinds: [] }])
  })
})

describe('redact runs in linear time on hostile input', () => {
  const N = 200_000
  const hex = Array.from({ length: N / 32 }, (_, i) => ((i * 2654435761) % 4294967296).toString(16).padStart(8, '0').repeat(4)).join('')
  const b64 = Array.from({ length: N / 4 }, (_, i) => 'QWJj/+9zAbC'.slice(i % 7, (i % 7) + 4)).join('')
  const inputs: Array<[string, string]> = [
    ['one 200 KB hex token', hex], ['200 KB of base64', b64], ['a.b-c_d runs', 'a.b-c_d'.repeat(N / 7)],
    ['a.b.c.d…', 'a.'.repeat(N / 2)], ['blank lines', '\n'.repeat(N)], ['KEYKEY…', 'KEY'.repeat(N / 3)],
    ['tokentoken…', 'token'.repeat(N / 5)], ['password password …', 'password '.repeat(N / 9)], ['"token": "…', '"token": "'.repeat(N / 10)],
    ['mysql mysql …', 'mysql '.repeat(N / 6)], ['docker login …', 'docker login '.repeat(N / 13)], ['https://u:p@…', 'https://u:p@'.repeat(N / 12)],
    ['scheme://…', 'a://'.repeat(N / 4)], ['şifre şifre …', 'şifre '.repeat(N / 6)], ['an env name of 200 KB', `export ${'A'.repeat(N)}KEY=x`],
  ]
  for (const [label, text] of inputs) {
    test(label, () => {
      const t = performance.now()
      redact(text)
      expect(performance.now() - t).toBeLessThan(1500)
    })
  }

  test('redactClip scans only what survives the cap, redacting before it cuts', () => {
    const t = performance.now()
    const r = redactClip(`echo ${hex} | xxd -r -p`, 600)
    expect(performance.now() - t).toBeLessThan(100)
    expect(r.text).toHaveLength(600)
    expect(r.text.endsWith('…')).toBe(true)
    const straddling = `${'x '.repeat(290)}token ghp_0123456789abcdefghijABCDEFGHIJ012345 tail`
    const c = redactClip(straddling, 600)
    expect(c.text).not.toContain('ghp_0123')
    expect(c.kinds).toEqual(['github'])
    expect(redactClip('short', 600)).toEqual({ text: 'short', count: 0, kinds: [] })
  })

  const more: Array<[string, string]> = [
    ['a dotted value of 200 KB', `token: ${'aB.'.repeat(N / 3)}`],
    ['a call chain of 200 KB', `tokens: ${'run('.repeat(N / 4)}`],
    ['private tags named in backticks', 'a `<private>` '.repeat(N / 14)],
    ['private openers', '<private>'.repeat(N / 9)],
    ['private closers', '</private>'.repeat(N / 10)],
  ]
  for (const [label, text] of more) {
    test(label, () => {
      const t = performance.now()
      redact(text)
      expect(performance.now() - t).toBeLessThan(1500)
    })
  }
})

describe('redact: numbers, code and mentions next to secret-like words stay', () => {
  const code: Array<[string, string]> = [
    ['a count with digit separators', 'tokens: 1_234_567,'],
    ['an object literal with a separated count', '{ tokens: 12_345_678, usd: 1.5 }'],
    ['a separated budget', 'maxInputTokens: 200_000,'],
    ['a count before a closing bracket', 'render({ tokens: 1_234_567})'],
    ['a call', 'const tokens = estimateTokens(text)'],
    ['a sum of member paths', 'const tokens = this.usage.inputTokens + this.usage.outputTokens'],
    ['a config path', 'maxInputTokens: config.memory.distill.maxInputTokens,'],
    ['an optional chain', 'tokens: usage?.input.tokens ?? 0,'],
    ['a call with a member argument', 'maxTokens: clamp(input.max_tokens, 1, 4096),'],
    ['a count in a test literal', "expect(render({ tokens: 1_234_567 })).toContain('tokens: 1.2M')"],
    ['the FTS tokenizer option', `db.run("CREATE VIRTUAL TABLE notes USING fts5(title, body, tokenize = 'unicode61 remove_diacritics 2')")`],
    ['an array type', 'tokens: string[]'],
    ['a generic type', 'tokens: Array<TokenUsage>'],
    ['a type name', 'const token: CancellationToken = source.token'],
    ['a parameter type', 'function sign(token: string): Promise<string> {'],
    ['a constant name', 'api_key: OPENAI_API_KEY'],
    ['a constant passed in code', 'const headers = { "x-api-key": API_KEY}'],
    ['an env assignment inside a template literal', "expect(run(`SECRET=1`).trim()).toBe('')"],
    ['an env value with an expansion', 'TOKEN=prefix-${SUFFIX}'],
    ['a quoted value with an expansion', 'token: "tok-${ENV:CONTEXT7_KEY}"'],
    ['a key pattern with placeholders', '`mcp_oauth:server:<id>:<url>` holds the token'],
    ['a call with a number', 'const token = randomToken(16)'],
    ['a call with an object', 'secret: secretBytes({ length: 32 }),'],
    ['a static member', 'max_tokens: Number.NaN,'],
    ['a constant from settings', 'api_key = settings.OPENAI_API_KEY'],
    ['a template literal', 'const token = `${header}.${payload}`'],
    ['a regex string after a token count key', '"input_tokens": "\\"input_tokens\\":([0-9]+)",'],
    ['a command substitution', 'CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s bench -w)"'],
    ['a command substitution as a flag value', 'deploy --token $(cat token.txt) --yes'],
    ['an author email', 'GIT_AUTHOR_EMAIL=dev@example.com'],
    ['authorized_keys', 'authorized_keys: collectKeys(hosts)'],
    ['the authentication mode', 'authentication: OAUTH_DEVICE|API_KEY}'],
    ['a password read from config', 'password: config.db.password,'],
    ['a password read from a short config path', 'password: cfg.db.pw'],
    ['a password read by a call', 'password: readPasswordFrom(stdin),'],
    ['a Python settings line', 'DB_PASSWORD = os.getenv("DB_PASSWORD")'],
    ['an auth header built by a call', 'auth: JSON.stringify(headers),'],
    ['a Markdown link after the Turkish word for keys', 'Yapılandırma anahtarları: [`canonical/buracle.yaml`](canonical/buracle.yaml).'],
    ['the private tag named in backticks', 'Anything inside `<private>…</private>` is never stored.'],
    ['the private tag named with three dots', 'wrap it in <private>...</private> to keep it out'],
    ['the private tag named alone', 'a `<private>` block is dropped before storage, and the rest of this text stays.'],
    ['the private tag in a regex literal', "  { kind: 'private', re: /<private>[\\s\\S]*?(?:<\\/private>|$)/gi },\n  { kind: 'pem' },"],
  ]
  for (const [label, text] of code) {
    test(label, () => expect(redact(text)).toEqual({ text, count: 0, kinds: [] }))
  }

  test('a source file shown to the agent keeps its code and loses only the secret', () => {
    const token = 'ghp_0123456789abcdefghijABCDEFGHIJ012345'
    const file = [
      'const PRIVATE = /<private>[\\s\\S]*?<\\/private>/g   // the tag is only named here',
      'const tokens = estimateTokens(text)',
      'const budget = { maxInputTokens: 200_000, tokens: usage?.input.tokens ?? 0 }',
      `const token = '${token}'`,
      'export default budget',
    ].join('\n')
    const r = redact(file)
    expect(r).toEqual({ text: file.replace(token, '[REDACTED:github]'), count: 1, kinds: ['github'] })
  })
})

describe('redact: passphrases and name-shaped secrets after secret keys', () => {
  const masked: Array<[string, string, string[]]> = [
    ['an unquoted passphrase', 'password: correct horse battery staple', ['correct', 'horse', 'battery', 'staple']],
    ['an ASCII Turkish passphrase', 'sifre: dogru at pil zimba kelimesi', ['dogru', 'zimba', 'kelimesi']],
    ['a Turkish passphrase', 'şifre: doğru at pil zımba', ['doğru', 'zımba']],
    ['a Turkish key with an ending', 'Veritabanı şifresi: mavi deniz kırk iki', ['mavi', 'deniz', 'kırk']],
    ['parola with =', 'parola = mavi deniz kırk iki', ['deniz', 'kırk']],
    ['a capitalized passphrase', 'password: Correct Horse Battery Staple', ['Horse', 'Staple']],
    ['a prefixed key', 'db_password: correct horse battery staple', ['horse', 'staple']],
    ['a numbered key', 'password2: correct horse battery staple', ['horse']],
    ['a passphrase key', 'passphrase: tiger lamp ocean quiet', ['tiger', 'ocean']],
    ['a passphrase before a comma', 'the new password: correct horse battery staple, keep it safe', ['horse', 'staple']],
    ['a passphrase before a comment', 'password: correct horse battery staple # rotated monthly', ['horse']],
    ['a passphrase on one line of several', 'user: bob\npassword: correct horse battery staple\nhost: db', ['horse', 'staple']],
    ['dotted words after api_key', 'api_key: north.wind.mango.seven', ['north.wind', 'mango.seven']],
    ['dotted words after client_secret', 'client_secret = blue.river.lamp', ['blue.river']],
    ['dotted words after secret', 'secret: correct.horse.battery.staple', ['correct.horse']],
    ['capitalized dotted words after a token key', 'access_token: Correct.Horse.Battery', ['Correct.Horse']],
    ['a numbered constant after webhook_secret', 'webhook_secret: WHSEC_PROD_2026', ['WHSEC_PROD']],
    ['a numbered constant after token', 'token: PROD_SIGNING_KEY_7731', ['PROD_SIGNING']],
  ]
  for (const [label, input, gone] of masked) {
    test(`masks ${label}`, () => {
      const r = redact(input)
      expect(r.kinds).toEqual(['secret'])
      for (const g of gone) expect(r.text).not.toContain(g)
      expect(redact(r.text)).toEqual({ text: r.text, count: 0, kinds: [] })
    })
  }

  test('keeps the key, the sentence end and the rest of the line', () => {
    expect(redact('password: correct horse battery staple.').text).toBe('password: [REDACTED:secret].')
    expect(redact('the new password: correct horse battery staple, keep it safe').text).toBe('the new password: [REDACTED:secret], keep it safe')
    expect(redact('user: bob\npassword: correct horse battery staple\nhost: db').text).toBe('user: bob\npassword: [REDACTED:secret]\nhost: db')
    expect(redact('user: bob\r\npassword: correct horse battery staple\r\nhost: db').text).toBe('user: bob\r\npassword: [REDACTED:secret]\r\nhost: db')
    expect(redact('Veritabanı şifresi: mavi deniz kırk iki').text).toBe('Veritabanı şifresi: [REDACTED:secret]')
    expect(redact('api_key: north.wind.mango.seven').text).toBe('api_key: [REDACTED:secret]')
  })

  const kept: Array<[string, string]> = [
    ['a type union', 'password: string | null'],
    ['a typed field with a default', 'password: str = Field(min_length=8)'],
    ['a column description', 'password: string not null'],
    ['a field description', 'password: required field'],
    ['a label key', 'password_confirmation: same as above'],
    ['a hint key', 'passwordHint: favourite colour plus year'],
    ['a label that names the key', 'forgot_password: Forgot your password?'],
    ['prose that names the key', 'Password: Enter your password.'],
    ['Turkish prose that names the key', 'şifre: şifremi unuttum'],
    ['an expression', 'password = fallback if missing else given'],
    ['two short words', 'password: a b'],
    ['a short member path', 'auth: req.user'],
    ['a member path of two words', 'token: session.id'],
    ['a member path before a closing brace', '{ auth: res.locals.user }'],
    ['a member path before an operator', 'token: ctx.state.user ?? null'],
    ['a member path before a comma', 'auth: ctx.state.user,'],
    ['a member path ending in a credential field', 'secret: app.config.secret'],
    ['a member path with an identifier-shaped part', 'apiKey: config.apiKeys.value'],
    ['a member path with an underscore', 'token: input.max_tokens.value'],
    ['a constant name', 'token: GITHUB_TOKEN'],
    ['a constant name of several words', 'secret: AWS_SECRET_ACCESS_KEY'],
  ]
  for (const [label, text] of kept) {
    test(`keeps ${label}`, () => expect(redact(text)).toEqual({ text, count: 0, kinds: [] }))
  }

  test('stays linear on hostile input', () => {
    const N = 200_000
    for (const text of ['password: ' + 'word '.repeat(N / 5), 'password: a b '.repeat(N / 14), 'şifre: x y '.repeat(N / 11), 'token: a.b.c '.repeat(N / 13),
      'api_key: ' + 'north.'.repeat(N / 6)]) {
      const t = performance.now()
      redact(text)
      expect(performance.now() - t).toBeLessThan(1500)
    }
  })
})

describe('redact: real secrets after the same keys stay masked', () => {
  const secrets: Array<[string, string, string]> = [
    ['a GitHub token after token:', 'token: ghp_0123456789abcdefghijABCDEFGHIJ012345', 'ghp_0123456789'],
    ['an OpenAI key after api_key =', 'api_key = "sk-proj-AbCdEfGh1234567890IjKlMn"', 'AbCdEfGh1234567890'],
    ['a password', 'password: hunter22', 'hunter22'],
    ['a quoted password', 'password = "hunter22"', 'hunter22'],
    ['a Turkish password', 'şifre: Kedi2024xyz', 'Kedi2024xyz'],
    ['a hex token', 'token: a8f5f167f44f4964e6c998dee827110c', 'a8f5f167f44f4964'],
    ['a 0x token', 'token: 0x1F2E3D4C5B6A79880123456789abcdef', '1F2E3D4C5B6A7988'],
    ['a mixed secret', 'secret = Xk9mP2qL7abc', 'Xk9mP2qL7abc'],
    ['a letters-only random token', 'token: kXqZmBwTrE', 'kXqZmBwTrE'],
    ['an access token', 'accessToken: Ab1Cd2Ef3Gh4', 'Ab1Cd2Ef3Gh4'],
    ['an auth token', 'auth_token: Zx9Yw8Vu7Ts6', 'Zx9Yw8Vu7Ts6'],
    ['an authorization value', '"authorization": "a8f5f167f44f4964e6c998dee827110c"', 'a8f5f167f44f4964'],
    ['a token with dots', 'tokens: aB3dE.fG7hJ9', 'aB3dE.fG7hJ9'],
    ['a dotted value with a random segment', 'token: Xk9mP2qL7.length', 'Xk9mP2qL7'],
    ['a dotted token of short segments', 'token: Ab12.Cd34.Ef56', 'Ab12.Cd34.Ef56'],
    ['a client secret with dots', 'client_secret: Xy7_kL9.mN3-pQ', 'Xy7_kL9.mN3-pQ'],
    ['a token that looks like a call', 'token: Ab1Cd2(Ef3Gh4', 'Ab1Cd2'],
    ['a dotted password', 'password: Summer.Breeze2024', 'Summer.Breeze2024'],
    ['a lowercase dotted password', 'password: summer.breeze', 'summer.breeze'],
    ['a password that looks like a call', 'password: Hunter(2024)', 'Hunter(2024)'],
    ['a password in a Markdown code span', 'password: `hunter22`', 'hunter22'],
    ['a password shaped like a constant', 'password = "MY_DB_PASS_2024"', 'MY_DB_PASS_2024'],
    ['a quoted secret shaped like a constant', 'jwt_secret: "MY_SUPER_SECRET_KEY"', 'MY_SUPER_SECRET_KEY'],
    ['an uppercase token with underscores', 'token: ABCD_1A2B_3C4D_EF56', 'ABCD_1A2B_3C4D_EF56'],
    ['an env token', 'export API_TOKEN=Zx9Yw8Vu7Ts6', 'Zx9Yw8Vu7Ts6'],
    ['a dotted env secret', 'JWT_SECRET=my.secret.value', 'my.secret.value'],
    ['an env password next to a count', 'DB_PASSWORD=Kedi2024xyz MAX_TOKENS=4096', 'Kedi2024xyz'],
    ['a private block', 'my key is <private>hunter22 xyz</private> ok', 'hunter22'],
    ['a private block in capitals', 'my key is <PRIVATE>hunter22 xyz</PRIVATE> ok', 'hunter22'],
    ['a private block in quotes', 'note: "<private>Kedi2024xyz</private>"', 'Kedi2024xyz'],
    ['a private block that is never closed', 'start <private>never closed and secret', 'never closed'],
    ['a private block after a mention of the tag', 'the `<private>` tag: <private>Kedi2024xyz', 'Kedi2024xyz'],
    ['a closed private block after a mention of the tag', 'the `<private>` tag: <private>Kedi2024xyz</private> done', 'Kedi2024xyz'],
    ['a multi-line private block', '<private>\nline one\nline two\n</private>', 'line one'],
  ]
  for (const [label, input, secret] of secrets) {
    test(label, () => {
      const r = redact(input)
      expect(r.count).toBeGreaterThan(0)
      expect(r.text).not.toContain(secret)
      expect(redact(r.text)).toEqual({ text: r.text, count: 0, kinds: [] })
    })
  }

  test('a backtick around a value stays around the mask', () => {
    expect(redact('password: `hunter22`').text).toBe('password: `[REDACTED:secret]`')
  })

  test('a named tag keeps its words and the block after it is masked alone', () => {
    expect(redact('the `<private>` tag: <private>Kedi2024xyz</private> done').text).toBe('the `<private>` tag: [REDACTED:private] done')
  })
})

describe('redact: env names with PASS or PWD, lowercase key names, query strings, prose and short tokens', () => {
  const leaks: Array<[string, string, string]> = [
    ['DB_PASS env line', 'DB_PASS=hunter2secret', 'hunter2secret'],
    ['SMTP_PASS with export', 'export SMTP_PASS=s3cr3tpass', 's3cr3tpass'],
    ['MYSQL_PWD env line', 'MYSQL_PWD=Xk9fQ2mZ7p', 'Xk9fQ2mZ7p'],
    ['lowercase db_pass', 'db_pass: Tr0ub4dor', 'Tr0ub4dor'],
    ['lowercase stripe_key', 'stripe_key=Xk9fQ2mZ7pLwAb12', 'Xk9fQ2mZ7pLwAb12'],
    ['quoted stripe_key', 'stripe_key = "Xk9fQ2mZ7pLwAb12"', 'Xk9fQ2mZ7pLwAb12'],
    ['camelCase signingKey', 'signingKey: "Zq81LmXv0PwYt3Rk"', 'Zq81LmXv0PwYt3Rk'],
    ['64 hex after a key name', 'webhook_key=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', '9f86d081884c7d659a2feaa0c55ad015'],
    ['64 hex named in prose', 'the signing secret 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 rotates monthly', '9f86d081884c7d659a2feaa0c55ad015'],
    ['a webhook key in prose', 'webhook key is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', '9f86d081884c7d659a2feaa0c55ad015'],
    ['?key= in a URL', 'GET https://api.example.com/v1/items?key=AbC123xyz987QwE&page=2', 'AbC123xyz987QwE'],
    ['&sig= in a SAS URL', 'https://acct.blob.core.windows.net/c/f.bin?sv=2022-11-02&sig=AbC123xyz987QwE%2Bk%3D&se=2026-01-01', 'AbC123xyz987QwE'],
    ['&token= in a URL', 'https://example.com/cb?state=1&token=Qm9vYXJ3x1&mode=x', 'Qm9vYXJ3x1'],
    ['&signature= in a URL', 'https://example.com/hook?ts=1&signature=Zq81LmXv0PwYt3Rk', 'Zq81LmXv0PwYt3Rk'],
    ['X-Amz-Signature', 'https://b.s3.amazonaws.com/k?X-Amz-Date=20260101&X-Amz-Signature=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', '9f86d081884c7d659a2feaa0c55ad015'],
    ['the password is …', 'the password is Hunter2Hunter2!', 'Hunter2Hunter2'],
    ['The password was …', 'The password was hunter2hunter2.', 'hunter2hunter2'],
    ['parola olarak …', 'parola olarak Kedi2024!xyz kullan', 'Kedi2024!xyz'],
    ['şifresi ise …', 'veritabanı şifresi ise Kasa2026x', 'Kasa2026x'],
    ['a short random api_key', 'api_key=Xk9fQ2', 'Xk9fQ2'],
    ['a short random token', 'token: a8F3kd9', 'a8F3kd9'],
    ['a short password with a digit', 'password: abc123', 'abc123'],
  ]
  for (const [label, input, secret] of leaks) {
    test(label, () => {
      const r = redact(input)
      expect(r.count).toBeGreaterThan(0)
      expect(r.text).not.toContain(secret)
      expect(redact(r.text)).toEqual({ text: r.text, count: 0, kinds: [] })
    })
  }

  test('keeps the rest of a URL and of the sentence', () => {
    expect(redact('https://example.com/cb?state=1&token=Qm9vYXJ3x1&mode=x').text).toBe('https://example.com/cb?state=1&token=[REDACTED:url-param]&mode=x')
    expect(redact('the password is Hunter2Hunter2!').text).toBe('the password is [REDACTED:secret]!')
    expect(redact('MYSQL_PWD=Xk9fQ2mZ7p').text).toBe('MYSQL_PWD=[REDACTED:secret]')
  })

  test('a bare pass or pwd is a key at the start of a line or in an object, never in prose', () => {
    for (const [input, secret] of [['pass: Tr0ub4dor9x', 'Tr0ub4dor9x'], ['  pwd: Xk9fQ2mZ7p', 'Xk9fQ2mZ7p'], ['{ user: bob, pass: Tr0ub4dor9x }', 'Tr0ub4dor9x'], ['smtp.pass=Tr0ub4dor9x', 'Tr0ub4dor9x']]) {
      expect(redact(input as string).text).not.toContain(secret as string)
    }
    for (const prose of [
      '- 2026-10-12 claude-code: Verification pass: docs/TASARIM.md no longer exists (renamed to docs/DESIGN.md in 239ac38)',
      '- 2026-10-12 claude-code: Verification pass: dev-mods is not literally empty; restated the mod list with its source',
      '- 2026-10-12 claude-code: Verification pass: runtime-config.json has no 0.4.0 version field; restated what it holds',
      'The second pass: rebuild_index_then_vacuum runs at night',
    ]) expect([prose, redact(prose)]).toEqual([prose, { text: prose, count: 0, kinds: [] }])
  })

  test('names, words, paths, versions and references next to the same keys stay', () => {
    const benign = [
      'primary_key=user_id', 'sort_key: created_at', "storageKey: 'buracle.theme.v2'", 'cache_key=user:42', 'object_key=uploads/2026/file.png',
      'public_key=AAAAC3NzaC1lZDI1NTE5', 'partitionKey: "tenant-2026"', 'idempotency_key=order-123',
      'https://example.com/search?q=x&key=abc', 'https://example.com/docs?key=readme', 'https://example.com/a?key=2026-10-12', 'https://example.com/a?token={{token}}',
      'BYPASS_LIST=localhost', 'OLDPWD=/tmp/x', 'PWD=/Users/x/y', 'bypass: proxy01', 'passes: 12', 'pass_rate: 0.95', 'first_pass: done',
      'the password is required', 'the password is stored in the keychain.', 'the password is `$DB_PASS`', 'parola olarak ayarlanmadı',
      'auth: oauth2', 'token: string', 'forgot_password: Forgot your password?', 'api_key: secret',
      'the commit 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b fixed the token refresh', 'the cache key 5d41402abc4b2a76b9719d911017c592 is stable',
    ]
    for (const b of benign) expect([b, redact(b)]).toEqual([b, { text: b, count: 0, kinds: [] }])
  })

  test('stays linear on hostile input', () => {
    const N = 200_000
    for (const text of ['a_key='.repeat(N / 6), `x_key=${'Ab1'.repeat(N / 3)}`, '?key='.repeat(N / 5), `?sig=${'Ab1'.repeat(N / 3)}`,
      'password is '.repeat(N / 12), `secret ${'ab12'.repeat(N / 4)}`, 'DB_PASS'.repeat(N / 7), `${'a_'.repeat(N / 2)}key=Xk9fQ2mZ7p`]) {
      const t = performance.now()
      redact(text)
      expect(performance.now() - t).toBeLessThan(1500)
    }
  })
})

describe('redact: integrity hashes and module checksums are not secrets', () => {
  const hashes = [
    '"integrity": "sha512-Z3xY2wV1uT0sR9qP8oN7mL6kJ5iH4gF3eD2cB1aZ0yX9wV8uT7sR6qP5oN4mL3kJ2iH1gF0eD9cB8aZ7yX6wV5uT4sR3qP2oN1mL0kJ9iH8g=="',
    '<script src="https://cdn.example.com/x.js" integrity="sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC" crossorigin="anonymous"></script>',
    'github.com/pkg/errors v0.9.1 h1:FEBLx1zS214owpjy7qsBeixbURkuhQAwrK5UwLGTwt4=',
    'github.com/pkg/errors v0.9.1/go.mod h1:bwawxfHBFNV+L2hUp1rHADufV3IMtnDRdf1r5NINEl0=',
    'hash = "sha256-Ab3dEf9GhIjKlMnOpQrStUvWxYz0123456789AbCdEf+/=";',
    'outputHash = "sha256:1n7ghzw2kq6h8a9b0c1d2e3f4g5h6i7j8k9l0m1n2p3q4r5s6v7w";',
  ]
  for (const h of hashes) test(h.slice(0, 40), () => expect(redact(h)).toEqual({ text: h, count: 0, kinds: [] }))

  test('a random token with another label is still masked', () => {
    const r = redact('value Xk9fQ2mZ7pLwAb12Cd34Ef56Gh78Ij90Kl here')
    expect(r.kinds).toEqual(['entropy'])
  })
})
