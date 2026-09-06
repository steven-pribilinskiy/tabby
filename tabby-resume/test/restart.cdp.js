// The whole claim, end to end: close the window on a pane that is running
// something, open it again, and the pane is running it again.
//
//   node tabby-resume/test/restart.cdp.js
//
// This one launches and stops its own instances — twice, on one profile — so it
// takes no port and no running dev build. `resume.cdp.js` proves each link in
// isolation; only a real restart proves they are joined, because the join runs
// through Tabby's own persistence: the capture has to reach `saveTabs`, survive
// in localStorage, come back through `recoverTab`, and land on a pane that by
// then is a different process.
//
// Never touches the installed Tabby: the dev build is electron.exe and every
// stop here is `taskkill /PID` on a pid this file spawned.
const { spawn, execFileSync } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const { closeAll, connect } = require('./cdp')

const REPO = path.resolve(__dirname, '../..')
const PROFILE = path.join(process.env.TEMP ?? os.tmpdir(), `tabby-resume-restart-${process.pid}`)
const MARKER = `resume-restart-${process.pid}`

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

const sleep = ms => new Promise(r => setTimeout(r, ms))
const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

let launcher = null
let meta = null

function tabbyCount () {
    return parseInt(execFileSync('powershell', ['-NoProfile', '-Command',
        '@(Get-Process Tabby -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).trim(), 10)
}

/** Start the dev build through the repo's own launcher, and wait for its port. */
function launch (keepProfile) {
    return new Promise((resolve, reject) => {
        const args = [path.join(REPO, 'scripts/dev/launch-hidden.mjs'),
            '--enable', 'claude,resume', '--profile', PROFILE, '--keep']
        if (keepProfile) {
            args.push('--keep-profile')
        }
        const child = spawn(process.execPath, args, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', chunk => {
            out += chunk
            const line = out.split('\n').find(l => l.trim().startsWith('{'))
            if (line) {
                launcher = child
                resolve(JSON.parse(line))
            }
        })
        child.stderr.on('data', chunk => process.stderr.write(String(chunk)))
        child.on('exit', code => reject(new Error(`launcher exited ${code} before printing its port`)))
        setTimeout(() => reject(new Error('launcher never printed its port')), 60000)
    })
}

function stop () {
    if (!launcher) {
        return
    }
    try {
        execFileSync('taskkill', ['/PID', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* already gone */ }
    launcher = null
}

/** Attach, and wait for the window to have actually booted. */
async function attach (port) {
    const d = await connect({ port })
    // In a try: `window.ng` appears before `getComponent` is on it, so the
    // obvious truthiness check throws rather than answering "not yet".
    for (let i = 0; i < 90; i++) {
        if (await d.evaluate(`try { return !!(${ROOT} || {}).app.tabs.length } catch { return false }`)) {
            return d
        }
        await sleep(1000)
    }
    throw new Error('the window never booted')
}

/** Every terminal pane's screen, joined. */
const SCREENS = `
    const root = ${ROOT}
    const all = root.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    return all.filter(t => t.frontend && t.frontend.xterm).map(t => {
        const b = t.frontend.xterm.buffer.active
        let out = ''
        for (let i = 0; i < b.length; i++) { out += b.getLine(i).translateToString(true).trimEnd() + '\\n' }
        return out
    }).join('\\n---\\n')
`

async function main () {
    const before = tabbyCount()
    console.log('── first run: a pane running something ──')
    meta = await launch(false)
    note(`profile ${PROFILE}, port ${meta.port}`)
    let d = await attach(meta.port)

    await d.evaluate(`
        const root = ${ROOT}
        root.config.store.recoverTabs = true
        root.config.store.resume.extraPrograms = ['node']
        root.config.store.resume.notification = 'silent'
        root.config.store.resume.inputDelayMs = 400
        await root.config.save()
        return true
    `)
    // A program that keeps running and says which run started it, so the second
    // window cannot be mistaken for the first.
    const command = `"${process.execPath}" -e "setTimeout(function(){},900000)" ${MARKER}`
    await d.evaluate(`
        const root = ${ROOT}
        const term = root.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t]).find(t => t.session)
        term.sendInput(${JSON.stringify(command + '\r')})
        return true
    `)
    await sleep(4000)

    const recorded = await d.evaluate(`
        const root = ${ROOT}
        const R = require('tabby-resume')
        const core = require('tabby-core')
        const injector = window.ng.getInjector(document.querySelector('app-root'))
        const resume = injector.get(R.SessionResumeService)
        const recovery = injector.get(core.TabRecoveryService)
        const term = root.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t]).find(t => t.session)
        await resume.refresh(true)
        // What the 30-second timer would have done on its own.
        recovery.enabled = true
        await recovery.saveTabs(root.app.tabs)
        // Every tab Tabby opens is wrapped in a split, so the leaf tokens —
        // the ones a terminal produced — are one level down.
        const leaves = token => token && Array.isArray(token.children)
            ? token.children.flatMap(leaves)
            : [token]
        const saved = JSON.parse(window.localStorage.tabsRecovery || '[]').flatMap(leaves)
        return { command: resume.commandFor(term), tokens: saved.map(t => t && t.resumeCommand || null) }
    `)
    note(`recorded: ${JSON.stringify(recorded.command)}`)
    check('the pane\'s program was captured', recorded.command.includes(MARKER), true)
    check('and written into the persisted layout', recorded.tokens.some(t => t && t.includes(MARKER)), true)

    console.log('── the window is killed outright ──')
    // Not closed politely: `AppService.closeWindow` turns saving off before its
    // own last save, so a clean exit persists nothing new either — what is on
    // disk is what the periodic save left, which is exactly what this is
    // testing.
    //
    // Chromium is asked to flush first, though. It commits localStorage on its
    // own schedule and a killed process simply loses the last write, which is
    // the app's own behaviour on a crash but makes the test measure Chromium's
    // timer rather than this feature. Verified: without the flush the second
    // run comes up with no saved layout at all.
    await d.evaluate(`
        await require('@electron/remote').getCurrentWindow().webContents.session.flushStorageData()
        return true
    `)
    await sleep(2000)
    d.close()
    stop()
    await sleep(3000)
    check('the profile survived', fs.existsSync(path.join(PROFILE, 'config.yaml')), true)

    console.log('── second run: the same profile, a new process ──')
    meta = await launch(true)
    d = await attach(meta.port)
    check('the persisted layout came back with the profile',
        await d.evaluate(`
            const saved = JSON.parse(window.localStorage.tabsRecovery || '[]')
            const leaves = token => token && Array.isArray(token.children)
                ? token.children.flatMap(leaves) : [token]
            return saved.flatMap(leaves).some(t => t && String(t.resumeCommand || '').includes(${JSON.stringify(MARKER)}))
        `), true)
    check('and the setting that restores it is still on',
        await d.evaluate(`return !!${ROOT}.config.store.recoverTabs`), true)
    // A restored pane starts its shell when it is first rendered, so open it —
    // which is what a person does, and the first moment the pane could run
    // anything at all.
    // Every tab, not the one whose title still names the program: a restored
    // tab is titled from the token only until its session starts, and then it
    // is titled after the shell like any other.
    const restored = await d.evaluate(`
        const root = ${ROOT}
        for (const tab of root.app.tabs) {
            root.app.selectTab(tab)
            await new Promise(r => setTimeout(r, 800))
        }
        return root.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t]).length
    `)
    check('at least one pane came back', restored >= 1, true)
    // The pane's shell, then the claim sweep, then the input delay, then cmd.
    await sleep(15000)

    const screens = await d.evaluate(SCREENS)
    check('the pane came back running what it was running', screens.includes(MARKER), true)
    if (!screens.includes(MARKER)) {
        note(screens.split('\n').filter(l => l.trim()).slice(-12).join('\n       '))
    }
    const running = await d.evaluate(`
        const root = ${ROOT}
        const R = require('tabby-resume')
        const injector = window.ng.getInjector(document.querySelector('app-root'))
        const resume = injector.get(R.SessionResumeService)
        await resume.refresh(true)
        const term = root.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t]).find(t => t.session)
        return { command: resume.commandFor(term), open: !!(term.session && term.session.open) }
    `)
    check('and the process really is there, not just the text on screen',
        running.command.includes(MARKER), true)
    check('the pane is a working shell, not the program itself', running.open, true)

    const after = tabbyCount()
    check('the installed Tabby was never touched', after >= before, true)
    note(`Tabby.exe ${before} -> ${after}`)
}

main().then(() => {
    closeAll()
    stop()
    if (failed || process.env.KEEP_PROFILE) {
        // A half-swept profile is worse than none when something failed: the
        // first thing you reach for is its log, and a partial delete takes the
        // config with it and makes the run look like a different bug.
        console.log(`       profile kept: ${PROFILE}`)
    } else {
        try {
            fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
        } catch {
            console.log(`       (could not remove ${PROFILE} yet)`)
        }
    }
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}, error => {
    closeAll()
    stop()
    console.log('ERROR', error)
    console.log(`profile left for inspection: ${PROFILE}`)
    process.exit(1)
})
