// "Show in pane": the same preview, in a real pane instead of a hover card.
//
//   node scripts/dev/launch-hidden.mjs --enable links,linkifier   # prints its port
//   TABBY_CONFIG_DIRECTORY=<profile> node tabby-links/test/pane.cdp.js
//
// Four things are worth proving here and only one of them is appearance:
//
//  - the pane opens from the card's own button, through the real handler the
//    decorator bound to a real hovered link;
//  - a plugin's `html` document is *exactly* as sealed in the pane as it is on
//    the card — opaque origin, no require, no process, CSP present — because a
//    second host is exactly how that guarantee would quietly stop holding;
//  - hover cards go quiet while a pane is open, and come back when it closes;
//  - and nothing loops. An `*ngFor` over a method that builds objects has
//    already frozen this window once, and it does not fail a test — it hangs
//    one. So change-detection passes over the pane are counted while it sits
//    idle, and the renderer is asked questions with a deadline.
//
// This profile is reused and may hold real settings, so everything written
// here is put back.
const { closeAll, connect } = require('./cdp')

let passed = 0
let failed = 0
function check (name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) {
        passed++
        console.log(`  ok   ${name}`)
    } else {
        failed++
        console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
    }
}
function note (t) { console.log(`       ${t}`) }

function deadline (promise, ms, label) {
    return Promise.race([promise, new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`no answer in ${ms}ms (${label})`)), ms))])
}

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

// A terminal the decorator actually attached to — a restored-but-never-rendered
// tab has an xterm and no provider of ours, and picking one makes everything
// below look broken.
const SETUP = `
    const cmp = ${ROOT}
    const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const withXterm = all.filter(t => t.frontend && t.frontend.xterm)
    const anyDec = withXterm
        .map(t => (t.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator'))
        .find(d => d)
    const term = withXterm.find(t => anyDec && anyDec.states.has(t)) || withXterm[0]
    if (!term) { throw new Error('no terminal tab with an xterm') }
    const dec = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator')
    if (!dec) { throw new Error('the link decorator is not attached — launch with --enable links,linkifier') }
    const parent = cmp.app.tabs.find(t => t.getAllTabs && t.getAllTabs().includes(term)) || term
    cmp.app.selectTab(parent)
    // A previous run that failed part-way may have left a pane open, and the
    // service re-uses the one already showing for a terminal — so without this
    // the first assertion below measures the last run instead of this one.
    for (const el of document.querySelectorAll('link-preview-tab')) {
        const previous = window.ng.getComponent(el)
        if (previous) { previous.close() }
    }
    await new Promise(r => setTimeout(r, 700))
    window.__P = { root: cmp, tab: term, parent, dec, state: dec.states.get(term),
                   xterm: term.frontend.xterm, core: term.frontend.xterm._core }
`

/** A preview with one of everything the card can draw. */
const RICH_PREVIEW = `{
    integrationId: 'x', integrationName: 'X', icon: '', error: '', link: '',
    html: '', data: {}, skipped: [],
    fields: [
        { key: 'summary', label: 'Summary', value: 'A ticket', kind: 'title', iconUri: '', color: '' },
        { key: 'branches', label: 'Branches', value: '2', kind: 'text', iconUri: '', color: '' },
    ],
    groups: [
        { key: 'details', label: '', fields: [
            { key: 'summary', label: 'Summary', value: 'A ticket', kind: 'title', iconUri: '', color: '' },
        ] },
        { key: 'dev', label: 'Development', fields: [
            { key: 'branches', label: 'Branches', value: '2', kind: 'text', iconUri: '', color: '' },
        ] },
    ],
    tabs: [
        { key: 'description', label: 'Description', kind: 'body',
          body: '# Heading\\n\\nSome **bold** text.', markdown: true, items: [] },
        { key: 'comments', label: 'Comments', kind: 'list', body: '', markdown: false,
          items: [{ author: 'Ada', avatarUri: '', body: 'Looks good', time: 'just now' }] },
    ],
    actions: [
        { key: 'transition', label: 'Move to', kind: 'choice', currentState: '1', options: [
            { id: '11', label: 'Start', badge: 'In Progress', color: 'yellow', targetId: '2', fields: [] },
            { id: '21', label: 'Done', badge: 'Done', color: 'green', targetId: '3', fields: [] },
        ] },
    ],
}`

async function main () {
    const { evaluate, close } = await connect()

    // ── the pane opens from the card ─────────────────────────────────────────
    console.log('\n── the card opens a pane ──')
    const opened = await deadline(evaluate(`
        ${SETUP}
        // dec and parent are already declared by SETUP above.
        const { xterm, core, state, tab } = window.__P
        xterm.clear()
        xterm.write('\\r\\nsee https://example.com/pane-test done\\r\\n')
        await new Promise(r => setTimeout(r, 400))
        const buffer = xterm.buffer.active
        let row = -1
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i)
            if (line && line.translateToString(true).includes('pane-test')) { row = i; break }
        }
        if (row === -1) { return { error: 'text not found in the buffer' } }
        const ours = core._linkProviderService.linkProviders[1]
        const links = await new Promise(resolve => ours.provideLinks(row + 1, resolve))
        const link = (links || []).find(l => l.text.includes('pane-test'))
        if (!link) { return { error: 'the link was not detected' } }

        // A real hover, so the handlers the button uses are the ones the
        // decorator bound to this link — not something this test made up.
        link.hover()
        await new Promise(r => setTimeout(r, 900))
        const card = window.ng.getComponent(document.querySelector('link-hover-card'))
        const panesBefore = dec.panes.openCount
        // example.com is claimed by no integration, so the button is correctly
        // absent; forcing it on is what lets the *button* be tested without
        // depending on a live integration. Everything downstream of the click
        // is the real path.
        card.model.showInPane = true
        card.refresh()
        const button = [...document.querySelectorAll('link-hover-card button')]
            .find(b => b.textContent.trim() === 'Show in pane')
        if (!button) { return { error: 'the card has no Show in pane button' } }
        button.click()
        await new Promise(r => setTimeout(r, 1200))

        const paneEl = document.querySelector('link-preview-tab')
        const pane = paneEl && window.ng.getComponent(paneEl)
        window.__P.pane = pane
        window.__P.paneEl = paneEl
        // The split host sizes the pane's host element itself, so this is where
        // a wrong assumption about that shows up: a pane laid out at zero
        // height renders perfectly and is invisible.
        const box = paneEl ? paneEl.getBoundingClientRect() : null
        const screen = core.screenElement.getBoundingClientRect()
        const inner = paneEl ? paneEl.querySelector('.link-pane').getBoundingClientRect() : null
        return {
            box: box && { w: Math.round(box.width), h: Math.round(box.height) },
            fillsHost: !!(box && inner && Math.abs(inner.height - box.height) < 2
                && Math.abs(inner.width - box.width) < 2),
            // Tiling, not stacking: neither is over the other.
            overlapsTerminal: !!(box && box.left < screen.right && box.right > screen.left
                && box.top < screen.bottom && box.bottom > screen.top),
            panesBefore,
            panesAfter: dec.panes.openCount,
            mounted: !!paneEl,
            title: pane && pane.title,
            text: pane && pane.request.text,
            // It is a pane, not a tab: the terminal it came from is still
            // on screen beside it.
            inSameSplit: !!(pane && window.__P.parent.getAllTabs
                && window.__P.parent.getAllTabs().includes(pane)
                && window.__P.parent.getAllTabs().includes(tab)),
            // The card that was hovered gets out of the way.
            cardHidden: state.host.style.display === 'none',
            // Nobody claims example.com, so it says so rather than spinning.
            unclaimed: pane && pane.unclaimed,
        }
    `), 20000, 'open')

    if (opened.error) {
        console.log(`  FAIL setup: ${opened.error}`)
        failed++
        close()
        return
    }
    check('a preview pane is mounted', opened.mounted, true)
    check('the service counts it', opened.panesAfter, opened.panesBefore + 1)
    check('it names the link', opened.text, 'https://example.com/pane-test')
    check('the pane sits beside the terminal it came from', opened.inSameSplit, true)
    check('the hover card gets out of the way', opened.cardHidden, true)
    check('an unclaimed link says so rather than spinning', opened.unclaimed, true)
    check('the pane has a real size', opened.box.w > 100 && opened.box.h > 100, true)
    check('its content fills it', opened.fillsHost, true)
    check('it tiles beside the terminal rather than over it', opened.overlapsTerminal, false)
    note(`pane title: ${opened.title}   box: ${JSON.stringify(opened.box)}`)

    // ── it renders the whole preview ─────────────────────────────────────────
    console.log('\n── grouped fields, a markdown body, comments and actions ──')
    const rendered = await deadline(evaluate(`
        const { pane, paneEl } = window.__P
        pane.model = Object.assign({}, pane.model, {
            key: 'pane-test:' + Date.now(),
            loading: false, allowHtml: true, integrationName: 'X',
            preview: ${RICH_PREVIEW},
        })
        pane.unclaimed = false
        window.ng.applyChanges(pane)
        await new Promise(r => setTimeout(r, 300))
        const view = window.ng.getComponent(paneEl.querySelector('link-preview-view'))
        const groupLabels = [...paneEl.querySelectorAll('.group-label')].map(x => x.textContent.trim())
        const tabs = [...paneEl.querySelectorAll('.tab')].map(x => x.textContent.trim())
        const options = [...paneEl.querySelectorAll('.option')].map(x => x.textContent.trim())
        const bold = !!paneEl.querySelector('.md b')
        const bodyEl = paneEl.querySelector('.tab-body')
        const bodyMax = bodyEl ? getComputedStyle(bodyEl).maxHeight : 'no .tab-body'

        // The comment list is behind the second tab.
        view.selectTab(pane.model.preview.tabs[1])
        window.ng.applyChanges(pane)
        await new Promise(r => setTimeout(r, 200))
        const comments = [...paneEl.querySelectorAll('.tab-item-body')].map(x => x.textContent.trim())
        const authors = [...paneEl.querySelectorAll('.tab-author')].map(x => x.textContent.trim())

        return {
            groupLabels, tabs, options, bold, comments, authors, bodyMax,
            // One renderer, so this is the card's component in the pane.
            sharedRenderer: view.constructor.name,
            fields: [...paneEl.querySelectorAll('.field-label')].map(x => x.textContent.trim()),
            applyDisabled: paneEl.querySelector('.action-buttons .btn-primary').disabled,
        }
    `), 20000, 'render')

    check('the labelled group has a heading', rendered.groupLabels, ['Development'])
    check('a field row renders', rendered.fields, ['Branches'])
    check('both tabs are on the strip', rendered.tabs, ['Description', 'Comments'])
    check('markdown is real emphasis, not asterisks', rendered.bold, true)
    check('the comment list renders', rendered.comments, ['Looks good'])
    check('with its author', rendered.authors, ['Ada'])
    check('the choice offers both options', rendered.options.length, 2)
    check('Apply is blocked before anything is chosen', rendered.applyDisabled, true)
    check('it is the card\'s own renderer', rendered.sharedRenderer, 'LinkPreviewViewComponent')
    // The one thing the pane changes about the renderer: the card caps a body
    // at 190px because it is a hover affordance; the pane scrolls as a whole.
    check('the card\'s body cap is lifted in a pane', rendered.bodyMax, 'none')

    // ── the html representation is exactly as sealed here ────────────────────
    console.log('\n── a plugin\'s own document, in a pane ──')
    const html = await deadline(evaluate(`
        window.__paneProbe = []
        if (!window.__paneCollector) {
            window.__paneCollector = true
            window.addEventListener('message', e => {
                if (e.data && e.data.paneProbe) { window.__paneProbe.push(e.data.paneProbe) }
            })
        }
        const { pane, paneEl } = window.__P
        pane.model = Object.assign({}, pane.model, {
            key: 'pane-html:' + Date.now(),
            loading: false, allowHtml: true,
            preview: {
                integrationId: 'x', integrationName: 'X', icon: '', error: '', link: '',
                fields: [], groups: [], tabs: [], actions: [], skipped: [],
                data: { step: { hello: 'pane' } },
                html: [
                    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
                    '<div id="out"></div>',
                    '<script>',
                    'var p = {};',
                    'p.origin = String(window.origin);',
                    'try { p.parent = !!window.parent.document }',
                    'catch (e) { p.parent = "blocked:" + e.name }',
                    'p.hasRequire = typeof require !== "undefined";',
                    'p.hasProcess = typeof process !== "undefined";',
                    'p.data = JSON.stringify(window.__data);',
                    'p.uri = String(window.__uri);',
                    'p.rendered = true;',
                    'try { fetch("https://example.test/beacon").then(',
                    '  function(){ parent.postMessage({ paneProbe: { net: "ALLOWED" } }, "*") },',
                    '  function(){ parent.postMessage({ paneProbe: { net: "blocked" } }, "*") }) }',
                    'catch (e) { parent.postMessage({ paneProbe: { net: "blocked" } }, "*") }',
                    'parent.postMessage({ paneProbe: p }, "*");',
                    'chrome.webview.postMessage({ height: 100000 });',
                    '</script></body></html>',
                ].join(''),
            },
        })
        window.ng.applyChanges(pane)
        await new Promise(r => setTimeout(r, 1200))
        const frame = paneEl.querySelector('iframe.preview-html')
        let reach = 'READABLE'
        try { void frame.contentWindow.document.body } catch (e) { reach = e.name }
        return {
            present: !!frame,
            sandbox: frame && frame.getAttribute('sandbox'),
            csp: frame && frame.srcdoc.includes('Content-Security-Policy'),
            connectSrc: frame && frame.srcdoc.includes("connect-src 'none'"),
            height: frame && frame.style.height,
            reach,
            probe: window.__paneProbe.find(p => p.rendered) || {},
            net: (window.__paneProbe.find(p => p.net) || {}).net,
        }
    `), 25000, 'html')

    check('the frame is created in the pane', html.present, true)
    // The assertion this file exists for.
    check('sandbox is exactly allow-scripts, in the pane too', html.sandbox, 'allow-scripts')
    check('the pane never grants same-origin',
        String(html.sandbox).includes('allow-same-origin'), false)
    check('the csp went in with the document', html.csp, true)
    check('and it still blocks the network', html.connectSrc, true)
    check('the page is on an opaque origin', html.probe.origin, 'null')
    check('the page cannot reach the host document',
        String(html.probe.parent).startsWith('blocked:'), true)
    check('the page has no require()', html.probe.hasRequire, false)
    check('the page has no process', html.probe.hasProcess, false)
    check('the host cannot read into the frame', html.reach, 'SecurityError')
    check('window.__data arrived intact', html.probe.data, '{"step":{"hello":"pane"}}')
    check('the network is refused', html.net, 'blocked')
    // The one thing the pane relaxes: 100000px is still refused, but the
    // ceiling is the pane's rather than the card's 320.
    check('a page may be tall here, within reason', html.height, '4000px')

    // ── nothing loops ────────────────────────────────────────────────────────
    console.log('\n── the pane sits still ──')
    const idle = await deadline(evaluate(`
        const { pane, paneEl } = window.__P
        // Back to the field list, which is the case that froze the settings
        // page: groups and actions, both iterated.
        pane.model = Object.assign({}, pane.model, {
            key: 'pane-idle:' + Date.now(), loading: false, preview: ${RICH_PREVIEW},
        })
        // A getter the template reads on every pass. Shadowing it on the
        // instance is what makes this a count of *this component's* checks,
        // rather than of anything the rest of the window happens to do.
        let passes = 0
        Object.defineProperty(pane, 'busy', {
            configurable: true,
            get () { passes++; return this.model.loading },
        })
        window.ng.applyChanges(pane)
        const afterOnePass = passes
        await new Promise(r => setTimeout(r, 2500))
        const idlePasses = passes - afterOnePass
        delete pane.busy
        return {
            afterOnePass,
            idlePasses,
            // Still answering, still rendering.
            alive: document.querySelectorAll('*').length > 0,
            options: paneEl.querySelectorAll('.option').length,
        }
    `), 20000, 'idle')

    check('one pass is one pass', idle.afterOnePass >= 1, true)
    // The freeze this guards against is thousands of passes a second, for ever.
    check('an idle pane is not re-checked in a loop', idle.idlePasses < 30, true)
    check('and it is still rendered', idle.options, 2)
    note(`change-detection passes over 2.5s idle: ${idle.idlePasses}`)

    // Liveness, the way integrationsFreeze.cdp.js asks it: a wedged renderer
    // answers nothing, and a count read out of one is worth nothing.
    for (let i = 0; i < 2; i++) {
        await new Promise(r => setTimeout(r, 800))
        await deadline(evaluate('return document.querySelectorAll("*").length'), 2000, 'ping')
    }
    check('the renderer answered every ping with the pane open', true, true)

    // ── tooltips, suppressed and restored ────────────────────────────────────
    console.log('\n── hover cards while a pane is open ──')
    const suppression = await deadline(evaluate(`
        const { dec, state, xterm, core } = window.__P
        const config = dec.config
        window.__P.hadSuppression = config.store.linkTooltip.hideTooltipsWithPane
        // Written again rather than re-used: opening the pane halved the
        // terminal's width, so the line the first block found has reflowed and
        // its ranges are stale.
        xterm.write('\\r\\nsee https://example.com/pane-test done\\r\\n')
        await new Promise(r => setTimeout(r, 500))
        const ours = core._linkProviderService.linkProviders[1]
        const buffer = xterm.buffer.active
        let row = -1
        for (let i = buffer.length - 1; i >= 0; i--) {
            const line = buffer.getLine(i)
            if (line && line.translateToString(true).includes('pane-test')) { row = i; break }
        }
        if (row === -1) { throw new Error('the link text is not in the buffer') }
        const links = await new Promise(resolve => ours.provideLinks(row + 1, resolve))
        const link = (links || []).find(l => l.text.includes('pane-test'))
        if (!link) { throw new Error('the link was not detected after the split') }

        async function hover () {
            // A person moves away and back; the card is deliberately never
            // rebuilt while it is up, so a second case would otherwise measure
            // the first one's answer.
            dec.hide(state)
            await new Promise(r => setTimeout(r, 100))
            link.hover()
            await new Promise(r => setTimeout(r, 900))
            return {
                shown: state.host.style.display !== 'none',
                key: state.shownKey,
            }
        }

        config.store.linkTooltip.hideTooltipsWithPane = true
        await config.save()
        const on = await hover()
        const suppressedWhileOpen = dec.panes.tooltipsSuppressed()

        config.store.linkTooltip.hideTooltipsWithPane = false
        await config.save()
        const off = await hover()

        return { on, off, suppressedWhileOpen, openCount: dec.panes.openCount }
    `), 25000, 'suppression')

    check('the setting alone is not enough — a pane must be open',
        suppression.openCount > 0 && suppression.suppressedWhileOpen, true)
    check('no card is shown while a pane is open', suppression.on.shown, false)
    check('and nothing was even resolved for it', suppression.on.key, '')
    check('with the switch off the card comes back', suppression.off.shown, true)

    // ── closing puts everything back ─────────────────────────────────────────
    console.log('\n── closing the pane ──')
    const closed = await deadline(evaluate(`
        const { dec, state, pane } = window.__P
        const config = dec.config
        config.store.linkTooltip.hideTooltipsWithPane = true
        await config.save()
        pane.close()
        await new Promise(r => setTimeout(r, 800))
        const stillThere = !!document.querySelector('link-preview-tab')
        const suppressed = dec.panes.tooltipsSuppressed()
        // Put the profile back the way it was found.
        config.store.linkTooltip.hideTooltipsWithPane = window.__P.hadSuppression ?? false
        await config.save()
        dec.hide(state)
        return {
            stillThere,
            openCount: dec.panes.openCount,
            suppressed,
            restored: config.store.linkTooltip.hideTooltipsWithPane,
        }
    `), 20000, 'close')

    check('the pane is gone', closed.stillThere, false)
    check('the service forgot it', closed.openCount, 0)
    check('and with no pane open, nothing is suppressed', closed.suppressed, false)
    note(`hideTooltipsWithPane restored to ${closed.restored}`)

    close()
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
}).finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed) {
        process.exitCode = 1
    }
    closeAll()
})
