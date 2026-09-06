// Exercises the pure logic of tabby-links against the built bundle, with no app.
// Run with:  node test-links-logic.js
const path = require('path')
const REPO = path.resolve(__dirname, '../..')

let passed = 0
let failed = 0
function check (name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) {
        passed++
    } else {
        failed++
        console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
    }
}

// The bundle is UMD over `require`, and everything it pulls in is a node
// builtin or an Angular external, so a plain require works for the exported
// helpers as long as we stub the Angular decorators the module body evaluates.
const Module = require('module')
const originalResolve = Module._resolveFilename
const stubs = {
    '@angular/core': new Proxy({}, { get: () => (() => (target) => target) }),
    '@angular/common': {},
    '@angular/forms': {},
    '@ng-bootstrap/ng-bootstrap': {},
    'rxjs': require(path.join(REPO, 'node_modules/rxjs')),
    'tabby-core': new Proxy({}, { get: (_t, k) => { if (k === '__esModule') return true; return class Stub {} } }),
    'tabby-settings': new Proxy({}, { get: () => class Stub {} }),
    'tabby-terminal': new Proxy({}, { get: () => class Stub {} }),
    'tabby-linkifier': new Proxy({}, { get: () => class Stub {} }),
}
Module._resolveFilename = function (request, ...rest) {
    if (stubs[request]) {
        return request
    }
    return originalResolve.call(this, request, ...rest)
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
    if (stubs[request]) {
        return stubs[request]
    }
    return originalLoad.call(this, request, ...rest)
}

const links = require(path.join(REPO, 'tabby-links/dist/index.js'))
const runtime = links.IntegrationRuntimeService
// The helper functions are module-level exports of the runtime module; the
// bundle re-exports only the services, so reach the helpers via the source.

// ── JSON pointers ───────────────────────────────────────────────────────────
// Re-implemented reach: pull the internal helpers out of the bundle text is
// brittle, so instead load the compiled runtime module through webpack's own
// export surface. `index.ts` re-exports the services; the helpers are exercised
// through them where possible, and directly where they are exported.

// Load the helpers directly from a tiny transpile of the source instead.
// Registering a `.ts` extension lets Node's own resolver follow the relative
// imports between the source files.
const ts = require(path.join(REPO, 'node_modules/typescript'))
Module._extensions['.ts'] = function (module, filename) {
    const source = require('fs').readFileSync(filename, 'utf8')
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText
    module._compile(js, filename)
}
function loadSource (relative) {
    return require(path.join(REPO, relative))
}

const rt = loadSource('tabby-links/src/services/integrationRuntime.service.ts')
const guard = loadSource('tabby-links/src/regexGuard.ts')
const ft = loadSource('tabby-links/src/fileTypes.ts')

console.log('── JSON pointers (RFC 6901 + the -1 extension) ──')
const slack = { messages: [{ text: 'first', user: 'U1' }, { text: 'last', user: 'U2' }] }
check('last element', rt.resolvePointer(slack, '/messages/-1/text'), 'last')
check('first element', rt.resolvePointer(slack, '/messages/0/text'), 'first')
check('out of range', rt.resolvePointer(slack, '/messages/9/text'), null)
check('negative out of range', rt.resolvePointer(slack, '/messages/-9/text'), null)
check('missing key', rt.resolvePointer(slack, '/nope'), null)
check('escaped slash', rt.resolvePointer({ 'a/b': 1 }, '/a~1b'), 1)
check('escaped tilde', rt.resolvePointer({ 'a~b': 2 }, '/a~0b'), 2)
check('tilde-01 decodes left to right', rt.resolvePointer({ 'a~1b': 3 }, '/a~01b'), 3)
check('whole document', rt.resolvePointer({ x: 1 }, ''), { x: 1 })
check('null root', rt.resolvePointer(null, '/a'), null)

console.log('── value rendering ──')
check('string', rt.valueToString('x'), 'x')
check('integer', rt.valueToString(3), '3')
check('boolean', rt.valueToString(false), 'false')
check('object renders as nothing', rt.valueToString({ a: 1 }), '')
check('array renders as nothing', rt.valueToString([1]), '')
check('null renders as nothing', rt.valueToString(null), '')

console.log('── host guarding ──')
check('bare host', rt.hostOf('acme.atlassian.net'), 'acme.atlassian.net')
check('full url', rt.hostOf('https://stith.lvh.me'), 'stith.lvh.me')
check('url with path and port', rt.hostOf('https://stith.lvh.me:8443/a/b?c=1'), 'stith.lvh.me')
check('userinfo stripped', rt.hostOf('https://u:p@acme.atlassian.net/x'), 'acme.atlassian.net')
check('look-alike differs', rt.hostOf('https://evil.example/browse/ABC-1') === rt.hostOf('acme.atlassian.net'), false)
check('empty', rt.hostOf(''), '')

console.log('── relative time ──')
const now = Date.parse('2026-09-03T12:00:00Z')
const ago = (ms) => rt.relativeTime(now - ms, now)
check('just now', ago(5_000), 'just now')
check('minutes', ago(5 * 60_000), '5 min ago')
check('hours', ago(5 * 3600_000), '5 h ago')
check('days', ago(3 * 86400_000), '3 d ago')
check('weeks', ago(10 * 86400_000), '1 wk ago')
check('months', ago(60 * 86400_000), '2 mo ago')
check('years', ago(400 * 86400_000), '1 y ago')
check('future is just now', rt.relativeTime(now + 10_000, now), 'just now')

console.log('── timestamp parsing ──')
check('iso', rt.parseTimestamp('2026-09-03T12:00:00.000Z'), Date.parse('2026-09-03T12:00:00.000Z'))
check('slack fractional seconds', rt.parseTimestamp('1725360000.123456'), 1725360000123)
check('unparseable', rt.parseTimestamp('not a date'), null)
check('unparseable stays as-is', rt.formatValue('not a date', 'relativeTime'), 'not a date')

console.log('── badge colours (must match the other fork) ──')
check('green', rt.badgeColor('green'), '#2EA043')
check('jira Done category', rt.badgeColor('green'), '#2EA043')
check('jira In Progress', rt.badgeColor('yellow'), '#E0A800')
check('jira To Do falls through', rt.badgeColor('blue-gray'), '#808890')
check('literal hex', rt.badgeColor('#c0392b'), '#c0392b')
check('unknown', rt.badgeColor('whatever'), '#808890')
check('case insensitive', rt.badgeColor('GREEN'), '#2EA043')

console.log('── file type groups ──')
check('image', ft.matchesFileType('/tmp/a.PNG', 'image', []), true)
check('media includes video', ft.matchesFileType('/tmp/a.mp4', 'media', []), true)
check('wrong group', ft.matchesFileType('/tmp/a.mp4', 'image', []), false)
check('custom extension', ft.matchesFileType('/var/log/x.log', 'none', ['log']), true)
check('custom with dot', ft.matchesFileType('/var/log/x.log', 'none', ['.log']), true)
check('dot in a directory name is not an extension', ft.extensionOf('/home/user.name/README'), '')
check('query stripped', ft.extensionOf('https://x/y.png?v=2'), 'png')
check('windows path', ft.extensionOf('C:\\a.b\\c.TXT'), 'txt')

console.log('── regex guard ──')
const good = guard.checkPattern('\\b([A-Z][A-Z0-9]{1,9}-\\d{1,7})\\b')
check('a sane pattern passes', good.ok, true)
const broken = guard.checkPattern('([a-z')
check('an uncompilable pattern is refused', broken.ok, false)
// The check itself must be bounded: an earlier version reproduced the freeze it
// was meant to detect, taking 127 s on this very pattern.
for (const evilSource of ['(a+)+b', '^(\\d+|\\w+)*$', '(a|a)*b', '(\\w+\\s?)*$']) {
    const started = Date.now()
    const evil = guard.checkPattern(evilSource)
    const elapsed = Date.now() - started
    check(`backtracking pattern ${evilSource} is refused`, evil.ok, false)
    check(`checking ${evilSource} stays under 1s (took ${elapsed}ms)`, elapsed < 1000, true)
}
const sane = Date.now()
guard.checkPattern('\\b([A-Z][A-Z0-9]{1,9}-\\d{1,7})\\b')
check('checking a sane pattern is instant', Date.now() - sane < 50, true)

// The four built-in handler regexes must NOT be refused.
const builtins = {
    url: '((([A-Za-z]{3,9}:(?:\\/\\/)?)(?:[\\-;:&=\\+\\$,\\w]+@)?[A-Za-z0-9\\.\\-]+|(?:www\\.|[\\-;:&=\\+\\$,\\w]+@)[A-Za-z0-9\\.\\-]+)((:((6553[0-5])|(655[0-2][0-9])|(65[0-4][0-9]{2})|(6[0-4][0-9]{3})|([1-5][0-9]{4})|([0-5]{1,5})|([0-9]{1,4})))?(?:\\/[\\+~%\\/\\.\\w\\-_:,]*)?\\??(?:[\\-\\+=&;%@\\.\\w_:,\\/]*)#?(?:[\\.\\!\\/\\\\\\w\\-:,]*))?)(?<![;:,.])',
    ip: '\\b((2[0-4]\\d|25[0-5]|[01]?\\d\\d?)\\.){3}(2[0-4]\\d|25[0-5]|[01]?\\d\\d?)',
    unixPath: '[~]?(\\/[\\w\\d.~-]{1,100})+',
    winPath: '(([a-zA-Z]:|\\\\|~)\\\\[\\w\\-()\\\\\\.]{1,1024}|"([a-zA-Z]:|\\\\)\\\\[\\w\\s\\-()\\\\\\.]{1,1024}")',
}
for (const [name, source] of Object.entries(builtins)) {
    const result = guard.checkPattern(source)
    check(`builtin ${name} is not refused`, result.ok, true)
}

console.log('── GuardedRegex does not spin on a non-global pattern ──')
const nonGlobal = new guard.GuardedRegex('a', '', 'test')
check('non-global exec terminates', nonGlobal.execAll('aaa').length, 1)
const global = new guard.GuardedRegex('a', 'g', 'test')
check('global finds all', global.execAll('aaa').length, 3)
const zeroWidth = new guard.GuardedRegex('(?:)', 'g', 'test')
check('zero-width does not hang', zeroWidth.execAll('abc', 5).length <= 5, true)
const bad = new guard.GuardedRegex('([a-z', '', 'test')
check('uncompilable is unusable', bad.usable, false)
check('uncompilable matches nothing', bad.execAll('abc').length, 0)
check('uncompilable full-matches nothing', bad.fullMatch('abc'), false)

console.log('── setting normalization ──')
const reg = loadSource('tabby-links/src/services/integrationRegistry.service.ts')
const hostField = { key: 'host', normalize: 'host', suffix: '.atlassian.net' }
check('a pasted URL is reduced to its host',
    reg.normalizeSettingValue(hostField, 'https://cloudbeds.atlassian.net/browse/CAB-8209'), 'cloudbeds.atlassian.net')
check('a pasted URL with a query too',
    reg.normalizeSettingValue(hostField, 'https://cloudbeds.atlassian.net/jira/software/c/projects/CAB?x=1'), 'cloudbeds.atlassian.net')
check('a bare name gets the suffix',
    reg.normalizeSettingValue(hostField, 'cloudbeds'), 'cloudbeds.atlassian.net')
check('an already-correct host is left alone',
    reg.normalizeSettingValue(hostField, 'cloudbeds.atlassian.net'), 'cloudbeds.atlassian.net')
check('whitespace is trimmed',
    reg.normalizeSettingValue(hostField, '  cloudbeds  '), 'cloudbeds.atlassian.net')
check('a self-hosted host is not given the suffix',
    reg.normalizeSettingValue(hostField, 'jira.internal.example.com'), 'jira.internal.example.com')
check('a port is dropped',
    reg.normalizeSettingValue(hostField, 'https://jira.example.com:8443/x'), 'jira.example.com')
check('empty stays empty', reg.normalizeSettingValue(hostField, '   '), '')
// stith's baseUrl declares neither key, so its full URL must survive untouched:
// it is substituted into a template as a whole scheme + host.
check('a field with no normalize keys is untouched',
    reg.normalizeSettingValue({ key: 'baseUrl' }, 'https://stith.lvh.me'), 'https://stith.lvh.me')

console.log('── secret previews ──')
const creds = loadSource('tabby-links/src/services/integrationCredentials.service.ts')
check('nothing stored, nothing shown', creds.maskSecret(''), '')
check('a short value is masked completely', creds.maskSecret('abc123'), '••••••')
check('a 10-char value is still masked completely', creds.maskSecret('0123456789'), '••••••••••')
check('a medium value shows three each end', creds.maskSecret('0123456789abcd'), '012••••••••bcd')
check('a long token shows four each end',
    creds.maskSecret('ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz'), 'ATAT••••••••wxyz')
check('the preview never contains the middle',
    creds.maskSecret('ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz').includes('efghij'), false)

console.log('── manifest compatibility with the Windows Terminal fork ──')
// The two forks must agree on everything that decides *behaviour*. Jira's
// `host` field additionally carries `normalize`/`suffix`, which are additive
// and ignored by an implementation that does not know them — the documented
// rule for unknown keys.
const ADDITIVE = new Set(['normalize', 'suffix', 'description', 'placeholder'])

// Read the reference manifests from the other fork's *committed* state, not its
// working tree. That checkout is somebody's workspace and can be mid-edit; a
// test that compares against uncommitted changes fails for reasons that have
// nothing to do with this repo, which is exactly what happened the first time.
const TERMINAL_REPO = process.env.TERMINAL_REPO || 'C:/Users/steve/projects/terminal'
const TERMINAL_MANIFESTS = 'src/cascadia/TerminalSettingsModel/integrations'
function referenceManifest (id) {
    try {
        const raw = require('child_process').execFileSync(
            'git', ['show', `HEAD:${TERMINAL_MANIFESTS}/${id}.json`],
            { cwd: TERMINAL_REPO, encoding: 'utf8' })
        return JSON.parse(raw)
    } catch (err) {
        return null
    }
}

for (const id of ['github', 'jira', 'slack', 'stith']) {
    const ours = require(path.join(REPO, `tabby-links/src/integrations/${id}.json`))
    const theirs = referenceManifest(id)
    if (!theirs) {
        // No reference checkout on this machine — skip rather than fail. The
        // compatibility claim is only checkable where both forks are present.
        console.log(`  (skipped ${id}: no reference checkout at ${TERMINAL_REPO})`)
        continue
    }
    check(`${id}: matchers identical`, ours.matchers, theirs.matchers)
    check(`${id}: fetch pipeline identical`, ours.fetch, theirs.fetch)
    check(`${id}: display fields identical`, ours.fields, theirs.fields)
    check(`${id}: cache lifetime identical`, ours.cacheSeconds, theirs.cacheSeconds)
    // The keys the reference grew in `3f221ee31`. A manifest written there has
    // to mean the same thing here, which is the whole promise of the format.
    check(`${id}: field groups identical`, ours.fieldGroups, theirs.fieldGroups)
    check(`${id}: tabs identical`, ours.tabs, theirs.tabs)
    check(`${id}: actions identical`, ours.actions, theirs.actions)
    check(`${id}: detect patterns identical`, ours.detectPatterns, theirs.detectPatterns)
    check(`${id}: setting keys identical`,
        (ours.settings ?? []).map(f => f.key), (theirs.settings ?? []).map(f => f.key))
    check(`${id}: credential keys and secrecy identical`,
        (ours.credentials ?? []).map(f => [f.key, f.secret ?? null]),
        (theirs.credentials ?? []).map(f => [f.key, f.secret ?? null]))
    // Anything that differs must be one of the additive, ignorable keys.
    const diffs = []
    for (const [i, field] of (ours.settings ?? []).entries()) {
        const other = (theirs.settings ?? [])[i] ?? {}
        for (const key of new Set([...Object.keys(field), ...Object.keys(other)])) {
            if (JSON.stringify(field[key]) !== JSON.stringify(other[key]) && !ADDITIVE.has(key)) {
                diffs.push(`${field.key}.${key}`)
            }
        }
    }
    check(`${id}: no behavioural divergence in settings`, diffs, [])
}

// `html` is the one place our manifests intentionally differ. The other fork
// compiles its WebView2 host but ships it disabled, so a document there is
// inert rather than wrong — and an implementation that has never heard of the
// key ignores it, which is the documented rule.
const stithOurs = require(path.join(REPO, 'tabby-links/src/integrations/stith.json'))
check('stith carries an html representation', typeof stithOurs.html, 'string')
check('its page uses the portable postMessage name',
    stithOurs.html.includes('chrome.webview.postMessage'), true)
check('its page does not assume a theme',
    stithOurs.html.includes('color-scheme:light dark'), true)
for (const id of ['jira', 'slack']) {
    const m = require(path.join(REPO, `tabby-links/src/integrations/${id}.json`))
    check(`${id} has no html, as upstream`, m.html, undefined)
}

console.log('\n── parity fixes ──')

// A pointer whose *key* contains a colon used to be read as a step id, and the
// field then rendered as nothing at all.
const steps = { issue: { fields: { summary: 'S' } } }
const lastStep = { links: { 'self:href': 'https://x.test/1' }, 'urn:id': 7, plain: 'p' }
check('leading slash wins over a colon',
    rt.lookupPath('/links/self:href', steps, lastStep), 'https://x.test/1')
check('colon in a top-level key',
    rt.lookupPath('/urn:id', steps, lastStep), 7)
check('a real step reference still works',
    rt.lookupPath('issue:/fields/summary', steps, lastStep), 'S')
check('a bare pointer still resolves against the last step',
    rt.lookupPath('/plain', steps, lastStep), 'p')
check('an unknown step is still nothing',
    rt.lookupPath('nope:/x', steps, lastStep), null)

// Credentials must not ride out on a failing command's stderr.
check('a credential in stderr is redacted',
    rt.redactSecrets('curl failed: -H "Bearer ATATT3xFfGF0secret"', { token: 'ATATT3xFfGF0secret' }),
    'curl failed: -H "Bearer ••••"')
check('a short value is left alone',
    rt.redactSecrets('exit 1', { pin: 'ab' }), 'exit 1')
check('no credentials, no change',
    rt.redactSecrets('exit 1', {}), 'exit 1')

// Homograph links. `аpple.com` here begins with a Cyrillic а.
const target = loadSource('tabby-links/src/services/linkTarget.service.ts')
check('a cyrillic lookalike is named',
    target.punycodeHost('https://\u0430pple.com/login'), 'xn--pple-43d.com')
check('an ordinary host says nothing',
    target.punycodeHost('https://apple.com/login'), '')
check('an author who typed punycode is not warned',
    target.punycodeHost('https://xn--pple-43d.com/login'), '')
check('a port does not defeat the comparison',
    target.punycodeHost('https://\u0430pple.com:8443/x'), 'xn--pple-43d.com')
check('userinfo does not defeat it either',
    target.punycodeHost('https://u:p@\u0430pple.com/x'), 'xn--pple-43d.com')
check('not a url', target.punycodeHost('just some text'), '')
check('a file path', target.punycodeHost('C:\\Windows\\notepad.exe'), '')

// What a matched link points at, before anything asks whether it exists.
// `distro` is a name, '' for a WSL tab whose distro could not be named, or null
// for a tab that is not WSL; the third argument is "the host is Windows".
console.log('\n── file paths, WSL and fragments ──')
const fsPath = target.filesystemPath

check('a WSL path becomes the distro share',
    fsPath('/home/stevenp/projects', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\stevenp\\projects')
check('a POSIX path in a tab that is not WSL is left alone',
    fsPath('/home/stevenp/projects', null, true), '/home/stevenp/projects')
check('a WSL tab whose distro could not be named guesses no share',
    fsPath('/home/stevenp/projects', '', true), '/home/stevenp/projects')
check('on Linux a POSIX path is already the path',
    fsPath('/home/stevenp/projects', 'Ubuntu', false), '/home/stevenp/projects')

check('a file:// URI resolves like the path it carries',
    fsPath('file:///home/stevenp/notes.md', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\stevenp\\notes.md')
check('a fragment is not part of the file name',
    fsPath('file:///home/stevenp/notes.md#L10-L12', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\stevenp\\notes.md')
// The fragment is stripped before decoding, so the escape a real '#' has to
// arrive as is not mistaken for the delimiter it was escaped to avoid.
check('an escaped hash is part of the name',
    fsPath('file:///home/me/a%23b.md', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\a#b.md')
check('percent escapes are decoded',
    fsPath('file:///home/me/my%20notes.md', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\my notes.md')
check('a multi-byte escape decodes as UTF-8',
    fsPath('file:///home/me/caf%C3%A9.md', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\café.md')
check('a malformed escape costs the decode, not the link',
    fsPath('file:///home/me/100%.md', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\100%.md')
check('the scheme is case-insensitive',
    fsPath('FILE:///home/me/x', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\x')

// An authority in a file: URI is a UNC path, which is how an editor writes a
// WSL link that already names its own distro — no tab needed to read it.
check('an authority is a UNC host',
    fsPath('file://wsl.localhost/Debian/etc/hosts', null, true),
    '\\\\wsl.localhost\\Debian\\etc\\hosts')
check('localhost is the empty authority spelled out',
    fsPath('file://localhost/c:/Users/steve/x.txt', null, true), 'c:\\Users\\steve\\x.txt')
check('a drive letter drops the empty authority slash',
    fsPath('file:///c:/Users/steve/x.txt', null, true), 'c:\\Users\\steve\\x.txt')

// A Windows drive mounted into the distro is reachable as itself.
check('a /mnt drive is a drive',
    fsPath('/mnt/c/Users/steve', 'Ubuntu', true), 'C:\\Users\\steve')
check('a bare /mnt drive keeps its root',
    fsPath('/mnt/c', 'Ubuntu', true), 'C:\\')
check('a directory called mnt is not a drive',
    fsPath('/mnt/certificates/ca.pem', 'Ubuntu', true),
    '\\\\wsl.localhost\\Ubuntu\\mnt\\certificates\\ca.pem')
check('/mnt outside a WSL tab is not translated either',
    fsPath('/mnt/c/Users/steve', null, true), '/mnt/c/Users/steve')

check('a Windows path is already a path',
    fsPath('C:\\Windows\\notepad.exe', 'Ubuntu', true), 'C:\\Windows\\notepad.exe')
check('a UNC path is already a path',
    fsPath('\\\\server\\share\\x', 'Ubuntu', true), '\\\\server\\share\\x')
// Rooted or nothing: a text rule matches things like an issue key, and asking
// the filesystem about a relative name answers against the app's own directory.
check('a url is not a path', fsPath('https://example.com/x', 'Ubuntu', true), '')
check('an issue key is not a path', fsPath('CAB-8209', 'Ubuntu', true), '')
check('a relative path is not asked about', fsPath('./notes.md', 'Ubuntu', true), '')

check('a fragment is everything after the first hash',
    target.stripFragment('file:///a/b#c#d'), 'file:///a/b')
check('no fragment, no change', target.stripFragment('file:///a/b'), 'file:///a/b')
check('an escaped hash is not a fragment',
    target.stripFragment('file:///a%23b'), 'file:///a%23b')

console.log('\n── rich integrations ──')
const rt2 = rt
const rich = loadSource('tabby-links/src/richText.ts')

// ADF: only `text` nodes carry characters; everything else is structure.
const adf = {
    type: 'doc',
    content: [
        { type: 'paragraph', content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world', marks: [{ type: 'strong' }] },
        ] },
        { type: 'bulletList', content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
        ] },
        { type: 'paragraph', content: [
            { type: 'mention', attrs: { text: '@steve' } },
            { type: 'text', text: ' see ' },
            { type: 'inlineCard', attrs: { url: 'https://x.test/1' } },
        ] },
    ],
}
const flat = rich.adfToText(adf)
check('adf keeps the text', flat.includes('Hello world'), true)
check('adf bullets its list items', flat.includes('• one'), true)
check('adf reads a mention from attrs', flat.includes('@steve'), true)
check('adf reads an inline card url', flat.includes('https://x.test/1'), true)
check('adf collapses runs of blank lines', /\n{3}/.test(flat), false)
check('adf survives nonsense', rich.adfToText({ type: 'doc' }), '')
check('adf survives null', rich.adfToText(null), '')
// A document that nests into itself must terminate rather than spin.
const deep = { type: 'doc', content: [] }
let cursor = deep
for (let i = 0; i < 200; i++) {
    const next = { type: 'paragraph', content: [] }
    cursor.content.push(next)
    cursor = next
}
cursor.content.push({ type: 'text', text: 'bottom' })
check('a pathologically deep document is capped, not hung',
    typeof rich.adfToText(deep), 'string')

// Markdown, parsed to data. Nothing here ever becomes HTML.
const blocks = rich.parseMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n> quoted\n\n```\nraw\n```')
check('markdown finds the heading', blocks[0].kind + blocks[0].level, 'h1')
check('markdown finds bold', blocks[1].spans.some(s => s.bold && s.text === 'bold'), true)
check('markdown finds inline code', blocks[1].spans.some(s => s.code && s.text === 'code'), true)
check('markdown finds list items', blocks.filter(b => b.kind === 'li').length, 2)
check('markdown finds the quote', blocks.some(b => b.kind === 'quote'), true)
check('markdown finds the fence', blocks.some(b => b.kind === 'code'), true)
check('a link becomes a span with an href',
    rich.parseInline('see [docs](https://x.test/d)').find(s => s.href)?.href, 'https://x.test/d')
check('a bare url becomes a link',
    rich.parseInline('go https://x.test/y now').find(s => s.href)?.href, 'https://x.test/y')
check('code is not re-scanned for emphasis',
    rich.parseInline('`a_b_c`')[0], { text: 'a_b_c', code: true })
check('plain text passes through', rich.parseInline('nothing special'), [{ text: 'nothing special' }])
// A remote body is not allowed to be unbounded.
check('a huge body is truncated',
    rich.plainText('x'.repeat(rich.MAX_BODY_CHARS + 500)).length <= rich.MAX_BODY_CHARS + 1, true)

// Pointers relative to one array element, used by tab items and action options.
check('lookupIn resolves within an element',
    rt2.lookupIn({ author: { displayName: 'Ada' } }, '/author/displayName'), 'Ada')
check('lookupIn with no pointer is nothing', rt2.lookupIn({ a: 1 }, undefined), null)

// Required fields: only what the far end insists on.
check('required fields are read from the metadata map',
    rt2.readRequiredFields({
        resolution: { required: true, name: 'Resolution' },
        assignee: { required: false, name: 'Assignee' },
    }),
    [{ key: 'resolution', label: 'Resolution', required: true }])
check('an empty field map is no form', rt2.readRequiredFields({}), [])
check('a non-object field map is no form', rt2.readRequiredFields(null), [])

// The action body merge.
check('a form is merged as a top-level fields object',
    rt2.mergeActionFields('{"transition":{"id":"31"}}', { resolution: 'Done' }),
    '{"transition":{"id":"31"},"fields":{"resolution":"Done"}}')
check('an empty form leaves the body alone',
    rt2.mergeActionFields('{"transition":{"id":"31"}}', {}), '{"transition":{"id":"31"}}')
check('blank answers are not sent',
    rt2.mergeActionFields('{"a":1}', { x: '' }), '{"a":1}')
check('a non-json body is left exactly as written',
    rt2.mergeActionFields('key=value', { x: 'y' }), 'key=value')

// What a refused action tells the user.
check('jira errorMessages surface',
    rt2.describeApiError('{"errorMessages":["Transition is not valid"]}'),
    ' — Transition is not valid')
check('jira per-field errors surface',
    rt2.describeApiError('{"errors":{"resolution":"Resolution is required"}}'),
    ' — Resolution is required')
check('a plain message surfaces', rt2.describeApiError('{"message":"Not found"}'), ' — Not found')
check('an unparseable body says nothing', rt2.describeApiError('<html>502</html>'), '')
check('an empty body says nothing', rt2.describeApiError(''), '')

// The builders themselves, against a stub registry — deterministic, and far
// better than driving a live Jira to find out whether grouping works.
const { Subject } = require(path.join(REPO, 'node_modules/rxjs'))
function runtimeFor (integration) {
    const registry = {
        integrations$: new Subject(),
        current: () => [integration],
        byId: id => (integration.id === id ? integration : null),
        visibleFieldKeys: i => (i.fields ?? (i.manifest.fields || []).filter(f => f.default).map(f => f.key)),
        visibleTabKeys: i => (i.tabs ?? (i.manifest.tabs || []).filter(t => t.default).map(t => t.key)),
    }
    return new rt2.IntegrationRuntimeService(registry)
}

const groupedManifest = {
    id: 'g', name: 'G',
    fields: [
        { key: 'title', label: 'Title', path: '/title', kind: 'title', default: true },
        { key: 'a', label: 'A', path: '/a', default: true },
        { key: 'b', label: 'B', path: '/b', default: true },
        { key: 'missing', label: 'Missing', path: '/nope', default: true },
    ],
    fieldGroups: [{ key: 'pair', label: 'Pair', fields: ['a', 'b'] }],
    tabs: [
        { key: 'body', label: 'Body', kind: 'body', path: '/body', format: 'text', default: true },
        { key: 'notes', label: 'Notes', kind: 'list', path: '/notes', format: 'text', default: true,
            itemAuthorPath: '/who', itemBodyPath: '/what', itemTimePath: '/when' },
        { key: 'off', label: 'Off', kind: 'body', path: '/body', default: false },
    ],
    actions: [
        { key: 'move', label: 'Move to', kind: 'choice',
            optionsPath: '/transitions', optionIdPath: '/id', optionLabelPath: '/name',
            optionBadgePath: '/to/name', optionTargetIdPath: '/to/id',
            currentStatePath: '/statusId', url: 'https://x.test/t' },
        { key: 'empty', label: 'Empty', kind: 'choice', optionsPath: '/nothing', url: 'https://x.test/e' },
    ],
}
const integration = {
    id: 'g', name: 'G', manifest: groupedManifest, source: 'built-in',
    enabled: true, settings: {}, credentials: {}, fields: null, tabs: null, configured: true,
}
const svc = runtimeFor(integration)
const data = {
    title: 'The title', a: 'A value', b: 'B value',
    body: 'a body',
    notes: [{ who: 'Ada', what: 'first', when: new Date().toISOString() }],
    transitions: [
        { id: '11', name: 'Start', to: { id: '2', name: 'In Progress' } },
        { id: '21', name: 'Done', to: { id: '3', name: 'Done' } },
    ],
    statusId: '1',
}
const fields = svc.buildFields(integration, {}, data)
const groups = svc.buildGroups(integration, fields)
check('an empty-valued field never renders', fields.some(f => f.key === 'missing'), false)
check('grouped fields land in their group', groups.find(g => g.label === 'Pair')?.fields.map(f => f.key), ['a', 'b'])
check('ungrouped fields lead, unlabelled', groups[0].label, '')
check('and carry what no group claimed', groups[0].fields.map(f => f.key), ['title'])

const tabs = svc.buildTabs(integration, {}, data)
check('only default tabs are built', tabs.map(t => t.key), ['body', 'notes'])
check('a body tab carries its text', tabs[0].body, 'a body')
check('a list tab repeats over the array', tabs[1].items.length, 1)
check('list item paths are relative to the element', tabs[1].items[0].author, 'Ada')
check('a list item time is humanised', tabs[1].items[0].time, 'just now')

const actions = svc.buildActions(integration, {}, data)
check('a choice action resolves its options', actions.length, 1)
check('an action with no options is dropped', actions.some(a => a.key === 'empty'), false)
check('options carry id, label and badge',
    actions[0].options.map(o => [o.id, o.label, o.badge]),
    [['11', 'Start', 'In Progress'], ['21', 'Done', 'Done']])
check('the current state is resolved for undo', actions[0].currentState, '1')
check('an option knows the state it leads to', actions[0].options[0].targetId, '2')

// A manifest with no groups at all is still one implicit group.
const plain = { ...integration, manifest: { id: 'p', fields: groupedManifest.fields } }
const plainFields = svc.buildFields(plain, {}, data)
check('no fieldGroups means one unlabelled group',
    svc.buildGroups(plain, plainFields).map(g => g.label), [''])

// The manifests really do exercise the new keys now.
const jira = require(path.join(REPO, 'tabby-links/src/integrations/jira.json'))
const github = require(path.join(REPO, 'tabby-links/src/integrations/github.json'))
const stith2 = require(path.join(REPO, 'tabby-links/src/integrations/stith.json'))
check('jira declares field groups', (jira.fieldGroups || []).length > 0, true)
check('jira declares tabs', (jira.tabs || []).length > 0, true)
check('jira declares a choice action',
    (jira.actions || []).some(a => a.kind === 'choice'), true)
check('jira has an optional step', (jira.fetch || []).some(s => s.optional), true)
check('github is a built-in now', github.id, 'github')
check('stith declares a detect pattern', (stith2.detectPatterns || []).length, 1)

console.log('\n── the html representation ──')
const hh = loadSource('tabby-links/src/htmlHost.ts')

// The sandbox is the entire security story: `allow-scripts` alone leaves the
// frame on an opaque origin. Adding `allow-same-origin` would hand a plugin's
// page this window's file:// origin, and with nodeIntegration on that is
// `window.parent.require('child_process')`. This assertion is the one that
// must never be quietly relaxed.
check('sandbox is exactly allow-scripts', hh.HTML_SANDBOX, 'allow-scripts')
check('sandbox never grants same-origin', hh.HTML_SANDBOX.includes('allow-same-origin'), false)

// The template writes the attribute out literally (Angular refuses a bound
// one), so the constant above and the markup can drift. They must not.
const cardPug = require('fs').readFileSync(
    path.join(REPO, 'tabby-links/src/components/linkHoverCard.component.pug'), 'utf8')
check('the template hard-codes the same sandbox',
    cardPug.includes(`sandbox='${hh.HTML_SANDBOX}'`), true)
check('the template never grants same-origin',
    cardPug.includes('allow-same-origin'), false)
check('the sandbox is not bound',
    /\[attr\.sandbox\]|\[sandbox\]/.test(cardPug), false)
check('csp denies by default', hh.HTML_CSP.startsWith("default-src 'none'"), true)
check('csp blocks the network', hh.HTML_CSP.includes("connect-src 'none'"), true)
check('csp blocks form submission', hh.HTML_CSP.includes("form-action 'none'"), true)

// A page sends whatever it likes; every shape has to be survivable.
for (const [input, expected] of [
    [0, null], [-5, null], [39, 40], [40, 40], [120, 120], [320, 320], [321, 320],
    [10000, 320], [NaN, null], [Infinity, null], [119.6, 120], ['120', 120],
    ['abc', null], [null, null], [undefined, null], [{}, null], [[], null], [true, null],
]) {
    check(`clamp ${JSON.stringify(input)}`, hh.clampHtmlHeight(input), expected)
}

// The CSP and the bootstrap have to land ahead of anything the page can run,
// whatever shape the document arrived in.
const PAGE_MARK = 'PAGESCRIPT'
for (const [name, doc] of [
    ['full document', `<!doctype html><html><head><title>t</title></head><body><script>${PAGE_MARK}</script></body></html>`],
    ['no head', `<!doctype html><html><body><script>${PAGE_MARK}</script></body></html>`],
    ['doctype only', `<!doctype html><script>${PAGE_MARK}</script>`],
    ['bare fragment', `<div>x</div><script>${PAGE_MARK}</script>`],
    ['uppercase tags', `<!DOCTYPE HTML><HTML><HEAD></HEAD><BODY><script>${PAGE_MARK}</script></BODY></HTML>`],
    ['head with attributes', `<html><head lang="en" data-x="1"><script>${PAGE_MARK}</script></head></html>`],
]) {
    const out = hh.buildHtmlDocument(doc, { a: 1 }, 'https://example.test/x')
    const csp = out.indexOf('Content-Security-Policy')
    const boot = out.indexOf('window.__data')
    const page = out.indexOf(PAGE_MARK)
    check(`${name}: csp present`, csp !== -1, true)
    check(`${name}: csp precedes page script`, csp !== -1 && csp < page, true)
    check(`${name}: bootstrap precedes page script`, boot !== -1 && boot < page, true)
}

// A doctype must stay first or the page silently drops into quirks mode.
const doctyped = hh.buildHtmlDocument('<!doctype html><html><head></head></html>', {}, 'u')
check('doctype stays first', doctyped.trim().toLowerCase().startsWith('<!doctype html>'), true)

// The hovered text is whatever a remote host printed, and the step data can
// carry remote content too. Neither may end the script element it sits in.
const BREAKOUT = '</script><script>evil()</script>'
const escaped = hh.buildHtmlDocument('<html><head></head><body></body></html>', { s: BREAKOUT }, BREAKOUT)
check('data cannot close the script', escaped.includes(BREAKOUT), false)
check('uri cannot close the script', escaped.split('\\u003c/script').length >= 3, true)
check('only our own script tags close', (escaped.match(/<\/script>/gi) || []).length, 1)
check('comment opener is escaped too', hh.jsonLiteral('<!--').includes('<'), false)
check('u2028 is escaped', hh.jsonLiteral('a\u2028b'), '"a\\u2028b"')
check('u2029 is escaped', hh.jsonLiteral('a\u2029b'), '"a\\u2029b"')
check('unserialisable becomes null, not code', hh.jsonLiteral(0n), 'null')

const circular = {}
circular.self = circular
check('circular becomes null', hh.jsonLiteral(circular), 'null')

// The shim is what makes one manifest work in both forks.
const shimmed = hh.buildHtmlDocument('<html><head></head></html>', {}, 'u')
check('chrome.webview shim is provided', shimmed.includes('window.chrome.webview'), true)
check('__uri is provided', shimmed.includes('window.__uri'), true)

// Both message shapes in the contract, plus the noise around them.
check('object height', hh.parseHtmlHostMessage({ height: 100 }), { height: 100 })
check('json string height', hh.parseHtmlHostMessage('{"height":100}'), { height: 100 })
check('open', hh.parseHtmlHostMessage({ open: 'https://x.test' }), { open: 'https://x.test' })
check('both at once', hh.parseHtmlHostMessage({ height: 9000, open: 'https://y.test' }), { height: 320, open: 'https://y.test' })
check('height below the floor still clamps', hh.parseHtmlHostMessage({ height: 5 }), { height: 40 })
check('empty object is not a message', hh.parseHtmlHostMessage({}), null)
check('unknown keys are not a message', hh.parseHtmlHostMessage({ nope: 1 }), null)
check('non-json string', hh.parseHtmlHostMessage('not json'), null)
check('null', hh.parseHtmlHostMessage(null), null)
check('non-string open is ignored', hh.parseHtmlHostMessage({ open: 123 }), null)
check('empty open is ignored', hh.parseHtmlHostMessage({ open: '' }), null)

console.log('\n── rule presets ──')
const presets = loadSource('tabby-links/src/presets.ts')
const api = loadSource('tabby-links/src/api.ts')
const rules = loadSource('tabby-links/src/services/linkRules.service.ts')

// Presets take their patterns from the manifests, so build the list the
// settings page would: the four built-ins, shaped as the registry hands them
// over.
const BUILT_IN = ['github', 'jira', 'slack', 'stith'].map(id => {
    const manifest = require(path.join(REPO, `tabby-links/src/integrations/${id}.json`))
    return { id: manifest.id, name: manifest.name, manifest }
})
const allPresets = presets.rulePresets(BUILT_IN)

// Every catalogue entry must resolve. A manifest-backed preset whose matcher
// can no longer be found is dropped — silently, and by design — so this list of
// ids is the assertion that none of them has been.
check('every preset is offered, in order', allPresets.map(p => p.id), [
    'jira-issue-keys', 'jira-issue-links',
    'github-pull-requests', 'github-issues', 'github-commits',
    'slack-messages',
    'stith-session-uris', 'stith-web-links',
    'git-commit-hashes', 'media-files', 'source-code-files',
])
check('with no integrations, only the standalone presets remain',
    presets.rulePresets([]).map(p => p.id),
    ['git-commit-hashes', 'media-files', 'source-code-files'])

// No second copy of anyone's regex: a manifest-backed preset's pattern has to
// be a string the manifest itself contains, selected unambiguously.
const manifestPatterns = new Set(
    BUILT_IN.flatMap(i => (i.manifest.matchers ?? []).map(m => m.pattern)))
for (const preset of allPresets) {
    if (!preset.integration) {
        continue
    }
    check(`${preset.id}: pattern comes from the manifest`,
        manifestPatterns.has(preset.pattern), true)
    const integration = BUILT_IN.find(i => i.id === preset.integration)
    const claiming = (integration.manifest.matchers ?? []).filter(m =>
        (m.kind ?? 'link') === preset.match && new RegExp(m.pattern).test(preset.example))
    check(`${preset.id}: exactly one matcher claims its example`, claiming.length, 1)
}

// Every preset compiles, and passes the guard that would otherwise refuse it at
// the moment it was applied. Measured, because "looks fine" is exactly how a
// shipped preset becomes a rule that silently never fires.
let slowestCheck = 0
for (const preset of allPresets) {
    if (!preset.pattern) {
        continue
    }
    let compiles = true
    try {
        void new RegExp(preset.pattern, 'g')
    } catch (err) {
        compiles = false
    }
    check(`${preset.id}: compiles as a JS RegExp`, compiles, true)
    const started = process.hrtime.bigint()
    const verdict = guard.checkPattern(preset.pattern)
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6
    slowestCheck = Math.max(slowestCheck, elapsed)
    check(`${preset.id}: passes checkPattern (${elapsed.toFixed(2)}ms)`
        + (verdict.ok ? '' : ` — ${verdict.error}`), verdict.ok, true)
}
console.log(`  slowest checkPattern across all presets: ${slowestCheck.toFixed(2)}ms`)

// And they stay fast on input designed to make a backtracking engine explode —
// at the length a text rule is actually offered (MAX_TEXT_INPUT) and well past
// it. The guard's own probe stops at 22 characters on purpose; this is the
// other half of the claim, and the half a remote host controls.
const hostileInputs = n => [
    'a'.repeat(n),
    'ab'.repeat(Math.ceil(n / 2)),
    '0'.repeat(n) + 'x',
    'abcdef '.repeat(Math.ceil(n / 7)),
    '0123456789abcdef'.repeat(Math.ceil(n / 16)),
    'A'.repeat(n) + '-' + '9'.repeat(n),
    'https://' + 'a/'.repeat(Math.ceil(n / 2)),
    'https://github.com/' + 'a'.repeat(n) + '/pull/',
    'https://' + 'a'.repeat(n) + '.slack.com/archives/A/p',
    'stith://session/' + '-'.repeat(n),
    '/' + 'a/'.repeat(Math.ceil(n / 2)) + 'x.png',
]
let slowestMatch = 0
let slowestWhere = ''
for (const preset of allPresets) {
    if (!preset.pattern) {
        continue
    }
    // The flags the rules service compiles a rule with: 'g' for a text rule
    // scanned across a line, 'i' for a link rule tested against one URI.
    const flags = preset.match === 'text' ? 'g' : 'i'
    let worst = 0
    for (const length of [guard.MAX_TEXT_INPUT, 4096]) {
        for (const input of hostileInputs(length)) {
            const regex = new guard.GuardedRegex(preset.pattern, flags, preset.id)
            const started = process.hrtime.bigint()
            regex.execAll(input, preset.match === 'text' ? 32 : 1)
            worst = Math.max(worst, Number(process.hrtime.bigint() - started) / 1e6)
        }
    }
    if (worst > slowestMatch) {
        slowestMatch = worst
        slowestWhere = preset.id
    }
    check(`${preset.id}: under 5ms on hostile input (worst ${worst.toFixed(2)}ms)`, worst < 5, true)
}
console.log(`  slowest match across all presets: ${slowestMatch.toFixed(2)}ms (${slowestWhere})`)

// Each preset matches the thing it claims to. A file-type preset has no
// pattern; its criteria are the scheme and the extension, which is what
// `LinkRulesService` checks for it.
function presetMatches (preset, text) {
    if (preset.pattern) {
        return new RegExp(preset.pattern).test(text)
    }
    return (!preset.schemes.length || preset.schemes.includes(rules.schemeOf(text)))
        && ft.matchesFileType(text, preset.fileTypeGroup, preset.extensions)
}
for (const preset of allPresets) {
    check(`${preset.id}: matches its own example`, presetMatches(preset, preset.example), true)
}

// …and not the obvious near-misses.
const nearMisses = {
    'jira-issue-keys': ['cab-8209', 'CAB8209', 'C-1'],
    'jira-issue-links': ['https://example.atlassian.net/browse/cab-8209', 'https://example.atlassian.net/CAB-8209'],
    'github-pull-requests': ['https://github.com/Eugeny/tabby/issues/11383', 'https://gitlab.com/a/b/pull/1', 'http://github.com/a/b/pull/1'],
    'github-issues': ['https://github.com/Eugeny/tabby/pull/11511', 'https://github.com/Eugeny/tabby/issues/'],
    'github-commits': ['https://github.com/Eugeny/tabby/commit/zzzzzzz', 'https://github.com/Eugeny/tabby/commit/abc'],
    'slack-messages': ['https://myteam.slack.com/archives/C01234ABCD/p17123456780', 'https://slack.com/archives/C1/p1712345678000100'],
    'stith-session-uris': ['stith://other/1a2b3c4d', 'stith://session/ab'],
    'stith-web-links': ['https://stith.lvh.me/nope/1a2b3c4d', 'stith://agent/1a2b3c4d'],
    'git-commit-hashes': ['1234567', '12345678901234', 'abcdef', 'ghijklm'],
    'media-files': ['/home/steve/notes.md', 'https://example.test/a.txt'],
    'source-code-files': ['/home/steve/notes.md', 'https://example.test/a.ts'],
}
for (const preset of allPresets) {
    for (const miss of nearMisses[preset.id] ?? []) {
        check(`${preset.id}: does not match ${JSON.stringify(miss)}`, presetMatches(preset, miss), false)
    }
}

// `git-commit-hashes` is the one pattern written here rather than taken from a
// manifest, and the letter it insists on is the whole reason it is not noise.
const hashes = allPresets.find(p => p.id === 'git-commit-hashes')
const hashRegex = () => new RegExp(hashes.pattern)
check('a full sha matches', hashRegex().test('c79ccc1f0a7d4e2b1c3f5a6d8e9b0c1d2e3f4a5b'), true)
check('an abbreviated sha matches', hashRegex().test('c79ccc1'), true)
check('an epoch timestamp does not', hashRegex().test('1712345678'), false)
check('a port number does not', hashRegex().test('24200'), false)

// ── applying one ────────────────────────────────────────────────────────────

const fresh = presets.applyPreset(allPresets.find(p => p.id === 'media-files'))
check('a preset fills in a fresh rule', {
    name: fresh.name, match: fresh.match, schemes: fresh.schemes,
    fileTypeGroup: fresh.fileTypeGroup, integration: fresh.integration, enabled: fresh.enabled,
}, {
    name: 'Media: Images, audio and video', match: 'link', schemes: ['file', 'http', 'https'],
    fileTypeGroup: 'media', integration: '', enabled: true,
})

// Two rules from one preset must not share their arrays, or editing one edits
// the other — and the config is then written with a YAML anchor pointing at it.
const twin = presets.applyPreset(allPresets.find(p => p.id === 'media-files'))
twin.schemes.push('sftp')
check('the schemes array is copied, not shared', fresh.schemes.length, 3)

// Applied over an existing rule: criteria replaced, overrides reset, and the
// user's own custom actions left alone.
const existing = api.newRule()
existing.name = 'mine'
existing.match = 'text'
existing.pattern = 'nonsense'
existing.showDelay = 1234
existing.maxWidth = 999
existing.suppressOpen = true
existing.actions = [{ name: 'Show', icon: '', type: 'sendInput', value: 'git show %u' }]
const returned = presets.applyPreset(allPresets.find(p => p.id === 'github-commits'), existing)
check('applied in place', returned === existing, true)
check('criteria replaced',
    [existing.match, existing.integration, existing.pattern.startsWith('^https://github')],
    ['link', 'github', true])
check('overrides reset', [existing.showDelay, existing.hideDelay, existing.maxWidth], [null, null, null])
check('button suppression reset', existing.suppressOpen, false)
check('custom actions survive', existing.actions.length, 1)

// The Jira text preset and the Integrations page's "Add as rule" describe the
// same thing, so they must produce the same rule.
const jiraManifest = require(path.join(REPO, 'tabby-links/src/integrations/jira.json'))
const suggested = jiraManifest.matchers.find(m => m.kind === 'text' && m.suggested)
const viaPreset = presets.applyPreset(allPresets.find(p => p.id === 'jira-issue-keys'))
check('preset and "Add as rule" agree',
    [viaPreset.name, viaPreset.pattern, viaPreset.integration, viaPreset.match],
    [`Jira: ${suggested.description}`, suggested.pattern, 'jira', 'text'])

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
