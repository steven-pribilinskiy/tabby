// "Search the web for ..." in the real app: the menu the tab actually builds,
// and the URL the item would hand the browser.
//
//   node scripts/dev/launch-hidden.mjs &
//   node tabby-terminal/test/webSearch.cdp.js
//
// The selection is a real xterm selection, and the menu is the one
// `buildContextMenu()` produces — so this proves the provider is registered and
// that it reads the live selection, which webSearch.test.js cannot.
//
// Nothing is ever opened: PlatformService.openExternal is swapped for a recorder
// on the singleton every provider holds, and put back at the end. Launching a
// browser would steal focus.
const { connect } = require('./cdp')

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

const MARK = 'WEBSEARCHMARK alpha & beta'

const SETUP = `
    const cmp = ${ROOT}
    const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const tab = all.find(t => t.frontend && t.frontend.xterm)
    if (!tab) { throw new Error('no terminal tab with an xterm') }
    const parent = cmp.app.tabs.find(t => t.getAllTabs && t.getAllTabs().includes(tab)) || tab
    cmp.app.selectTab(parent)
    await new Promise(r => setTimeout(r, 300))
    window.ng.applyChanges(cmp)

    const xterm = tab.frontend.xterm
    await new Promise(r => xterm.write('\\r\\n' + ${JSON.stringify(MARK)} + '\\r\\n', r))
    await new Promise(r => setTimeout(r, 100))

    const buf = xterm.buffer.active
    let markRow = -1
    for (let y = 0; y <= buf.baseY + buf.cursorY; y++) {
        const line = buf.getLine(y)
        if (line && line.translateToString(true).includes('WEBSEARCHMARK')) { markRow = y }
    }
    if (markRow === -1) { throw new Error('the marker never reached the buffer') }

    window.__T = {
        tab, xterm, markRow,
        platform: tab.platform,
        notifications: tab.notifications,
        config: tab.config,
        originalOpen: tab.platform.openExternal,
        originalError: tab.notifications.error,
        originalURL: tab.config.store.terminal.webSearchQueryURL,
        opened: [], errors: [],
    }
    tab.platform.openExternal = async (url) => { window.__T.opened.push(url) }
    tab.notifications.error = (m) => { window.__T.errors.push(m) }
    return { markRow, url: window.__T.originalURL }
`

const SELECT = `
    const { xterm, markRow } = window.__T
    xterm.select(0, markRow, ${MARK.length})
    return window.__T.tab.frontend.getSelection()
`

const MENU = `
    const items = await window.__T.tab.buildContextMenu()
    return items.filter(i => i.label).map(i => i.label)
`

const CLICK = `
    const items = await window.__T.tab.buildContextMenu()
    const item = items.find(i => (i.label ?? '').startsWith('Search the web for'))
    if (!item) { throw new Error('no web search item to click') }
    window.__T.opened = []
    window.__T.errors = []
    await item.click()
    await new Promise(r => setTimeout(r, 50))
    return { opened: window.__T.opened, errors: window.__T.errors }
`

const RESTORE = `
    const t = window.__T
    if (!t) { return 'nothing to restore' }
    t.platform.openExternal = t.originalOpen
    t.notifications.error = t.originalError
    t.config.store.terminal.webSearchQueryURL = t.originalURL
    t.xterm.clearSelection()
    return t.config.store.terminal.webSearchQueryURL
`

let passed = 0
let failed = 0
function check (name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) {
        passed++
        console.log(`ok   ${name}`)
    } else {
        failed++
        console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
    }
}

async function main () {
    const { evaluate, close } = await connect()
    try {
        const setup = await evaluate(SETUP)
        console.log(`     marker on row ${setup.markRow}, configured URL ${setup.url}`)
        check('the configured URL is the Google default',
            setup.url, 'https://www.google.com/search?q={{query}}')

        // No selection yet — nothing from us in the menu.
        await evaluate(`window.__T.xterm.clearSelection(); return null`)
        const without = await evaluate(MENU)
        check('with no selection there is no web search item',
            without.filter(l => l.startsWith('Search the web for')), [])
        check('and the rest of the menu is still there', without.includes('Copy'), true)

        const selection = await evaluate(SELECT)
        check('the real xterm selection is what we wrote', selection, MARK)

        const withSelection = await evaluate(MENU)
        const ours = withSelection.filter(l => l.startsWith('Search the web for'))
        check('a selection adds exactly one item', ours.length, 1)
        check('and it quotes the selection, with & doubled for the menu mnemonic',
            ours[0], 'Search the web for "WEBSEARCHMARK alpha && beta"')

        const clicked = await evaluate(CLICK)
        check('clicking opens one URL', clicked.opened.length, 1)
        check('and it is the encoded query, on the configured origin', clicked.opened[0],
            'https://www.google.com/search?q=WEBSEARCHMARK%20alpha%20%26%20beta')
        check('nothing was reported as an error', clicked.errors, [])
        const parsed = new URL(clicked.opened[0])
        check('the selection stayed one parameter', [...parsed.searchParams.keys()], ['q'])
        check('and decodes back to the selection', parsed.searchParams.get('q'), MARK)

        // A template the app must refuse. Each one has to open nothing at all.
        for (const template of [
            'javascript:alert({{query}})',
            'file:///c:/windows/{{query}}',
            'not a url {{query}}',
            'https://www.google.com/search?q=no-token',
            '',
        ]) {
            await evaluate(`window.__T.config.store.terminal.webSearchQueryURL = ${JSON.stringify(template)}; return null`)
            const refused = await evaluate(CLICK)
            check(`refused, and opens nothing: ${JSON.stringify(template)}`, refused.opened, [])
            // Also proves the ICU compiler passes `{{query}}` through as an
            // argument rather than trying to parse it as another placeholder.
            check(`refused, and says why: ${JSON.stringify(template)}`, refused.errors,
                ['The web search URL must be an http(s) URL containing {{query}}'])
        }

        // A custom engine still works, so the refusals above are the template's
        // fault and not the feature being off.
        await evaluate(`window.__T.config.store.terminal.webSearchQueryURL = 'https://duckduckgo.com/?q={{query}}'; return null`)
        const custom = await evaluate(CLICK)
        check('a custom engine opens', custom.opened,
            ['https://duckduckgo.com/?q=WEBSEARCHMARK%20alpha%20%26%20beta'])
    } finally {
        try {
            console.log(`     restored ${await evaluate(RESTORE)}`)
        } catch (e) {
            console.log(`     could not restore: ${e.message}`)
        }
        close()
    }
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
