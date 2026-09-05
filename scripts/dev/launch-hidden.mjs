#!/usr/bin/env node
// Launch the dev build hidden, with an isolated profile, for CDP-driven tests.
//
//   node scripts/dev/launch-hidden.mjs --frontend xterm --port 9238 [--keep]
//   node scripts/dev/launch-hidden.mjs --enable builds --port 9239
//
// Never touches the installed Tabby: the dev build is electron.exe, the
// installed app is Tabby.exe. The Tabby.exe process count is recorded before
// launch and re-checked on exit, and only the PID we spawned is ever stopped.
import { spawn, execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as url from 'node:url'
import * as net from 'node:net'

const root = path.resolve(url.fileURLToPath(new URL('.', import.meta.url)), '..', '..')

function arg (name, fallback) {
    const i = process.argv.indexOf(`--${name}`)
    return i === -1 ? fallback : process.argv[i + 1]
}

const frontend = arg('frontend', 'xterm-webgl')
const port = parseInt(arg('port', '9238'), 10)
const profile = arg('profile', path.join(
    process.env.TEMP ?? os.tmpdir(), `tabby-render-${frontend}-${port}`))

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

function portFree (p) {
    return new Promise(resolve => {
        const s = net.createServer()
        s.once('error', () => resolve(false))
        s.once('listening', () => s.close(() => resolve(true)))
        s.listen(p, '127.0.0.1')
    })
}

// A profile per (frontend, port): a second dev instance on the same
// --user-data-dir hits the single-instance lock and exits 0 in silence.
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(profile, { recursive: true })

// Seeded so a run measures the renderer and not the theme: no blinking cursor,
// no ligatures, no contrast rewriting, and none of the plugins that draw over
// the terminal.
const font = arg('font', 'Consolas')
const fontWeight = arg('font-weight', '400')
const fontWeightBold = arg('font-weight-bold', '700')
const contrast = arg('contrast', '1')
const scrollback = arg('scrollback', '500')

// Plugins that would draw over the terminal or grab a global resource. A test
// that needs one of them back asks for it: --enable builds,links.
const enabled = new Set(arg('enable', '').split(',').map(x => x.trim()).filter(x => x))
const BLACKLIST = ['links', 'linkifier', 'claude', 'builds', 'mcp-server', 'claude-status']
    .filter(x => !enabled.has(x))

fs.writeFileSync(path.join(profile, 'config.yaml'), [
    'version: 8',
    'terminal:',
    // Plain cmd, not the default CMD (clink): clink injects itself into the
    // console, and when that fails the session dies three seconds in and takes
    // the instance with it — a hidden run then looks like a launch that never
    // opened its debugging port.
    '  profile: local:cmd',
    `  frontend: ${frontend}`,
    '  cursorBlink: false',
    '  ligatures: false',
    `  minimumContrastRatio: ${contrast}`,
    `  scrollbackLines: ${scrollback}`,
    '  fontSize: 14',
    `  font: ${font}`,
    `  fontWeight: ${fontWeight}`,
    `  fontWeightBold: ${fontWeightBold}`,
    'appearance:',
    '  vibrancy: false',
    '  opacity: 1',
    'hotkeys:',
    '  toggle-window: []',
    'enableWelcomeTab: false',
    'enableAutomaticUpdates: false',
    'recoverTabs: false',
    'pluginBlacklist:',
    ...BLACKLIST.map(x => `  - ${x}`),
    '',
].join('\n'))

const before = tabbyCount()
if (!await portFree(port)) {
    console.error(`port ${port} is already in use — pick another with --port`)
    process.exit(2)
}

const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(electron, [
    // --user-data-dir must precede the app path, or Electron hands the switch
    // to the app and silently ignores it, sharing %APPDATA%\tabby.
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'app',
    '--hidden',
    '--enable-logging=stderr',
], {
    cwd: root,
    env: {
        ...process.env,
        // Not empty and not inherited: findPlugins() reads globalPaths, and an
        // inherited NODE_PATH points at the *installed* app's plugins.
        NODE_PATH: path.join(root, 'app', 'node_modules'),
        TABBY_PLUGINS: '',
        TABBY_DEV: '1',
        TABBY_CONFIG_DIRECTORY: profile,
        TABBY_DIAG: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
})

const logPath = path.join(profile, 'launch.log')
const log = fs.createWriteStream(logPath)
child.stdout.pipe(log)
child.stderr.pipe(log)

const meta = { pid: child.pid, port, profile, frontend, log: logPath, tabbyBefore: before }
fs.writeFileSync(path.join(profile, 'launch.json'), JSON.stringify(meta, null, 2))
console.log(JSON.stringify(meta))

let stopped = false
function stop (code) {
    if (stopped) {
        return
    }
    stopped = true
    try {
        // By PID, never by name.
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* already gone */ }
    const after = tabbyCount()
    // Only a *drop* is ours to answer for. The count going up is the user
    // opening a window, and failing the run for that made a long session
    // unusable — the instance was killed and the test reported a false alarm.
    if (after < before) {
        console.error(`REFUSING TO PASS: Tabby.exe count fell ${before} -> ${after}`)
        process.exit(3)
    }
    process.exit(code ?? 0)
}
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))
if (!process.argv.includes('--keep')) {
    // Default: hold the instance until the parent is killed.
    child.on('exit', c => stop(c ?? 0))
}
