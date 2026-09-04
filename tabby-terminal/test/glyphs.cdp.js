// Measures stale glyphs: pixels the renderer left on screen that the buffer
// does not account for.
//
//   node scripts/dev/launch-hidden.mjs --frontend xterm --port 9238 &
//   CDP_PORT=9238 node tabby-terminal/test/glyphs.cdp.js
//
// The oracle is a forced full repaint. Snapshot the renderer's own canvases,
// repaint every row from the buffer without touching the buffer, snapshot
// again: any pixel that moved was stale. The buffer is serialized on both
// sides, so a run that changed content is thrown away rather than reported.
const { connect } = require('./cdp')

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

const SETUP = `
    const cmp = ${ROOT}
    const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const tab = all.find(t => t.frontend && t.frontend.xterm)
    if (!tab) { throw new Error('no terminal tab with an xterm') }
    const parent = cmp.app.tabs.find(t => t.getAllTabs && t.getAllTabs().includes(tab)) || tab
    cmp.app.selectTab(parent)
    await new Promise(r => setTimeout(r, 500))
    window.ng.applyChanges(cmp)
    window.__T = { root: cmp, tab, frontend: tab.frontend, xterm: tab.frontend.xterm, core: tab.frontend.xterm._core }
`

// Snapshot every canvas the renderer owns, composited in DOM order over an
// opaque ground. This reads the renderer's own output, so it does not depend
// on the window being composited by the OS.
const SNAPSHOT_FN = `
    window.__snap = (key) => {
        const { core } = window.__T
        const canvases = [...core.screenElement.querySelectorAll('canvas')]
        if (!canvases.length) { throw new Error('no canvases: the DOM renderer is not measurable this way') }
        const w = Math.max(...canvases.map(c => c.width))
        const h = Math.max(...canvases.map(c => c.height))
        const off = new OffscreenCanvas(w, h)
        const ctx = off.getContext('2d', { willReadFrequently: true })
        ctx.fillStyle = '#000000'
        ctx.fillRect(0, 0, w, h)
        for (const c of canvases) {
            if (c.width && c.height) { ctx.drawImage(c, 0, 0) }
        }
        window['__snap_' + key] = { w, h, data: ctx.getImageData(0, 0, w, h).data }
        return { w, h, canvases: canvases.length }
    }
`

function pct (n, d) { return d ? Math.round(n / d * 1000) / 10 : 0 }

async function wheel (send, x, y, deltaY, times) {
    for (let i = 0; i < times; i++) {
        await send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x, y, deltaX: 0, deltaY,
            pointerType: 'mouse', button: 'none', clickCount: 0, modifiers: 0,
        })
    }
}

async function main () {
    const { evaluate, send, close } = await connect()

    const env = await evaluate(`
        ${SETUP}
        ${SNAPSHOT_FN}
        const { frontend, xterm, core } = window.__T
        const rs = core._renderService
        const renderer = rs && (rs._renderer && rs._renderer.value ? rs._renderer.value : rs._renderer)
        let gl = 'n/a'
        try {
            const canvas = core.screenElement.querySelector('canvas')
            const c = canvas.getContext('webgl2') || canvas.getContext('webgl')
            const dbg = c && c.getExtension('WEBGL_debug_renderer_info')
            if (c && dbg) { gl = c.getParameter(dbg.UNMASKED_RENDERER_WEBGL) }
        } catch (e) { gl = 'error: ' + e.message }
        let version = 'n/a'
        try { version = require('@xterm/xterm/package.json').version } catch (e) { /* bundled */ }
        return {
            configuredFrontend: window.__T.root.config.store.terminal.frontend,
            frontendClass: frontend.constructor.name,
            rendererClass: (renderer && renderer.constructor && renderer.constructor.name) || 'unknown',
            webglAddon: !!frontend.webGLAddon,
            canvasAddon: !!frontend.canvasAddon,
            xtermVersion: version,
            cols: xterm.cols, rows: xterm.rows,
            scrollback: xterm.options.scrollback,
            gl,
        }
    `)
    console.log('')
    console.log('-- environment --')
    for (const [k, v] of Object.entries(env)) { console.log('  ' + k.padEnd(20) + ' ' + v) }

    // WebGL discards its drawing buffer after compositing unless asked not to,
    // so re-attach the addon with preserveDrawingBuffer to make it readable.
    if (env.webglAddon) {
        const re = await evaluate(`
            const { frontend, xterm } = window.__T
            const Addon = frontend.webGLAddon.constructor
            frontend.webGLAddon.dispose()
            const addon = new Addon(true)
            xterm.loadAddon(addon)
            frontend.webGLAddon = addon
            await new Promise(r => setTimeout(r, 400))
            const rs = window.__T.core._renderService
            const renderer = rs._renderer && rs._renderer.value ? rs._renderer.value : rs._renderer
            return renderer && renderer.constructor.name
        `)
        console.log('  re-attached WebGL with preserveDrawingBuffer -> ' + re)
    }

    // Record what the render service was asked to repaint and how often the
    // buffer scrolled, so a stale region can be attributed rather than guessed.
    await evaluate(`
        const { core, xterm } = window.__T
        const rs = core._renderService
        window.__log = { refresh: 0, widest: 0, scrolls: 0 }
        // Read the counter through the global on every call. A wrapper that
        // closed over the object would keep counting into the previous run's
        // log, and silently report zero for this one.
        if (!rs.__wrapped) {
            const original = rs.refreshRows.bind(rs)
            rs.refreshRows = (start, end, redrawOnly) => {
                window.__log.refresh++
                window.__log.widest = Math.max(window.__log.widest, end - start + 1)
                return original(start, end, redrawOnly)
            }
            rs.__wrapped = true
        }
        if (!window.__scrollHooked) {
            xterm.onScroll(() => { window.__log.scrolls++ })
            window.__scrollHooked = true
        }
        // Start from an empty buffer so a run never inherits the last one's
        // scroll position or content.
        xterm.reset()
        await new Promise(r => setTimeout(r, 300))
        return true
    `)

    // Output shaped like a full-screen TUI: a fixed-column gutter redrawn every
    // frame, erase-to-end-of-line rather than erase-line, cursor-up rewrites,
    // synchronized-update blocks, and mixed cell widths.
    await evaluate(`
        const WORDS = ['tenant','binding','guard','denies','allows','session','transcript','resolve',
                       'associations','provision','endpoint','payload','retry','stage','commit','render',
                       '\\u8857\\u9053','\\u30b7\\u30b9\\u30c6\\u30e0','\\u2747\\ufe0f','\\u251c\\u2500','\\u2514\\u2500','\\u2502']
        window.__gen = {
            seed: 1234567,
            rnd () { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x7fffffff },
            pick (a) { return a[Math.floor(this.rnd() * a.length)] },
            stop: false,
            line (n) {
                let s = ''
                const len = 3 + Math.floor(this.rnd() * 14)
                for (let i = 0; i < len; i++) { s += this.pick(WORDS) + ' ' }
                return '\\x1b[' + (31 + Math.floor(this.rnd() * 6)) + 'm' + String(n).padStart(5) + '\\x1b[0m \\u2502 ' + s
            },
            async staticLines (frontend, count) {
                for (let i = 0; i < count; i++) { await frontend.write(this.line(i) + '\\r\\n') }
            },
            // A block of rows rewritten in place: move up, erase to end of line
            // (not the whole line), write shorter or longer content. Partial
            // erase is where a damage-tracking renderer leaves a tail behind.
            async frame (frontend, height, sync) {
                let out = sync ? '\\x1b[?2026h' : ''
                out += '\\x1b[' + height + 'A'
                for (let r = 0; r < height; r++) {
                    const width = 2 + Math.floor(this.rnd() * 60)
                    let body = ''
                    while (body.length < width) { body += this.pick(WORDS) + ' ' }
                    out += '\\r\\x1b[K' + this.pick(['\\u280b','\\u2819','\\u2839','\\u2838','\\u283c']) + ' \\u2502 ' + body.slice(0, width) + '\\r\\n'
                }
                if (sync) { out += '\\x1b[?2026l' }
                await frontend.write(out)
            },
        }
        return true
    `)

    console.log('')
    console.log('-- phase 1: fill scrollback past capacity --')
    const filled = await evaluate(`
        const { frontend, xterm } = window.__T
        xterm.write('\\x1b[?25l')
        await window.__gen.staticLines(frontend, 1400)
        await new Promise(r => setTimeout(r, 600))
        const b = xterm.buffer.active
        return { length: b.length, baseY: b.baseY, viewportY: b.viewportY, atCapacity: b.length >= xterm.options.scrollback }
    `)
    console.log('  buffer ' + filled.length + ' lines, baseY ' + filled.baseY + ', at capacity: ' + filled.atCapacity)

    console.log('')
    console.log('-- phase 2: scroll up, then keep producing output --')
    const rect = await evaluate(`
        const r = window.__T.core.screenElement.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height }
    `)
    await wheel(send, rect.x, rect.y, -120, 12)
    await evaluate('await new Promise(r => setTimeout(r, 300)); return true')
    const afterScroll = await evaluate(`
        const b = window.__T.xterm.buffer.active
        return { viewportY: b.viewportY, baseY: b.baseY, pinned: window.__T.frontend.pinnedToBottom }
    `)
    console.log('  viewportY ' + afterScroll.viewportY + ' of baseY ' + afterScroll.baseY + ', pinned=' + afterScroll.pinned)
    if (afterScroll.viewportY >= afterScroll.baseY) {
        console.log('  !! the wheel did not move the viewport - this run proves nothing')
    }

    // Output continues while the view is held still. With the scrollback full,
    // every new line evicts the oldest, so the rows on screen shift.
    const running = evaluate(`
        const { frontend } = window.__T
        const gen = window.__gen
        gen.stop = false
        for (let i = 0; i < 50 && !gen.stop; i++) {
            await gen.staticLines(frontend, 3)
            for (let f = 0; f < 4; f++) { await gen.frame(frontend, 8, f % 2 === 0) }
            await new Promise(r => setTimeout(r, 40))
        }
        return { done: true }
    `)
    for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 300))
        await wheel(send, rect.x, rect.y, i % 4 === 3 ? 120 : -120, 3)
    }
    await running

    // Phase 3: resize while output flows. A pane that was wider a moment ago is
    // the shape the reported artifacts have - stray glyphs sitting in a region
    // that no longer holds text.
    if (!process.env.SKIP_RESIZE) {
        console.log('')
        console.log('-- phase 3: resize while output flows --')
        const base = await evaluate(`
            return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
        `)
        const resizing = evaluate(`
            const { frontend } = window.__T
            const gen = window.__gen
            for (let i = 0; i < 40; i++) {
                await gen.staticLines(frontend, 2)
                await gen.frame(frontend, 8, i % 2 === 0)
                await new Promise(r => setTimeout(r, 30))
            }
            return { done: true }
        `)
        for (const width of [1500, 2100, 1200, 1900, 1000, base.w]) {
            await send('Emulation.setDeviceMetricsOverride', {
                width, height: base.h, deviceScaleFactor: base.dpr, mobile: false,
            })
            await new Promise(r => setTimeout(r, 220))
        }
        await send('Emulation.clearDeviceMetricsOverride')
        await resizing
        const sized = await evaluate(`
            await new Promise(r => setTimeout(r, 500))
            const { xterm } = window.__T
            return { cols: xterm.cols, rows: xterm.rows }
        `)
        console.log('  back to ' + sized.cols + 'x' + sized.rows)
    }

    console.log('')
    console.log('-- settle, snapshot, force a full repaint, snapshot again --')
    const before = await evaluate(`
        const { xterm, frontend } = window.__T
        await new Promise(res => {
            let timer
            const d = xterm.onRender(() => { clearTimeout(timer); timer = setTimeout(finish, 400) })
            function finish () { d.dispose(); res() }
            timer = setTimeout(finish, 400)
        })
        const b = xterm.buffer.active
        window.__bufferBefore = frontend.serializeAddon.serialize({ excludeAltBuffer: true, excludeModes: true, scrollback: 0 })
        const snap = window.__snap('a')
        return {
            snap,
            viewportY: b.viewportY, baseY: b.baseY,
            refreshCalls: window.__log.refresh,
            widestRefresh: window.__log.widest,
            scrolls: window.__log.scrolls,
        }
    `)
    console.log('  canvas ' + before.snap.w + 'x' + before.snap.h + ' (' + before.snap.canvases + ' layers), viewportY ' + before.viewportY + '/' + before.baseY)
    console.log('  refreshRows calls: ' + before.refreshCalls + ' (widest span ' + before.widestRefresh + ' rows), buffer scrolls: ' + before.scrolls)

    const result = await evaluate(`
        const { xterm, core, frontend } = window.__T
        // The same repair a tab switch performs: drop renderer state and
        // repaint every row from the buffer. Nothing here writes to the buffer.
        xterm.write('\\x1b[?2026l')
        await new Promise(r => setTimeout(r, 60))
        core._renderService.clear()
        if (frontend.webGLAddon) { frontend.webGLAddon.clearTextureAtlas() }
        if (frontend.canvasAddon) { frontend.canvasAddon.clearTextureAtlas() }
        xterm.refresh(0, xterm.rows - 1)
        core._renderService._renderRows(0, xterm.rows - 1)
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))

        window.__snap('b')
        const bufferAfter = frontend.serializeAddon.serialize({ excludeAltBuffer: true, excludeModes: true, scrollback: 0 })
        const A = window.__snap_a, B = window.__snap_b
        if (A.w !== B.w || A.h !== B.h) { return { error: 'canvas resized between snapshots' } }

        const cell = core._renderService.dimensions.device.cell
        const cols = xterm.cols, rows = xterm.rows
        const dirtyCellSet = new Set()
        let dirtyPixels = 0
        for (let y = 0; y < A.h; y++) {
            for (let x = 0; x < A.w; x++) {
                const i = (y * A.w + x) * 4
                if (A.data[i] !== B.data[i] || A.data[i+1] !== B.data[i+1] || A.data[i+2] !== B.data[i+2] || A.data[i+3] !== B.data[i+3]) {
                    dirtyPixels++
                    dirtyCellSet.add(Math.floor(y / cell.height) * cols + Math.floor(x / cell.width))
                }
            }
        }
        const dirtyRows = new Set(), dirtyCols = new Set()
        for (const c of dirtyCellSet) { dirtyRows.add(Math.floor(c / cols)); dirtyCols.add(c % cols) }
        return {
            bufferUnchanged: bufferAfter === window.__bufferBefore,
            totalPixels: A.w * A.h,
            dirtyPixels,
            dirtyCells: dirtyCellSet.size,
            totalCells: cols * rows,
            dirtyRows: [...dirtyRows].sort((a, b) => a - b),
            dirtyCols: [...dirtyCols].sort((a, b) => a - b),
            rows, cols,
        }
    `)

    console.log('')
    console.log('-- result --')
    if (result.error) {
        console.log('  VOID: ' + result.error)
        close()
        process.exit(2)
    }
    if (!result.bufferUnchanged) {
        console.log('  VOID: the forced repaint changed buffer content, so the oracle is not clean')
        close()
        process.exit(2)
    }
    console.log('  dirty pixels  ' + result.dirtyPixels + ' of ' + result.totalPixels + ' (' + pct(result.dirtyPixels, result.totalPixels) + '%)')
    console.log('  dirty cells   ' + result.dirtyCells + ' of ' + result.totalCells + ' (' + pct(result.dirtyCells, result.totalCells) + '%)')
    console.log('  rows affected ' + result.dirtyRows.length + ' of ' + result.rows + (result.dirtyRows.length ? ': ' + result.dirtyRows.slice(0, 24).join(',') : ''))
    console.log('  cols affected ' + result.dirtyCols.length + ' of ' + result.cols + (result.dirtyCols.length ? ': ' + result.dirtyCols.slice(0, 24).join(',') : ''))
    console.log('')
    console.log(JSON.stringify({
        result: 'glyphs',
        frontend: env.configuredFrontend,
        renderer: env.rendererClass,
        xterm: env.xtermVersion,
        dirtyPixels: result.dirtyPixels,
        dirtyCells: result.dirtyCells,
        rowsAffected: result.dirtyRows.length,
        refreshCalls: before.refreshCalls,
        scrolls: before.scrolls,
    }))
    close()
    process.exit(result.dirtyCells > 0 ? 1 : 0)
}

main().catch(e => { console.error('ERROR', e.message); process.exit(3) })
