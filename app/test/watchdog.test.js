// A process that cannot produce a working window must quit, not hold the
// single-instance lock forever.
//
//   node app/test/watchdog.test.js
//
// Needs a built dev build (`yarn build`, or at least the app bundles). Runs
// three real launches of ~40s each against throwaway profiles, so allow a
// couple of minutes.
//
// The dev build is electron.exe; the installed Tabby is Tabby.exe and holds
// live sessions. Nothing here ever touches it: the Tabby.exe count is taken
// before and after, only PIDs we spawned are stopped, and a drop fails the run.
//
// What is under test, in the shape it actually happens:
//
//   A window is created, its renderer starts, and it never reaches `app:ready`.
//   `Application.newWindow()` pushes the window onto its list *before* awaiting
//   `window.ready`, so the process looks perfectly healthy from outside — one
//   window, a live renderer, no crash — while every later launch is handed to
//   it by the single-instance lock and silently swallowed. Measured on
//   2026-09-05: six hours of it.
//
// Blacklisting `tabby-core` is the lever. It is the same fault class the
// build doctor already covers — one of the builtins the app cannot start
// without is unavailable — and it lands in exactly that state: Angular
// bootstrap fails, safe mode fails behind it, and the renderer sits on the
// splash screen at 0% CPU with the window still there.
//
// The original 2026-09-05 fault was a poisoned NODE_PATH, and that no longer
// reproduces: `c5e67743` made a build resolve its own builtins by absolute
// path, so a dev build launched with the installed app's plugin directories on
// NODE_PATH now boots in under two seconds. Verified before writing this.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..', '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

/** Short enough to run three of these, long enough that a healthy dev build
 *  (measured here: `app:ready` 1.9-3.8s after the watchdog arms) is nowhere
 *  near it. The shipping default is 60s. */
const BOOT_MS = 15000
const NO_WINDOW_MS = 3000
/** How long past the budget a broken process gets before we call it stuck, and
 *  how long a healthy one has to survive to count as unaffected. */
const SLACK_MS = 20000

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

/**
 * Launch the dev build hidden, on its own profile.
 *
 * `--user-data-dir` must precede the app path or Electron hands the switch to
 * the app and silently ignores it, sharing %APPDATA%\tabby with the installed
 * Tabby. NODE_PATH is scrubbed to this repo for the same reason it is
 * everywhere else here: an inherited one points at another build's plugins.
 */
function launch (label, { blacklist = [], env = {}, profile = null } = {}) {
    const dir = profile ?? path.join(os.tmpdir(), `tabby-watchdog-${label}`)
    if (!profile) {
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
            // A slot's own seed drops these two for the same reason: a scratch
            // instance must not take the global hotkey or the MCP port from the
            // Tabby the user is actually using.
            '  - mcp-server',
            ...blacklist.map(x => `  - ${x}`),
            '',
        ].join('\n'))
    }

    const child = spawn(electron, [
        `--user-data-dir=${dir}`,
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
            TABBY_WATCHDOG_BOOT_MS: String(BOOT_MS),
            TABBY_WATCHDOG_NO_WINDOW_MS: String(NO_WINDOW_MS),
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    const log = fs.createWriteStream(path.join(dir, 'launch.log'))
    child.stdout.pipe(log)
    child.stderr.pipe(log)

    const handle = { label, dir, pid: child.pid, exit: null, startedAt: Date.now() }
    child.on('exit', code => {
        handle.exit = { code, afterMs: Date.now() - handle.startedAt }
    })
    return handle
}

function stop (handle) {
    if (handle.exit) {
        return
    }
    try {
        // By PID, never by name.
        execFileSync('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* already gone */ }
}

/** The diagnostics log is the only place any of this is visible from outside. */
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

const has = (handle, kind) => records(handle).some(r => r.kind === kind)

/** Wait for the process to exit, up to `ms`. Resolves either way. */
async function waitForExit (handle, ms) {
    const deadline = Date.now() + ms
    while (!handle.exit && Date.now() < deadline) {
        await sleep(500)
    }
    return handle.exit
}

const before = tabbyCount()
let failed = 0
const live = []

function check (ok, message) {
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${message}`)
    if (!ok) {
        failed++
    }
}

async function main () {
    // ── A broken build quits, and says why ──────────────────────────────────
    const broken = launch('broken', { blacklist: ['core'] })
    live.push(broken)
    const exit = await waitForExit(broken, BOOT_MS + SLACK_MS)
    check(!!exit, `a window that never reached app:ready quit itself`
        + (exit ? ` after ${(exit.afterMs / 1000).toFixed(1)}s (exit ${exit.code})` : ` — STILL RUNNING after ${((BOOT_MS + SLACK_MS) / 1000).toFixed(0)}s`))

    const quit = records(broken).find(r => r.kind === 'watchdog-quit')
    check(!!quit, `it wrote why to diagnostics.log: ${quit ? quit.summary : 'nothing'}`)
    check(has(broken, 'bootstrap-failed') && !has(broken, 'window-ready'),
        'and the fault it quit over is the right one — bootstrap failed, no window ever became ready')

    // ── The same build, watchdog off, still hangs ───────────────────────────
    //
    // Without this the run proves only that nothing is broken on a machine
    // where nothing was ever wrong: if the fixture stopped reproducing the
    // fault, every check above would pass for the wrong reason.
    const unguarded = launch('unguarded', { blacklist: ['core'], env: { TABBY_WATCHDOG: '0' } })
    live.push(unguarded)
    await waitForExit(unguarded, BOOT_MS + SLACK_MS)
    check(!unguarded.exit && !has(unguarded, 'window-ready'),
        'with TABBY_WATCHDOG=0 the same build sits there holding the lock — the fault is real and the guard is what stops it')
    stop(unguarded)

    // ── A healthy build is never touched ────────────────────────────────────
    const healthy = launch('healthy')
    live.push(healthy)
    await sleep(BOOT_MS + SLACK_MS)
    const ready = records(healthy).find(r => r.kind === 'window-ready')
    check(!healthy.exit && !!ready,
        `a healthy build is still up ${((BOOT_MS + SLACK_MS) / 1000).toFixed(0)}s later`
        + (ready ? `, ${ready.summary}` : ' — but never reported a ready window'))
    check(!has(healthy, 'watchdog-quit'), 'and the watchdog never fired on it')

    // A handoff is the other way to arm the watchdog, and it happens on every
    // launch while Tabby is open — so it had better not be able to quit one.
    const second = launch('healthy', { profile: healthy.dir })
    live.push(second)
    await waitForExit(second, 20000)
    check(!!second.exit, `a second launch on the same profile was handed off and exited (${second.exit ? second.exit.code : 'still running'})`)
    await sleep(NO_WINDOW_MS + 5000)
    check(!healthy.exit && !has(healthy, 'watchdog-quit'),
        'and the instance that took the handoff is untouched')
    stop(healthy)
}

main().catch(err => {
    console.error('FAIL  the test itself threw:', err)
    failed++
}).finally(async () => {
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
