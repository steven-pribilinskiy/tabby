// A startup that fails must report itself and get out of the way, not sit on a
// modal holding the single-instance lock.
//
//   node app/test/startupFailure.test.js [--attended]
//
// Needs a built dev build (`yarn build`, or at least the app bundles). Runs
// three real launches against throwaway profiles; allow about a minute.
//
// The dev build is electron.exe; the installed Tabby is Tabby.exe and holds
// live sessions. Nothing here ever touches it: the Tabby.exe count is taken
// before and after, only PIDs we spawned are stopped, and a drop fails the run.
//
// What is under test:
//
//   `dialog.showErrorBox` is modal and synchronous — the main loop stops inside
//   it until someone clicks OK. A process showing one is alive, has no window,
//   owns the app identity, and cannot run a single timer, so the watchdog that
//   exists for exactly that case can never fire. Every later launch is handed to
//   it and disappears. On an unattended launch nobody even sees the box.
//
// The lever is a *directory* named `window.json` in the profile. `conf` reads
// that file with `readFileSync`, EISDIR is neither ENOENT nor a SyntaxError, so
// it rethrows — out of `loadGeometry`, inside the `Window` constructor. That is
// a genuine window-construction throw, in the same place and the same shape as
// the one that first exposed this. (The lever the previous investigation used —
// non-numeric bounds in `window.json` — no longer throws: `usable()` in
// `windowGeometry.ts` validates them and falls back to a cascade.)
//
// `--attended` adds the checks that put a real dialog on screen, which is why
// they are opt-in rather than part of an ordinary run.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..', '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

const attended = process.argv.includes('--attended')

/** The watchdog's grace period for a window that never appeared. Short enough
 *  to run several of these; the shipping default is 5s. */
const NO_WINDOW_MS = 4000
/** How long past that a process gets before we call it stuck. */
const SLACK_MS = 15000
/** The cap on a dialog nobody dismisses, for the attended run. The shipping
 *  default is two minutes. */
const DIALOG_MS = 8000

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

/** The title of a process's own top-level window — how an error box is seen
 *  from outside, without touching it. */
function mainWindowTitle (pid) {
    try {
        return execFileSync('powershell', [
            '-NoProfile', '-Command',
            `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).MainWindowTitle`,
        ], { encoding: 'utf8' }).trim()
    } catch {
        return ''
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeProfile (dir) {
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
        // A scratch instance must not take the global hotkey or the MCP port
        // from the Tabby the user is actually using.
        '  - mcp-server',
        '',
    ].join('\n'))
    return dir
}

/** Make the next window construction throw, and undo it. */
const poison = dir => fs.mkdirSync(path.join(dir, 'window.json'), { recursive: true })
const repair = dir => fs.rmSync(path.join(dir, 'window.json'), { recursive: true, force: true })

/**
 * Launch the dev build on its own profile.
 *
 * `--user-data-dir` must precede the app path or Electron hands the switch to
 * the app and silently ignores it, sharing %APPDATA%\tabby with the installed
 * Tabby. NODE_PATH is scrubbed to this repo for the same reason it is
 * everywhere else here: an inherited one points at another build's plugins.
 */
function launch (label, dir, { hidden = true, env = {} } = {}) {
    const child = spawn(electron, [
        `--user-data-dir=${dir}`,
        'app',
        ...hidden ? ['--hidden'] : [],
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
            TABBY_WATCHDOG_NO_WINDOW_MS: String(NO_WINDOW_MS),
            TABBY_FATAL_DIALOG_MS: String(DIALOG_MS),
            ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    const log = fs.createWriteStream(path.join(dir, `launch-${label}.log`))
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

/** The diagnostics log is the only place any of this is visible from outside.
 *  Two instances can share a profile, so records are read back by pid. */
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
    }).filter(r => r.pid === handle.pid)
}

const find = (handle, kind) => records(handle).find(r => r.kind === kind)

async function waitForExit (handle, ms) {
    const deadline = Date.now() + ms
    while (!handle.exit && Date.now() < deadline) {
        await sleep(250)
    }
    return handle.exit
}

async function waitForRecord (handle, kind, ms) {
    const deadline = Date.now() + ms
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const record = find(handle, kind)
        if (record || Date.now() > deadline) {
            return record
        }
        await sleep(250)
    }
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
    // ── An unattended launch that cannot make a window exits, quietly ───────
    const dir = makeProfile(path.join(os.tmpdir(), 'tabby-startup-broken'))
    poison(dir)
    const broken = launch('broken', dir)
    live.push(broken)
    const exit = await waitForExit(broken, NO_WINDOW_MS + SLACK_MS)
    check(!!exit, 'a launch whose window construction threw exited on its own'
        + (exit ? ` after ${(exit.afterMs / 1000).toFixed(1)}s (exit ${exit.code})` : ` — STILL RUNNING after ${((NO_WINDOW_MS + SLACK_MS) / 1000).toFixed(0)}s`))

    const failure = find(broken, 'startup-failed')
    check(!!failure && failure.dialog === 'skipped' && failure.quitting === true,
        `it recorded the failure instead of showing it: ${failure ? `${failure.dialog} (${failure.why}), quitting ${failure.quitting}` : 'nothing'}`)
    check(!!failure && /EISDIR/.test(String(failure.summary)),
        `and the fault it reported is the induced one: ${failure ? failure.summary : 'nothing'}`)

    // The zero-window half of the watchdog, end to end. It was armed by
    // `newWindow()` on every one of these failures before today; the modal is
    // what stopped it from ever running.
    const quit = find(broken, 'watchdog-quit')
    check(!!quit && quit.reason === 'window-create-failed' && quit.windows === 0,
        `the zero-window watchdog is what ended it: ${quit ? quit.summary : 'nothing'}`)

    // ── With the watchdog off it still ends itself ──────────────────────────
    //
    // `TABBY_WATCHDOG=0` opts out of the timers, not out of exiting: with them
    // gone nothing else would ever end this process.
    const alone = makeProfile(path.join(os.tmpdir(), 'tabby-startup-unguarded'))
    poison(alone)
    const unguarded = launch('unguarded', alone, { env: { TABBY_WATCHDOG: '0' } })
    live.push(unguarded)
    const byItself = await waitForExit(unguarded, SLACK_MS)
    check(!!byItself && byItself.code === 1,
        'with TABBY_WATCHDOG=0 nothing else would quit it, so it quits itself'
        + (byItself ? ` after ${(byItself.afterMs / 1000).toFixed(1)}s` : ' — STILL RUNNING'))

    // ── A failure before `app.ready` still exits, and still says why ────────
    //
    // Nothing is armed that early — there is no `Application` to count windows
    // — so this path has to end the process itself, and it has to get its
    // record out before `app.exit()`, which runs no timers.
    const badConfig = makeProfile(path.join(os.tmpdir(), 'tabby-startup-config'))
    fs.writeFileSync(path.join(badConfig, 'config.yaml'), 'terminal:\n  profile: [unclosed\n')
    const unreadable = launch('config', badConfig)
    live.push(unreadable)
    const gone = await waitForExit(unreadable, SLACK_MS)
    check(!!gone && gone.code === 1, 'a config that will not parse exits too'
        + (gone ? ` after ${(gone.afterMs / 1000).toFixed(1)}s (exit ${gone.code})` : ' — STILL RUNNING'))
    const config = find(unreadable, 'startup-failed')
    check(!!config && config.failure === 'config-load-failed',
        `with the record flushed before it went: ${config ? config.summary : 'nothing'}`)

    // ── The lock is gone before the error is shown, not after ───────────────
    //
    // The whole hostage property in one check: while a failed process is still
    // alive, a launch on its profile has to get a process of its own.
    const shared = makeProfile(path.join(os.tmpdir(), 'tabby-startup-shared'))
    poison(shared)
    const holder = launch('holder', shared, { env: { TABBY_WATCHDOG_NO_WINDOW_MS: '30000' } })
    live.push(holder)
    const held = await waitForRecord(holder, 'startup-failed', 20000)
    check(!!held && !holder.exit, 'a failed launch that has not quit yet is still alive to be asked')

    repair(shared)
    const next = launch('next', shared)
    live.push(next)
    const ready = await waitForRecord(next, 'window-ready', 30000)
    check(!!ready, `the launch after it got a fresh process and booted: ${ready ? ready.summary : 'no window ever became ready'}`)
    check(!next.exit, `and was not handed to the broken one${next.exit ? ` — it exited ${next.exit.code} after ${(next.exit.afterMs / 1000).toFixed(1)}s` : ''}`)
    stop(holder)
    stop(next)

    // ── A healthy build is untouched ────────────────────────────────────────
    const clean = makeProfile(path.join(os.tmpdir(), 'tabby-startup-healthy'))
    const healthy = launch('healthy', clean)
    live.push(healthy)
    const up = await waitForRecord(healthy, 'window-ready', 30000)
    await sleep(NO_WINDOW_MS + 4000)
    check(!!up && !healthy.exit && !find(healthy, 'startup-failed'),
        `a healthy build starts and stays up${up ? `, ${up.summary}` : ' — but never reported a ready window'}`)
    stop(healthy)

    if (!attended) {
        console.log('note  the two attended checks put a real dialog on screen; run with --attended for them')
        return
    }

    // ── With someone there, the box appears and the loop still runs ─────────
    //
    // The cap firing is the proof that the dialog is no longer blocking: it is
    // an ordinary timer, and inside `showErrorBox` no timer runs at all.
    const seen = makeProfile(path.join(os.tmpdir(), 'tabby-startup-attended'))
    poison(seen)
    const shown = launch('attended', seen, { hidden: false })
    live.push(shown)
    const told = await waitForRecord(shown, 'startup-failed', 20000)
    check(!!told && told.dialog === 'shown', `an ordinary launch is told: ${told ? told.dialog : 'nothing'}`)
    check(mainWindowTitle(shown.pid) === 'Tabby failed to start',
        `and the box is on screen: "${mainWindowTitle(shown.pid)}"`)
    const capped = await waitForExit(shown, DIALOG_MS + SLACK_MS)
    check(!!capped && capped.afterMs > DIALOG_MS,
        `the loop kept running under the box — it capped itself${capped ? ` after ${(capped.afterMs / 1000).toFixed(1)}s` : ' — STILL RUNNING'}`)
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
