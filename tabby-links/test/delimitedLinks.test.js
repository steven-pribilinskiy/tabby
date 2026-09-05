// Slack-style `<uri|label>` links: the pattern, the URI it yields, and the
// relationship it has to the bare-URI handler it has to beat.
//
//   node tabby-links/test/delimitedLinks.test.js
//
// Plain node, nothing running. What is checked here is everything that does not
// need a terminal: which spans match, what URI comes out of one, that the
// construct strictly encloses the bare-URI match nested inside it — the whole
// premise of giving it a higher priority — and that the pattern stays linear on
// input a remote host controls. Whether a column of a real row resolves to the
// URI is `delimitedLinks.cdp.js`, because only the app can answer that.

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

// Sources are loaded through a `.ts` require hook, the way `logic.test.js` and
// `wslPath.test.js` reach the same helpers. Only decorators and a couple of
// imports are evaluated at module scope, so stubbing those is enough.
const stubs = {
    '@angular/core': new Proxy({}, { get: () => (() => (target) => target) }),
    'ngx-toastr': new Proxy({}, { get: () => class Stub {} }),
    'tabby-core': new Proxy({}, { get: (_t, k) => k === '__esModule' ? true : class Stub {} }),
    'tabby-terminal': new Proxy({}, { get: () => class Stub {} }),
    // ESM-only, and nothing here calls it.
    'untildify': Object.assign((x) => x, { __esModule: true, default: (x) => x }),
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
const loadSource = (relative) => require(path.join(REPO, relative))

const dl = loadSource('tabby-links/src/delimitedLinks.ts')
const guard = loadSource('tabby-links/src/regexGuard.ts')
const handlers = loadSource('tabby-linkifier/src/handlers.ts')

// The real handler, constructed the way DI would minus the service it only
// needs in order to open something.
const urlHandler = new handlers.URLHandler(null)

// ── the URI a construct points at ───────────────────────────────────────────
console.log('\n── the URI a construct points at ──')

const SLACK = '<https://github.com/o/r/pull/9962|repo#9962>'
check('label stripped', dl.uriFromDelimitedLink(SLACK), 'https://github.com/o/r/pull/9962')
check('no label, just brackets',
    dl.uriFromDelimitedLink('<https://www.contoso.com/a>'), 'https://www.contoso.com/a')
check('a label may contain spaces',
    dl.uriFromDelimitedLink('<https://www.contoso.com/b|click here please>'), 'https://www.contoso.com/b')
check('a label may itself contain a pipe',
    dl.uriFromDelimitedLink('<https://x.test/1|a|b>'), 'https://x.test/1')
check('a fragment survives', dl.uriFromDelimitedLink('<https://x.test/1#L4>'), 'https://x.test/1#L4')

// ── which spans match ───────────────────────────────────────────────────────
console.log('\n── which spans match ──')

const spans = (text) => dl.findDelimitedLinks(text).map(l => [l.index, l.text, l.uri])

check('the whole construct, brackets included', spans(SLACK),
    [[0, SLACK, 'https://github.com/o/r/pull/9962']])
check('bracketed with no label', spans('see <https://www.contoso.com/a> here'),
    [[4, '<https://www.contoso.com/a>', 'https://www.contoso.com/a']])
check('a spaced label does not run past the closing bracket',
    spans('<https://www.contoso.com/b|click here please> and prose'),
    [[0, '<https://www.contoso.com/b|click here please>', 'https://www.contoso.com/b']])
check('two on one row',
    spans('<https://a.test/1|one> <https://b.test/2|two>').map(x => x[2]),
    ['https://a.test/1', 'https://b.test/2'])
check('a bare URI alongside one is left to the handler',
    spans('<https://www.contoso.com/e|e> https://www.contoso.com/d'),
    [[0, '<https://www.contoso.com/e|e>', 'https://www.contoso.com/e']])
check('any scheme, not just http — the fork has stith:// links',
    spans('<stith://session/abcd|agent>').map(x => x[2]), ['stith://session/abcd'])

// ── things that must not match ──────────────────────────────────────────────
console.log('\n── things that must not match ──')

check('an unterminated bracket does not swallow the row',
    spans('<https://www.contoso.com/c and then some prose'), [])
check('a pipe with no URI', spans('<just|a label>'), [])
check('a bare URI on its own', spans('https://www.contoso.com/d'), [])
check('brackets with nothing between them', spans('<>'), [])
check('a shell redirect is not a link', spans('cat <file.txt >out.txt'), [])
check('an angle-quoted mail address is not a scheme', spans('<someone@example.com>'), [])
// The inner `<` cannot be swallowed, because it is excluded from the URI class.
check('nested brackets resolve to the innermost complete construct',
    spans('<https://a.test/1<https://b.test/2|b>').map(x => x[2]), ['https://b.test/2'])
check('a line break in a label ends it', spans('<https://a.test/1|lab\nel>'), [])

// ── the bare-URI match it has to beat ───────────────────────────────────────
console.log('\n── the bare-URI match it has to beat ──')

// The premise of the port. In the Windows Terminal fork `|` is inside the
// bare-URI character class, so detection ran through the pipe and the opener
// was handed `…/9962|repo#9962`. Tabby's URLHandler stops at the pipe, so the
// URI is already right — what is missing is that the brackets and the label
// belong to no link at all. Asserted rather than assumed, because if this ever
// changes the fix has to change with it.
const bare = new RegExp(urlHandler.regex.source, 'g')
const bareMatches = (text) => {
    bare.lastIndex = 0
    const out = []
    let m
    while ((m = bare.exec(text))) {
        if (!m[0]) { bare.lastIndex++; continue }
        out.push([m.index, m[0]])
    }
    return out
}
const bareInSlack = bareMatches(SLACK)
check('the bare handler already stops at the pipe', bareInSlack,
    [[1, 'https://github.com/o/r/pull/9962']])
check('so the label and both brackets are covered by nothing else',
    bareInSlack[0][0] > 0 && bareInSlack[0][0] + bareInSlack[0][1].length < SLACK.length, true)
note(`bare match covers columns ${bareInSlack[0][0]}..${bareInSlack[0][0] + bareInSlack[0][1].length - 1} of 0..${SLACK.length - 1}`)

// Strict enclosure is what makes "prefer the delimited match" well-defined:
// giving it a higher priority takes the nested match's cells and nothing else's.
const delimited = dl.findDelimitedLinks(SLACK)[0]
check('the construct strictly encloses the bare match',
    bareInSlack[0][0] > delimited.index
    && bareInSlack[0][0] + bareInSlack[0][1].length < delimited.index + delimited.text.length, true)
check('and points at exactly what the bare match found', delimited.uri, bareInSlack[0][1])
check('the priority is above every handler',
    dl.DELIMITED_LINK_PRIORITY > urlHandler.priority, true)
note(`delimited ${dl.DELIMITED_LINK_PRIORITY} vs URLHandler ${urlHandler.priority}`)

// `handlerFor` in the decorator picks a handler by full-matching the extracted
// URI, so a `<uri|label>` opens by the same route the bare URI would.
check('the extracted URI still full-matches the handler that would have opened it',
    urlHandler.fullMatchRegex.test(delimited.uri), true)
check('but the raw construct does not', urlHandler.fullMatchRegex.test(SLACK), false)

// ── it cannot be used to freeze the window ──────────────────────────────────
console.log('\n── it cannot be used to freeze the window ──')

// This runs synchronously on a mousemove handler against text a remote host
// printed, so the budget is the package's own: regexGuard.MATCH_BUDGET_MS.
check('the package\'s own ReDoS gate accepts the pattern',
    guard.checkPattern(dl.DELIMITED_LINK_SOURCE, 'g'), { ok: true, error: '' })

const HOSTILE = [
    ['unclosed, long', '<https://a.test/' + 'a'.repeat(4000)],
    ['unclosed with a label', '<https://a.test/x|' + 'b'.repeat(4000)],
    ['many opening brackets', '<'.repeat(4000)],
    ['many candidate starts', '<https://a.test/aaaa'.repeat(200)],
    ['pipes all the way down', '<https://a.test/x' + '|'.repeat(4000)],
    ['scheme prefixes that never complete', 'ab://'.repeat(800)],
    ['a label that never closes, repeatedly', '<https://a.test/x|lab el '.repeat(160)],
]
let worst = 0
for (const [name, input] of HOSTILE) {
    const started = process.hrtime.bigint()
    dl.findDelimitedLinks(input)
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    worst = Math.max(worst, ms)
    check(`${name} stays inside the match budget`, ms < guard.MATCH_BUDGET_MS, true)
    note(`${name}: ${ms.toFixed(2)} ms on ${input.length} chars`)
}
note(`worst ${worst.toFixed(2)} ms, budget ${guard.MATCH_BUDGET_MS} ms`)

// Growth, not just an absolute number: an exponential pattern is cheap at 1000
// and ruinous at 4000, so the ratio is the thing that proves linearity.
const grow = (n) => {
    const input = '<https://a.test/' + 'a'.repeat(n)
    const started = process.hrtime.bigint()
    for (let i = 0; i < 50; i++) {
        dl.findDelimitedLinks(input)
    }
    return Number(process.hrtime.bigint() - started) / 1e6
}
grow(1000)
const small = grow(1000)
const large = grow(8000)
check('cost grows linearly, not explosively, with input length', large < small * 32, true)
note(`1000 chars ×50: ${small.toFixed(2)} ms, 8000 chars ×50: ${large.toFixed(2)} ms (×${(large / small).toFixed(1)} for ×8 input)`)

check('a row of links is capped', dl.findDelimitedLinks('<https://a.test/1|x>'.repeat(200)).length, 64)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
