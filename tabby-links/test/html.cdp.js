// Verifies the `html` card representation inside a running renderer.
//
// The assertions that matter here are the ones no unit test can make: that the
// frame really is on an opaque origin, that it really cannot reach Node, and
// that the CSP really does refuse the network. Launch the dev build hidden
// first — see the package README / root CLAUDE.md — then:
//
//   node test/html.cdp.js
const { connect } = require('./cdp')

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

async function main () {
    const cdp = await connect()

    const setup = await cdp.evaluate(`
        const roots = document.querySelectorAll('link-hover-card')
        // The frame's own window is unreachable from here — that is the point —
        // so the page reports what it sees the only way it can, by posting a
        // message. The card's handler ignores anything that is not a height or
        // an open; this collector sees everything.
        window.__probeLog = []
        if (!window.__probeCollector) {
            window.__probeCollector = true
            window.addEventListener('message', e => {
                if (e.data && e.data.probe) { window.__probeLog.push(e.data.probe) }
            })
        }
        return { cards: roots.length }
    `)
    console.log('\\n── html host ──')
    console.log(`  (cards mounted: ${setup.cards})`)

    // Drive the component directly: write a preview carrying an html document
    // and let the component's own sync path build the frame.
    const built = await cdp.evaluate(`
        const host = document.querySelector('link-hover-card')
        if (!host) { return { error: 'no card component in the DOM' } }
        const cmp = window.ng.getComponent(host)
        cmp.model = Object.assign(cmp.model, {
            key: 'test:' + Date.now(),
            allowHtml: true,
            loading: false,
            text: 'stith://session/abc',
            target: 'stith://session/abc',
            preview: {
                integrationId: 'test',
                integrationName: 'Test',
                icon: '',
                fields: [],
                error: '',
                link: '',
                data: { step: { hello: 'world' } },
                html: [
                    '<!doctype html><html><head><meta charset="utf-8"></head><body>',
                    '<div id="out"></div><a id="lnk" href="https://example.test/x">go</a>',
                    '<script>',
                    'var p = {};',
                    'p.origin = String(window.origin);',
                    'try { p.parent = !!window.parent.document }',
                    'catch (e) { p.parent = "blocked:" + e.name }',
                    'p.hasRequire = typeof require !== "undefined";',
                    'p.hasProcess = typeof process !== "undefined";',
                    'p.data = JSON.stringify(window.__data);',
                    'p.uri = String(window.__uri);',
                    'p.shim = typeof chrome.webview.postMessage;',
                    'p.rendered = true;',
                    'document.getElementById("out").textContent = "rendered";',
                    'window.__fetchErr = "";',
                    'try { fetch("https://example.test/beacon").then(',
                    '  function(){ parent.postMessage({ probe: { net: "ALLOWED" } }, "*") },',
                    '  function(e){ parent.postMessage({ probe: { net: "blocked" } }, "*") }) }',
                    'catch (e) { parent.postMessage({ probe: { net: "blocked" } }, "*") }',
                    'parent.postMessage({ probe: p }, "*");',
                    'chrome.webview.postMessage({ height: 5000 });',
                    '</script></body></html>',
                ].join(''),
            },
        })
        window.ng.applyChanges(cmp)
        cmp.refresh()
        await new Promise(r => setTimeout(r, 400))
        const frame = host.querySelector('iframe.preview-html')
        return {
            present: !!frame,
            sandbox: frame ? frame.getAttribute('sandbox') : null,
            height: frame ? frame.style.height : null,
            hasSrcdoc: frame ? frame.srcdoc.length > 0 : false,
            cspInSrcdoc: frame ? frame.srcdoc.includes('Content-Security-Policy') : false,
        }
    `)

    if (built.error) {
        console.log(`  FAIL ${built.error}`)
        process.exit(1)
    }

    check('the frame is created', built.present, true)
    // The single most important assertion in this file.
    check('sandbox is exactly allow-scripts', built.sandbox, 'allow-scripts')
    check('sandbox does not grant same-origin',
        String(built.sandbox).includes('allow-same-origin'), false)
    check('a document was written', built.hasSrcdoc, true)
    check('the csp went in with it', built.cspInSrcdoc, true)
    // 5000 was asked for; 320 is the ceiling.
    check('an outsized height request is clamped', built.height, '320px')

    // The isolation, proved from the host's side: reaching into the frame must
    // throw. If this ever stops throwing, the sandbox has been broken.
    const reach = await cdp.evaluate(`
        const frame = document.querySelector('link-hover-card iframe.preview-html')
        try {
            void frame.contentWindow.document.body
            return 'READABLE'
        } catch (e) {
            return e.name
        }
    `)
    check('the host cannot read into the frame', reach, 'SecurityError')

    // And from the page's side, over the only channel it has.
    await cdp.evaluate('await new Promise(r => setTimeout(r, 600)); return 1')
    const log = await cdp.evaluate('return window.__probeLog')
    const probe = log.find(p => p.rendered) || {}
    const net = log.find(p => p.net) || {}

    check('the page ran', probe.rendered, true)
    check('window.__data arrived intact', probe.data, '{"step":{"hello":"world"}}')
    check('window.__uri arrived', probe.uri, 'stith://session/abc')
    check('the chrome.webview shim is callable', probe.shim, 'function')
    check('the frame is on an opaque origin', probe.origin, 'null')
    check('the page cannot reach the host document',
        String(probe.parent).startsWith('blocked:'), true)
    check('the page has no require()', probe.hasRequire, false)
    check('the page has no process', probe.hasProcess, false)
    check('the csp refuses the network', net.net, 'blocked')

    // Re-rendering the same card must not reload the frame — that is what would
    // strobe the card and restart its script during terminal output.
    const before = log.filter(p => p.rendered).length
    const stable = await cdp.evaluate(`
        const host = document.querySelector('link-hover-card')
        const cmp = window.ng.getComponent(host)
        for (let i = 0; i < 5; i++) { cmp.refresh() }
        await new Promise(r => setTimeout(r, 400))
        return window.__probeLog.filter(p => p.rendered).length
    `)
    check('re-rendering does not reload the page', stable, before)

    // The kill switch removes the frame entirely rather than merely hiding it.
    const off = await cdp.evaluate(`
        const host = document.querySelector('link-hover-card')
        const cmp = window.ng.getComponent(host)
        cmp.model.allowHtml = false
        window.ng.applyChanges(cmp)
        cmp.refresh()
        await new Promise(r => setTimeout(r, 200))
        return {
            frame: !!host.querySelector('iframe.preview-html'),
            fields: !!host.querySelector('.preview-fields'),
        }
    `)
    check('allowHtml:false removes the frame', off.frame, false)
    check('allowHtml:false falls back to the field list', off.fields, true)

    cdp.close()
    console.log(`\\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
