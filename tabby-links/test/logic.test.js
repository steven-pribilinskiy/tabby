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
for (const id of ['jira', 'slack', 'stith']) {
    const ours = require(path.join(REPO, `tabby-links/src/integrations/${id}.json`))
    const theirs = require(`C:/Users/steve/projects/terminal/src/cascadia/TerminalSettingsModel/integrations/${id}.json`)
    check(`${id}: matchers identical`, ours.matchers, theirs.matchers)
    check(`${id}: fetch pipeline identical`, ours.fetch, theirs.fetch)
    check(`${id}: display fields identical`, ours.fields, theirs.fields)
    check(`${id}: cache lifetime identical`, ours.cacheSeconds, theirs.cacheSeconds)
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

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
