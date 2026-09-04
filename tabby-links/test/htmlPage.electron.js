// Checks that a manifest's `html` page measures and reports its own height.
//
// This cannot be done in the hidden dev build: Chromium throttles rendering for
// a cross-origin subframe that is never visible, so the sandboxed frame's
// document is never laid out and every measurement inside it reads 0. The frame
// has to be in a window that actually composites.
//
// So the page is loaded in a standalone window of its own, shown *without
// focus* and positioned off-screen — it never appears in front of anything.
//
//   ./node_modules/electron/dist/electron.exe tabby-links/test/htmlPage.electron.js
const { app, BrowserWindow } = require('electron')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')
const manifest = require(path.join(REPO, 'tabby-links/src/integrations/stith.json'))

// From the source, not the bundle: `dist/index.js` needs Angular's runtime to
// even be required, and `htmlHost.ts` imports nothing at all.
const ts = require(path.join(REPO, 'node_modules/typescript'))
const Module = require('module')
Module._extensions['.ts'] = function (module, filename) {
    const source = require('fs').readFileSync(filename, 'utf8')
    module._compile(ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText, filename)
}
const { buildHtmlDocument, HTML_SANDBOX } = require(path.join(REPO, 'tabby-links/src/htmlHost.ts'))

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

const AGENT = {
    name: 'A session with a name long enough to wrap onto a second line',
    status: 'active',
    projectName: 'tabby',
    machine: 'nextgen',
    gitBranch: 'local',
    lastActivityAt: new Date().toISOString(),
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({
        width: 420,
        height: 400,
        x: -3000,
        y: -3000,
        show: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
    })
    // Shown so the compositor runs — but never focused, and off-screen.
    win.showInactive()

    // Console from the sandboxed frame surfaces here; nothing else can see it,
    // so a page that throws would otherwise fail silently. Electron's own
    // CSP advisory is about this harness window, not the frame, so it is
    // filtered out.
    const noise = []
    win.webContents.on('console-message', event => {
        const text = String(event?.message ?? '')
        if (text && !text.includes('Electron Security Warning')) {
            noise.push(text)
        }
    })
    process.on('exit', () => {
        if (noise.length) {
            console.log('\n  frame console:')
            for (const line of noise.slice(0, 10)) { console.log(`    ${line}`) }
        }
    })

    // A probe appended to the page, so a failure to report says *why*.
    const probe = '<script>setTimeout(function(){parent.postMessage({diag:{'
        + 'shim:typeof ((window.chrome||{}).webview||{}).postMessage,'
        + 'bodyScroll:document.body.scrollHeight,'
        + 'ro:typeof ResizeObserver,'
        + 'kids:document.body.children.length,'
        + 'text:document.body.innerText.slice(0,60)'
        + '}},"*")},600)</script>'
    const page = process.env.DIAG ? manifest.html.replace('</body>', probe + '</body>') : manifest.html
    const srcdoc = buildHtmlDocument(page, { agent: AGENT }, 'stith://session/abc')

    // A real file, not a data: URL — a data: document is itself opaque-origin
    // and the harness script does not reliably run in one.
    const harness = path.join(app.getPath('temp'), `tabby-links-htmlpage-${process.pid}.html`)
    require('fs').writeFileSync(harness, `<!doctype html><html><body style="margin:0">
        <iframe id="f" sandbox="${HTML_SANDBOX}" style="width:300px;height:120px;border:0"></iframe>
        <script>
            window.__msgs = []
            addEventListener('message', function (e) { window.__msgs.push(e.data) })
            // Escaped the same way the product escapes its own injections: the
            // string holds the page's own closing script tag, which would
            // otherwise end the element it is written inside.
            document.getElementById('f').srcdoc = ${JSON.stringify(srcdoc).replace(/</g, '\\u003c')}
        </script></body></html>`)
    await win.loadFile(harness)

    await new Promise(r => setTimeout(r, 1500))

    const result = await win.webContents.executeJavaScript(`({
        msgs: window.__msgs || [],
        listener: typeof window.__msgs,
        frameSrcdocLen: (document.getElementById('f') || {}).srcdoc ? document.getElementById('f').srcdoc.length : -1,
        frameRect: (function () {
            const f = document.getElementById('f')
            if (!f) { return 'no frame' }
            const r = f.getBoundingClientRect()
            return Math.round(r.width) + 'x' + Math.round(r.height)
        })(),
    })`)
    require('fs').unlinkSync(harness)
    console.log('\n── a manifest page measuring itself ──')

    if (process.env.DIAG) {
        console.log('  diag:', JSON.stringify(result, null, 2))
    }
    const heights = result.msgs.filter(m => m && typeof m.height === 'number').map(m => m.height)
    check('the page reported a height', heights.length > 0, true)
    if (heights.length) {
        const h = heights[heights.length - 1]
        console.log(`       reported ${h}px for ${Object.keys(AGENT).length} fields`)
        // The real assertion: it measured its content, not the frame it was
        // given. Anything equal to the 120px default would mean it measured the
        // viewport — which is what `documentElement.scrollHeight` does.
        check('it measured its content, not the frame', h !== 120, true)
        check('the reported height is plausible', h > 20 && h < 400, true)
    }

    win.destroy()
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed ? 1 : 0)
}).catch(err => {
    console.error(err)
    app.exit(1)
})
