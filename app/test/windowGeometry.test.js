// Every window remembers its own position and size, not one shared slot.
//
//   node app/test/windowGeometry.test.js
//
// Needs a built dev build (`yarn build`, or at least the app bundles). Three
// real launches of a hidden dev instance, ~60s in total.
//
// The dev build is electron.exe; the installed Tabby is Tabby.exe and holds
// live sessions. Nothing here ever touches it: the Tabby.exe count is taken
// before and after, only PIDs we spawned are stopped, and a drop fails the run.
// Every window opened here is opened hidden, including the second one
// (`app:new-window` takes the same `hidden` option the CLI flag sets), so a run
// never shows a window or takes focus.
//
// What is under test:
//
//   Upstream keeps one `windowBoundaries` key in `window.json` and every window
//   reads and writes it. Two windows therefore open on top of each other and
//   whichever closes last overwrites the other's place. Geometry is now keyed
//   by slot — the window ordinal, claimed lowest-free at construction — so each
//   window comes back to its own.
//
// The old placement is transcribed at the bottom of this file and run against
// the same `window.json` and the same displays, because a check that only the
// new code can fail proves nothing. It is the same device `moduleLookup.test.js`
// uses for the old module ordering, and for the same reason: `app/lib/window.ts`
// cannot be imported outside Electron.
const fs = require('fs')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..', '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const WebSocket = require(path.join(root, 'node_modules', 'ws'))

// Chosen at startup, and only after proving it is free. A debugging port that
// something else already holds is not an error Chromium reports — it just does
// not listen, and every request goes to whatever *is* there. Measured: 9251 was
// the user's own Chrome, full of logged-in tabs, and this test would have been
// evaluating JavaScript in it.
let PORT = 0

// Small enough to fit any work area this test will accept, far enough apart
// that a shared slot cannot be mistaken for two.
const A = { x: 40, y: 40, width: 900, height: 600 }
const B = { x: 320, y: 220, width: 700, height: 500 }
// Where the test moves them to, to prove the save side is per-slot too.
const A2 = { x: 96, y: 72, width: 820, height: 560 }
const B2 = { x: 420, y: 300, width: 640, height: 460 }
// A window whose title bar is 700px above the top of the screen: there is no
// way to reach it with a mouse. Upstream's check accepts it, because the rect
// still overlaps the display.
const OFFSCREEN = { x: 100, y: -700, width: 1200, height: 800 }
// Saved on a monitor that has since been unplugged — far down and to the right
// of anything this machine has.
const UNPLUGGED = { x: 7200, y: 2400, width: 1000, height: 700 }

if (process.platform !== 'win32') {
    console.log('skip  written against the Windows dev build')
    process.exit(0)
}
if (!fs.existsSync(electron) || !fs.existsSync(path.join(root, 'app', 'dist', 'main.js'))) {
    console.log('skip  no built dev build to launch')
    process.exit(0)
}

function tabbyCount () {
    try {
        return parseInt(execFileSync('powershell', [
            '-NoProfile', '-Command',
            '@(Get-Process Tabby -ErrorAction SilentlyContinue).Count',
        ], { encoding: 'utf8' }).trim(), 10)
    } catch {
        return -1
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── Launching ───────────────────────────────────────────────────────────────

const live = []

/**
 * Launch the dev build hidden, on its own profile, seeded with `windowJson`.
 *
 * `--user-data-dir` must precede the app path or Electron hands the switch to
 * the app and silently ignores it, sharing %APPDATA%\tabby with the installed
 * Tabby. NODE_PATH is scrubbed to this repo for the same reason it is
 * everywhere else here: an inherited one points at another build's plugins.
 */
function launch (label, windowJson, { fresh = true } = {}) {
    const dir = path.join(os.tmpdir(), `tabby-geometry-${label}`)
    if (fresh) {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'config.yaml'), [
            'version: 8',
            'terminal:',
            '  profile: local:cmd',
            'hotkeys:',
            '  toggle-window: []',
            'enableWelcomeTab: false',
            'enableAutomaticUpdates: false',
            'recoverTabs: false',
            'pluginBlacklist:',
            // A scratch instance must not take the global hotkey or the MCP
            // port from the Tabby the user is actually using.
            '  - mcp-server',
            '  - claude',
            '  - claude-status',
            '',
        ].join('\n'))
    }
    if (windowJson) {
        fs.writeFileSync(path.join(dir, 'window.json'), JSON.stringify(windowJson, null, '\t'))
    }

    const child = spawn(electron, [
        `--user-data-dir=${dir}`,
        `--remote-debugging-port=${PORT}`,
        'app',
        '--hidden',
        '--enable-logging=stderr',
    ], {
        cwd: root,
        env: {
            ...process.env,
            NODE_PATH: path.join(root, 'app', 'node_modules'),
            TABBY_PLUGINS: '',
            TABBY_DEV: '1',
            TABBY_CONFIG_DIRECTORY: dir,
            TABBY_DIAG: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    const log = fs.createWriteStream(path.join(dir, 'launch.log'))
    child.stdout.pipe(log)
    child.stderr.pipe(log)

    const handle = { label, dir, pid: child.pid, exit: null }
    child.on('exit', code => { handle.exit = code })
    live.push(handle)
    return handle
}

function stop (handle) {
    if (handle.exit !== null) {
        return
    }
    try {
        // By PID, never by name.
        execFileSync('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* already gone */ }
}

/**
 * Kill an instance and wait for it to be gone.
 *
 * Every launch here uses the same debugging port, so a relaunch that starts
 * while the last one is still up cannot bind it and quietly reports the *old*
 * process's targets — a whole phase measuring the wrong instance.
 */
async function shutDown (handle, timeoutMs = 20000) {
    stop(handle)
    const deadline = Date.now() + timeoutMs
    while (handle.exit === null && Date.now() < deadline) {
        await sleep(250)
    }
    // The port outlives the process by a moment.
    await sleep(1000)
    return handle.exit !== null
}

/** The diagnostics log is the only place the main process's decisions show. */
function records (handle) {
    const file = path.join(handle.dir, 'diagnostics.log')
    if (!fs.existsSync(file)) {
        return []
    }
    return fs.readFileSync(file, 'utf8').split('\n').filter(x => x.trim()).map(line => {
        try {
            return JSON.parse(line)
        } catch {
            return { kind: 'unparseable' }
        }
    })
}

/**
 * Wait for `count` records of `kind`.
 *
 * The log is written on a one-second timer — deliberately, so that reporting a
 * stall cannot itself be the stall — so a window that is up is not yet a window
 * that has said anything.
 */
async function waitForRecords (handle, kind, count, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    let found = []
    while (Date.now() < deadline) {
        found = records(handle).filter(r => r.kind === kind)
        if (found.length >= count) {
            return found
        }
        await sleep(400)
    }
    return found
}

const stored = handle => JSON.parse(fs.readFileSync(path.join(handle.dir, 'window.json'), 'utf8'))

// ── CDP ─────────────────────────────────────────────────────────────────────

function get (urlPath) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, res => {
            let body = ''
            res.on('data', c => body += c)
            res.on('end', () => resolve(JSON.parse(body)))
        }).on('error', reject)
    })
}

function free (port) {
    return new Promise(resolve => {
        const server = net.createServer()
        server.once('error', () => resolve(false))
        server.once('listening', () => server.close(() => resolve(true)))
        server.listen(port, '127.0.0.1')
    })
}

async function pickPort () {
    for (let port = 9260; port < 9300; port++) {
        if (await free(port)) {
            return port
        }
    }
    throw new Error('no free debugging port in 9260-9299')
}

async function pages (count, timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            // Whose debugger is this? A port that was free before the launch can
            // still be answered by something else by the time we ask.
            const version = await get('/json/version')
            if (!String(version['User-Agent'] ?? '').includes('Electron')) {
                throw new Error(`port ${PORT} is not an Electron debugger: ${version.Browser}`)
            }
            const found = (await get('/json/list')).filter(t => t.type === 'page' && t.url.includes('index.html'))
            if (found.length >= count) {
                return found
            }
        } catch (err) {
            if (err.message?.includes('not an Electron debugger')) {
                throw err
            }
            /* the port is not up yet */
        }
        await sleep(500)
    }
    throw new Error(`only saw fewer than ${count} renderer(s) after ${timeoutMs}ms`)
}

async function attach (target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 32 * 1024 * 1024 })
    await new Promise((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
    })
    let id = 0
    const pending = new Map()
    ws.on('message', data => {
        const message = JSON.parse(data.toString())
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message)
            pending.delete(message.id)
        }
    })
    // Half of this test closes windows, which kills the target mid-call. A
    // pending CDP request that is never answered and never rejected is how
    // integrationsFreeze.cdp.js came to hang forever; both exits are covered.
    ws.on('close', () => {
        for (const resolve of pending.values()) {
            resolve({ gone: true })
        }
        pending.clear()
    })
    const send = (method, params = {}) => new Promise(resolve => {
        const messageId = ++id
        pending.set(messageId, resolve)
        const timer = setTimeout(() => {
            pending.delete(messageId)
            resolve({ timedOut: true })
        }, 20000)
        ws.send(JSON.stringify({ id: messageId, method, params }), () => { /* may already be closed */ })
        pending.set(messageId, message => {
            clearTimeout(timer)
            resolve(message)
        })
    })
    const evaluate = async expression => {
        const result = await send('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
        })
        if (result.result?.exceptionDetails) {
            throw new Error(result.result.exceptionDetails.exception?.description
                ?? JSON.stringify(result.result.exceptionDetails))
        }
        return result.result?.result?.value
    }
    return { evaluate, close: () => ws.close() }
}

/** Every renderer, paired with the bounds of the window it is drawing into. */
async function windows (count) {
    const targets = await pages(count)
    const out = []
    for (const target of targets.slice(0, count)) {
        const cdp = await attach(target)
        const bounds = await cdp.evaluate(
            `return require('@electron/remote').getCurrentWindow().getBounds()`)
        out.push({ ...cdp, bounds })
    }
    return out.sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
}

// ── Checks ──────────────────────────────────────────────────────────────────

let failed = 0

function check (ok, message) {
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${message}`)
    if (!ok) {
        failed++
    }
}

const rect = b => b && `${b.width}x${b.height}+${b.x}+${b.y}`
const same = (a, b) => !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/** A window is reachable if a strip of its title bar is inside some work area. */
function reachable (b, displays) {
    return displays.some(d => {
        const a = d.workArea
        const overlap = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x)
        return overlap >= 120 && b.y >= a.y && b.y <= a.y + a.height - 32
    })
}

// ── The old placement, transcribed ──────────────────────────────────────────
//
// `app/lib/window.ts` before this change, verbatim apart from the names: one
// `windowBoundaries` key for every window, and an off-screen check that only
// fires when the rect misses the nearest display entirely.
const OLD_PLACEMENT = `
    const screen = require('@electron/remote').screen
    const store = JSON.parse(arguments0)
    const bwOptions = { width: 1920, height: 1080 }
    const windowBounds = store.windowBoundaries
    const maximized = store.maximized
    if (windowBounds) {
        Object.assign(bwOptions, windowBounds)
        const closestDisplay = screen.getDisplayNearestPoint({ x: windowBounds.x, y: windowBounds.y })
        const [left1, top1, right1, bottom1] = [windowBounds.x, windowBounds.y, windowBounds.x + windowBounds.width, windowBounds.y + windowBounds.height]
        const [left2, top2, right2, bottom2] = [closestDisplay.bounds.x, closestDisplay.bounds.y, closestDisplay.bounds.x + closestDisplay.bounds.width, closestDisplay.bounds.y + closestDisplay.bounds.height]
        if ((left2 > right1 || right2 < left1 || top2 > bottom1 || bottom2 < top1) && !maximized) {
            bwOptions.x = closestDisplay.bounds.width / 2 - bwOptions.width / 2
            bwOptions.y = closestDisplay.bounds.height / 2 - bwOptions.height / 2
        }
    }
    return bwOptions
`

const oldPlacement = (cdp, store) =>
    cdp.evaluate(`const arguments0 = ${JSON.stringify(JSON.stringify(store))};${OLD_PLACEMENT}`)

// ── The run ─────────────────────────────────────────────────────────────────

const before = tabbyCount()

async function main () {
    PORT = parseInt(process.env.CDP_PORT ?? '', 10) || await pickPort()
    console.log(`     debugging on port ${PORT}`)

    // ── Two windows, two saved places ───────────────────────────────────────
    //
    // `windowBoundaries` is seeded too, and to A: it is what this fork writes
    // for slot 1 so a downgrade still finds the main window, and it is the only
    // thing the old placement can read. Same file, both readers.
    const seeded = { windowGeometries: { 1: { ...A, maximized: false }, 2: { ...B, maximized: false } }, windowBoundaries: A, maximized: false }
    const first = launch('restore', seeded)
    const [w1] = await windows(1)

    const displays = await w1.evaluate(`return require('@electron/remote').screen.getAllDisplays().map(d => ({ id: d.id, workArea: d.workArea }))`)
    const area = displays[0].workArea
    if (area.width < 1100 || area.height < 780) {
        console.log(`skip  work area ${area.width}x${area.height} is too small for the fixtures`)
        return
    }
    console.log(`     ${displays.length} display(s), primary work area ${rect(area)}`)

    await w1.evaluate(`require('electron').ipcRenderer.send('app:new-window', { hidden: true }); return null`)
    w1.close()
    const both = await windows(2)
    check(same(both[0].bounds, A) && same(both[1].bounds, B),
        `two windows opened at their own saved places: ${rect(both[0].bounds)} and ${rect(both[1].bounds)}`
        + ` (wanted ${rect(A)} and ${rect(B)})`)

    const placed = await waitForRecords(first, 'window-geometry', 2)
    check(placed.length === 2 && placed.every(r => r.source === 'restored')
        && placed.map(r => r.slot).join() === '1,2',
        `and the main process says both were restored, one per slot: `
        + (placed.map(r => `slot ${r.slot} ${r.source}`).join(', ') || 'nothing in the log'))

    // The same file, read by the code this replaced.
    const oldFirst = await oldPlacement(both[0], seeded)
    const oldSecond = await oldPlacement(both[1], seeded)
    check(same(oldFirst, oldSecond),
        `the old placement put both windows in the same place from the same file: `
        + `${rect(oldFirst)} and ${rect(oldSecond)} — which is the bug`)

    // ── Each saves back to its own slot ─────────────────────────────────────
    //
    // Through the same IPC the app's own "move window" path uses, then closed
    // the way `hostWindow.close()` closes a window, which is what runs the save.
    await both[0].evaluate(`require('electron').ipcRenderer.send('window-set-bounds', ${JSON.stringify(A2)}); return null`)
    await both[1].evaluate(`require('electron').ipcRenderer.send('window-set-bounds', ${JSON.stringify(B2)}); return null`)
    await sleep(500)
    for (const w of both) {
        await w.evaluate(`require('electron').ipcRenderer.send('window-close'); return null`).catch(() => { /* the target goes with the window */ })
        w.close()
    }
    await sleep(3000)

    const store = stored(first)
    const saved = store.windowGeometries
    check(same(saved?.[1], A2) && same(saved?.[2], B2),
        `closing wrote each window to its own slot: 1 ${rect(saved?.[1])}, 2 ${rect(saved?.[2])}`
        + ` (wanted ${rect(A2)} and ${rect(B2)})`)
    check(same(store.windowBoundaries, A2),
        `and mirrored slot 1 to the key a build without slots reads: ${rect(store.windowBoundaries)}`)
    await shutDown(first)

    // ── And they come back there ────────────────────────────────────────────
    const again = launch('restore', null, { fresh: false })
    const [r1] = await windows(1)
    await r1.evaluate(`require('electron').ipcRenderer.send('app:new-window', { hidden: true }); return null`)
    r1.close()
    const reopened = await windows(2)
    check(same(reopened[0].bounds, A2) && same(reopened[1].bounds, B2),
        `reopened where they were left: ${rect(reopened[0].bounds)} and ${rect(reopened[1].bounds)}`
        + ` (wanted ${rect(A2)} and ${rect(B2)})`)
    // Exactly, not roughly. A frameless window reports back 2px taller than the
    // size its constructor was given, so a rectangle that goes round this loop
    // untouched used to grow on every launch.
    check(reopened[0].bounds.height === A2.height && reopened[1].bounds.height === B2.height,
        `and at the size they were, not a couple of pixels taller each time`)
    for (const w of reopened) {
        w.close()
    }
    await shutDown(again)

    // ── Out of reach, gone, and nothing to cascade from ─────────────────────
    //
    // Slot 1's title bar is off the top of the screen, slot 2 was saved on a
    // monitor that is not here any more, and slot 3 has nothing at all — so the
    // third window must not land on top of either of the others.
    const third = launch('offscreen', {
        windowGeometries: {
            1: { ...OFFSCREEN, maximized: false },
            2: { ...UNPLUGGED, maximized: false },
        },
        windowBoundaries: OFFSCREEN,
    })
    const [o1] = await windows(1)
    check(reachable(o1.bounds, displays) && o1.bounds.height === OFFSCREEN.height,
        `a saved rect with its title bar 700px above the screen came back on screen: `
        + `${rect(OFFSCREEN)} -> ${rect(o1.bounds)}`)

    const oldOffscreen = await oldPlacement(o1, { windowBoundaries: OFFSCREEN })
    check(same(oldOffscreen, OFFSCREEN) && !reachable(oldOffscreen, displays),
        `the old check accepted it unchanged — ${rect(oldOffscreen)}, still out of reach`)

    for (let i = 0; i < 2; i++) {
        await o1.evaluate(`require('electron').ipcRenderer.send('app:new-window', { hidden: true }); return null`)
        await sleep(2500)
    }
    o1.close()
    const opened = await windows(3)
    const placements = await waitForRecords(third, 'window-geometry', 3)
    const bySlot = Object.fromEntries(placements.map(r => [r.slot, r]))
    check(bySlot[2]?.source === 'restored-adjusted' && reachable(bySlot[2], displays),
        `a rect saved on a monitor that is no longer here came back onto one that is: `
        + `${rect(UNPLUGGED)} -> ${rect(bySlot[2])}`)
    const adjusted = records(third).filter(r => r.kind === 'window-geometry-adjusted')
    check(adjusted.length === 2, `and both adjustments said why: `
        + (adjusted.map(r => r.summary).join('; ') || 'nothing in the log'))

    check(bySlot[3]?.source === 'cascade',
        `a third window with nothing saved was cascaded, not left to land on one of them: `
        + `${rect(bySlot[3])}`)
    const origins = new Set(opened.map(w => `${w.bounds.x},${w.bounds.y}`))
    check(origins.size === 3, `all three windows are in different places: ${[...origins].join(' / ')}`)
    check(opened.every(w => reachable(w.bounds, displays)), 'and all three are reachable')
    for (const w of opened) {
        w.close()
    }
    await shutDown(third)
}

// Nothing here should take four minutes. A hang is a result too, and it has to
// be reported rather than left sitting on a CI box.
const overall = setTimeout(() => {
    console.error('FAIL  the run did not finish in 4 minutes')
    for (const handle of live) {
        stop(handle)
    }
    process.exit(1)
}, 4 * 60 * 1000)

main().catch(err => {
    console.error('FAIL  the test itself threw:', err)
    failed++
}).finally(async () => {
    clearTimeout(overall)
    for (const handle of live) {
        stop(handle)
    }
    await sleep(1000)
    const after = tabbyCount()
    // Only a *drop* is ours to answer for; the count going up is the user
    // opening a window.
    if (after < before) {
        console.error(`REFUSING TO PASS: Tabby.exe count fell ${before} -> ${after}`)
        process.exit(3)
    }
    console.log(`Tabby.exe ${before} -> ${after}`)
    process.exitCode = failed ? 1 : 0
})
