// "Search the web for ..." — the URL it builds, and the menu item it offers.
//
//   node tabby-terminal/test/webSearch.test.js
//
// Plain node, nothing running. The selection is text a remote host printed, so
// most of this is about what a crafted one cannot do: change the host, change
// the scheme, or add a second query parameter. The real menu, in the real app,
// is webSearch.cdp.js.

const path = require('path')
const fs = require('fs')
const Module = require('module')

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
function note (text) {
    console.log(`     ${text}`)
}

// Sources are loaded through a `.ts` require hook, the way tabby-links' own
// logic tests reach the same helpers. Only decorators and the `instanceof`
// target are evaluated at module scope, so stubbing those is enough — pulling
// in the real BaseTerminalTabComponent would drag in Angular and xterm.
class FakeTerminalTab {}
const stubs = {
    '@angular/core': new Proxy({}, { get: () => (() => (target) => target) }),
    'tabby-core': new Proxy({}, {
        get: (_t, k) => {
            if (k === '__esModule') {
                return true
            }
            if (k === 'Platform') {
                return { Windows: 'Windows', macOS: 'macOS', Linux: 'Linux', Web: 'Web' }
            }
            return class Stub {}
        },
    }),
    './api/baseTerminalTab.component': { __esModule: true, BaseTerminalTabComponent: FakeTerminalTab },
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
    return stubs[request] ? request : originalResolve.call(this, request, ...rest)
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
    return stubs[request] ? stubs[request] : originalLoad.call(this, request, ...rest)
}
const ts = require(path.join(REPO, 'node_modules/typescript'))
Module._extensions['.ts'] = function (module, filename) {
    const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText
    module._compile(js, filename)
}

const ws = require(path.join(REPO, 'tabby-terminal/src/webSearch.ts'))
const { TerminalConfigProvider } = require(path.join(REPO, 'tabby-terminal/src/config.ts'))

// ── the shipped default ───────────────────────────────────────────────────────

const DEFAULT = new TerminalConfigProvider().defaults.terminal.webSearchQueryURL
check('the default query URL is Google', DEFAULT, 'https://www.google.com/search?q={{query}}')
check('the default carries the token', DEFAULT.includes(ws.WEB_SEARCH_TOKEN), true)
check('the default forces no exact phrase', /%22|"/.test(DEFAULT), false)

// ── an ordinary selection ─────────────────────────────────────────────────────

check('an ordinary selection', ws.buildSearchURL(DEFAULT, 'ENOENT node-pty'),
    'https://www.google.com/search?q=ENOENT%20node-pty')
check('a one-word selection', ws.buildSearchURL(DEFAULT, 'EBUSY'),
    'https://www.google.com/search?q=EBUSY')

// ── encoding: the characters that would otherwise corrupt the URL ─────────────

const HOSTILE = 'foo & bar#baz+qux\nnext  line\tand%20more?x=1'
const hostileURL = ws.buildSearchURL(DEFAULT, HOSTILE)
note(`hostile selection -> ${hostileURL}`)
check('& # + space newline tab % ? are all encoded', hostileURL,
    'https://www.google.com/search?q=foo%20%26%20bar%23baz%2Bqux%20next%20line%20and%2520more%3Fx%3D1')

const parsed = new URL(hostileURL)
check('the selection is still exactly one parameter', [...parsed.searchParams.keys()], ['q'])
check('and it round-trips to the normalised selection', parsed.searchParams.get('q'),
    'foo & bar#baz+qux next line and%20more?x=1')
check('nothing became a fragment', parsed.hash, '')
check('nothing became a path', parsed.pathname, '/search')

for (const [name, selection, expectedQ] of [
    ['a second parameter', 'kittens&utm_source=evil', 'kittens&utm_source=evil'],
    ['a fragment', 'kittens#evil', 'kittens#evil'],
    ['a plus, which decodes as a space if left bare', 'a+b', 'a+b'],
    ['a slash', 'src/index.ts', 'src/index.ts'],
    ['an equals', 'x=1', 'x=1'],
    ['a quote and a backslash', 'he said "hi" \\o/', 'he said "hi" \\o/'],
    ['unicode', 'caf\u00e9 \u2014 \u2705', 'caf\u00e9 \u2014 \u2705'],
]) {
    const url = new URL(ws.buildSearchURL(DEFAULT, selection))
    check(`${name}: still one parameter`, [...url.searchParams.keys()], ['q'])
    check(`${name}: value survives intact`, url.searchParams.get('q'), expectedQ)
    check(`${name}: origin unchanged`, url.origin, 'https://www.google.com')
}

// ── normalisation ─────────────────────────────────────────────────────────────

check('newlines and runs of whitespace collapse to single spaces',
    ws.normalizeQuery('one\r\n  two\t\tthree \n four'), 'one two three four')
check('leading and trailing whitespace goes', ws.normalizeQuery('  padded  '), 'padded')
check('a whitespace-only selection is nothing', ws.normalizeQuery(' \n\t '), '')
check('a huge selection is capped', ws.normalizeQuery('a'.repeat(10000)).length, ws.MAX_QUERY_LENGTH)
check('nothing to search yields no URL', ws.buildSearchURL(DEFAULT, ' \n '), null)
check('an empty selection yields no URL', ws.buildSearchURL(DEFAULT, ''), null)

// ── a template that must not open anything ────────────────────────────────────

for (const [name, template] of [
    ['no token at all', 'https://www.google.com/search?q=fixed'],
    ['not a URL', 'google {{query}}'],
    ['a bare host', 'www.google.com/search?q={{query}}'],
    ['javascript:', 'javascript:alert({{query}})'],
    ['data:', 'data:text/html,{{query}}'],
    ['file:', 'file:///c:/windows/{{query}}'],
    ['an app scheme', 'stith://session/{{query}}'],
    ['the token in the host', 'https://{{query}}.evil.test/'],
    ['the token as the whole URL', '{{query}}'],
    ['empty', ''],
    ['whitespace', '   '],
]) {
    check(`refused: ${name}`, ws.buildSearchURL(template, 'kittens'), null)
}
for (const [name, template] of [[ 'undefined', undefined ], [ 'null', null ], [ 'a number', 42 ], [ 'an object', {} ]]) {
    check(`refused: ${name}`, ws.buildSearchURL(template, 'kittens'), null)
}

// A selection can never smuggle a scheme in, because the template's scheme is
// parsed before substitution and re-checked after it.
check('a selection cannot become a scheme',
    ws.buildSearchURL(DEFAULT, 'javascript:alert(1)'),
    'https://www.google.com/search?q=javascript%3Aalert(1)')
check('a selection cannot become a host',
    new URL(ws.buildSearchURL(DEFAULT, '//evil.test/x')).origin, 'https://www.google.com')

// ── templates that are fine ───────────────────────────────────────────────────

check('a custom engine', ws.buildSearchURL('https://duckduckgo.com/?q={{query}}', 'a b'),
    'https://duckduckgo.com/?q=a%20b')
check('http is allowed', ws.buildSearchURL('http://intranet.test/s?q={{query}}', 'a b'),
    'http://intranet.test/s?q=a%20b')
check('a token in the path', ws.buildSearchURL('https://wiki.test/search/{{query}}', 'a b'),
    'https://wiki.test/search/a%20b')
check('the token twice', ws.buildSearchURL('https://x.test/{{query}}?q={{query}}', 'a b'),
    'https://x.test/a%20b?q=a%20b')
check('other parameters are preserved',
    ws.buildSearchURL('https://www.google.com/search?hl=en&q={{query}}&safe=off', 'a b'),
    'https://www.google.com/search?hl=en&q=a%20b&safe=off')
check('a port survives', ws.buildSearchURL('https://intranet.test:8443/s?q={{query}}', 'a'),
    'https://intranet.test:8443/s?q=a')

// ── the menu label ────────────────────────────────────────────────────────────

check('a short selection is quoted whole', ws.menuLabelQuery('EBUSY', true), 'EBUSY')
const long = 'a'.repeat(200)
const label = ws.menuLabelQuery(long, true)
check('a long one is cut', label.length, ws.MAX_LABEL_LENGTH)
check('and says so', label.endsWith('\u2026'), true)
check('the cut happens before the escaping, so && never splits',
    ws.menuLabelQuery(`${'&'.repeat(60)}`, true).length, ws.MAX_LABEL_LENGTH * 2 - 1)
check('& is doubled where menus read a mnemonic', ws.menuLabelQuery('foo & bar', true), 'foo && bar')
check('and left alone where they do not', ws.menuLabelQuery('foo & bar', false), 'foo & bar')
check('a label is always one line', /[\r\n]/.test(ws.menuLabelQuery(ws.normalizeQuery('a\nb'), true)), false)

// ── the item appears only when there is a selection ───────────────────────────

const provider = new ws.WebSearchContextMenu(
    { store: { terminal: { webSearchQueryURL: DEFAULT } } },
    { platform: 'Windows' },
    { error: () => {} },
    { openExternal: async () => {} },
    { instant: (key, params) => `${key}|${JSON.stringify(params ?? {})}` },
)
const terminalTab = (selection) => Object.assign(Object.create(FakeTerminalTab.prototype), {
    frontend: selection === null ? undefined : { getSelection: () => selection },
})

const run = async () => {
    check('no selection, no item', (await provider.getItems(terminalTab(''))).length, 0)
    check('whitespace only, no item', (await provider.getItems(terminalTab('  \n '))).length, 0)
    check('no frontend, no item', (await provider.getItems(terminalTab(null))).length, 0)
    check('not a terminal tab, no item', (await provider.getItems({})).length, 0)
    check('a tab header, no item', (await provider.getItems(terminalTab('kittens'), true)).length, 0)

    const items = await provider.getItems(terminalTab('kittens & dogs'))
    check('a selection produces one item', items.length, 1)
    check('the item quotes the selection back', items[0].label,
        'Search the web for "{query}"|{"query":"kittens && dogs"}')
    note(`label -> ${items[0].label}`)

    // What clicking it would open, without opening anything.
    let opened = null
    provider.platform = { openExternal: async (url) => { opened = url } }
    await items[0].click()
    check('clicking opens the built URL', opened, 'https://www.google.com/search?q=kittens%20%26%20dogs')

    // And what it does instead when the template is unusable.
    let notified = null
    opened = null
    provider.config.store.terminal.webSearchQueryURL = 'javascript:alert({{query}})'
    provider.notifications = { error: (m) => { notified = m } }
    await (await provider.getItems(terminalTab('kittens')))[0].click()
    check('a refused template opens nothing', opened, null)
    check('and says why', notified,
        'The web search URL must be an http(s) URL containing {token}|{"token":"{{query}}"}')

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}
run()
