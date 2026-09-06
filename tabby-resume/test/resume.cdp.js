// Session resume, in a running window.
//
//   node scripts/dev/launch-hidden.mjs --enable claude,resume    # prints its port
//   node tabby-resume/test/resume.cdp.js
//
// The pure logic is covered by `logic.test.js`, the WSL join by
// `wslProbe.test.js` and the native process walk by `native.electron.js`. What
// only a live window can answer is whether the thing is *wired*: that a pane
// really carries `TABBY_SESSION`, that the capture reaches the recovery token
// Tabby persists, that a restored pane is typed into rather than launched with
// the command — so its shell outlives the program — and that none of it costs
// the save path anything, which is the one place this feature could plausibly
// make the app worse.
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

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

const SETUP = `
    const root = ${ROOT}
    if (!root) { throw new Error('the window has not booted') }
    const injector = window.ng.getInjector(document.querySelector('app-root'))
    const R = require('tabby-resume')
    const core = require('tabby-core')
    const all = root.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const term = all.find(t => t.session && t.frontend && t.frontend.xterm)
    if (!term) { throw new Error('no terminal tab with a live session') }
    window.__R = {
        root, injector, R, term,
        resume: injector.get(R.SessionResumeService),
        recovery: injector.get(core.TabRecoveryService),
        config: root.config,
    }
`

/** Everything on the pane's screen, as text. */
const SCREEN = `
    const b = window.__R.term.frontend.xterm.buffer.active
    let out = ''
    for (let i = 0; i < b.length; i++) { out += b.getLine(i).translateToString(true).trimEnd() + '\\n' }
    return out
`

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Type a line into the pane and give it a moment to answer. */
async function type (d, line, waitMs = 1200) {
    await d.evaluate(`window.__R.term.sendInput(${JSON.stringify(line + '\r')}); return true`)
    await sleep(waitMs)
}

async function main () {
    const d = await connect({})
    // A window that is still loading its plugins answers everything below with
    // null, which reads as a broken feature rather than a slow start.
    // In a try: `window.ng` appears before `getComponent` is on it, so the
    // obvious truthiness check throws rather than answering "not yet".
    for (let i = 0; i < 60; i++) {
        if (await d.evaluate(`try { return !!(${ROOT} || {}).app.tabs.length } catch { return false }`)) {
            break
        }
        await sleep(1000)
    }
    await d.evaluate(SETUP)

    console.log('── the plugin is loaded, and its augmentor is registered ──')
    check('the module loaded as a builtin',
        await d.evaluate(`return (window.pluginModules || []).map(m => (m.ngModule || m).pluginName).includes('resume')`), true)
    check('an augmentor is registered with the recovery service',
        await d.evaluate(`
            const list = window.__R.recovery.augmentors || []
            return list.map(x => x.constructor.name).includes('ResumeRecoveryAugmentor')
        `), true)
    check('the settings page is offered',
        await d.evaluate(`
            const s = require('tabby-settings')
            return window.__R.injector.get(s.SettingsTabProvider).some(p => p.id === 'resume')
        `), true)

    console.log('── a pane carries TABBY_SESSION, and it crosses into a distro ──')
    const uid = await d.evaluate('return window.__R.term.session.sessionUID || null')
    check('the session minted one', typeof uid === 'string' && uid.length > 8, true)
    await type(d, 'echo TS=%TABBY_SESSION% WE=%WSLENV%', 1500)
    const screen = await d.evaluate(SCREEN)
    check('the pane\'s own environment has it', screen.includes(`TS=${uid}`), true)
    check('and WSLENV names it, which is the only way it reaches a distro',
        /WE=(.*[:;])?TABBY_SESSION\b/.test(screen.split('\n').find(l => l.startsWith('TS=')) ?? ''), true)

    console.log('── what the pane is running reaches the recovery token ──')
    // A program with a child of its own, which is the shape that matters: an
    // agent spawns one per MCP server and the deepest descendant is one of
    // those, so the answer has to be the first thing the shell launched.
    await d.evaluate(`
        const c = window.__R.config
        c.store.resume.extraPrograms = ['node']
        c.store.resume.excludedPrograms = []
        c.store.resume.notification = 'silent'
        c.store.resume.inputDelayMs = 250
        await c.save()
        return true
    `)
    const node = process.execPath.replace(/\\/g, '\\\\')
    await type(d, `"${process.execPath}" -e "setTimeout(function(){},600000);require('child_process').spawn(process.execPath,['-e','setTimeout(function(){},600000)','mcp-child'],{stdio:'ignore'})" agent-parent`, 3500)

    const shellPidBefore = await d.evaluate('return await window.__R.term.session.getShellPID()')
    check('the pane reports its shell, not the program it launched',
        typeof shellPidBefore === 'number' && shellPidBefore > 0, true)

    let recorded = await d.evaluate(`
        await window.__R.resume.refresh(true)
        return window.__R.resume.commandFor(window.__R.term)
    `)
    note(`recorded: ${JSON.stringify(recorded)}`)
    check('a program named in extraPrograms is recorded', recorded.includes('agent-parent'), true)
    // Compared on the last argument rather than by searching the string: the
    // parent's own command line contains the script that spawns the child, so
    // both markers appear in it whichever process was picked.
    check('and it is the first child, not the deepest',
        await d.evaluate(`return require('tabby-resume').splitWindowsCommandLine(${JSON.stringify(recorded)}).pop()`),
        'agent-parent')
    check('the executable came through', recorded.toLowerCase().includes(node.split('\\\\').pop().toLowerCase()), true)

    console.log('── the exclusion list beats the switches ──')
    recorded = await d.evaluate(`
        const c = window.__R.config
        c.store.resume.excludedPrograms = ['node']
        await c.save()
        await window.__R.resume.refresh(true)
        return window.__R.resume.commandFor(window.__R.term)
    `)
    check('an excluded program records nothing', recorded, '')

    console.log('── a program no rule covers falls back to a plain shell ──')
    recorded = await d.evaluate(`
        const c = window.__R.config
        c.store.resume.extraPrograms = []
        c.store.resume.excludedPrograms = []
        await c.save()
        await window.__R.resume.refresh(true)
        return window.__R.resume.commandFor(window.__R.term)
    `)
    check('nothing is recorded, so nothing is restored', recorded, '')
    check('and the token carries no resume command',
        await d.evaluate(`
            const t = await window.__R.recovery.getFullRecoveryToken(window.__R.term, { includeState: true })
            return t.resumeCommand ?? null
        `), null)

    console.log('── the token round trip ──')
    const trip = async command => d.evaluate(`
        window.__R.resume.seed(window.__R.term, ${JSON.stringify(command)})
        const token = await window.__R.recovery.getFullRecoveryToken(window.__R.term, { includeState: true })
        const params = await window.__R.recovery.recoverTab(JSON.parse(JSON.stringify(token)))
        return {
            onToken: token.resumeCommand ?? null,
            onTab: params.inputs[window.__R.R.RESUME_COMMAND_INPUT] ?? null,
            savedStateKept: !!params.inputs.savedState,
            hadSavedState: !!token.savedState,
            paneCommand: params.inputs.profile.options.command,
        }
    `)
    const AGENT_COMMAND = 'cd "C:\\\\repo" && claude --resume abc'
    const agentTrip = await trip(AGENT_COMMAND)
    check('the command is persisted with the layout', agentTrip.onToken, AGENT_COMMAND)
    check('and arrives on the restored pane', agentTrip.onTab, AGENT_COMMAND)
    check('the pane still starts its own shell, not the command',
        /cmd\.exe$|clink/i.test(agentTrip.paneCommand), true)
    check('there was scrollback to suppress', agentTrip.hadSavedState, true)
    check('a pane reopening an agent conversation does not repaint it', agentTrip.savedStateKept, false)

    const plainTrip = await trip('tmux new-session -A -s demo')
    check('a pane that does not redraw its own history keeps it', plainTrip.savedStateKept, true)

    console.log('── duplicating a tab does not duplicate the session ──')
    check('a token taken without state carries no resume command',
        await d.evaluate(`
            window.__R.resume.seed(window.__R.term, 'claude --resume abc')
            const t = await window.__R.recovery.getFullRecoveryToken(window.__R.term)
            return t.resumeCommand ?? null
        `), null)

    console.log('── a restored pane is typed into, and outlives what it runs ──')
    // The node processes above are still in the foreground, and a pane sends
    // input to whatever is: a resume typed now would land in their stdin.
    await d.evaluate('window.__R.term.sendInput(String.fromCharCode(3)); return true')
    await sleep(2500)
    // The real restore path, minus the restart: the augmentor puts the command
    // on the tab, the service claims it and types it. `echo` exits at once,
    // which is the point — a pane whose command line WAS the program would
    // close here.
    await d.evaluate(`
        window.__R.term.frontend.clear()
        window.__R.term[window.__R.R.RESUME_COMMAND_INPUT] = 'echo resumed-and-still-here'
        window.__R.resume.expectRestore()
        return true
    `)
    await sleep(6000)
    const after = await d.evaluate(SCREEN)
    check('the command was typed into the pane', after.includes('resumed-and-still-here'), true)
    check('the pane is still open', await d.evaluate('return !!window.__R.term.session && window.__R.term.session.open'), true)
    check('and its root process is still the shell it started as',
        await d.evaluate('return await window.__R.term.session.getShellPID()'), shellPidBefore)
    check('the input was claimed exactly once',
        await d.evaluate(`return window.__R.term[window.__R.R.RESUME_COMMAND_INPUT]`), '')

    console.log('── what this costs the save path ──')
    const cost = await d.evaluate(`
        const { recovery, root, resume, term } = window.__R
        resume.seed(term, 'claude --resume abc')
        const time = async (n, fn) => {
            await fn()
            const t0 = performance.now()
            for (let i = 0; i < n; i++) { await fn() }
            return (performance.now() - t0) / n
        }
        const augmentor = (recovery.augmentors || []).find(x => x.constructor.name === 'ResumeRecoveryAugmentor')
        const token = await recovery.getFullRecoveryToken(term, { includeState: true })
        const augment = await time(50, () => augmentor.augment(term, {}, { includeState: true }))
        const save = await time(10, () => recovery.saveTabs(root.app.tabs))
        // What Tabby actually does on the way out: closeWindow turns saving off
        // and then calls saveTabs, so the last save before a quit does nothing
        // at all and this feature cannot delay one.
        const was = recovery.enabled
        recovery.enabled = false
        const quit = await time(10, () => recovery.saveTabs(root.app.tabs))
        recovery.enabled = was
        return { augment, save, quit, tabs: root.app.tabs.length, tokenBytes: JSON.stringify(token).length }
    `)
    note(`augment ${cost.augment.toFixed(3)}ms/tab · saveTabs ${cost.save.toFixed(2)}ms `
        + `(${cost.tabs} tab(s), token ${cost.tokenBytes} bytes) · the save closeWindow makes ${cost.quit.toFixed(3)}ms`)
    check('augmenting a token is under a millisecond', cost.augment < 1, true)
    check('the save Tabby makes while quitting is a no-op', cost.quit < 0.5, true)

    console.log('── and the capture does not block the window ──')
    const gap = await d.evaluate(`
        let worst = 0
        let last = performance.now()
        const timer = setInterval(() => {
            const now = performance.now()
            worst = Math.max(worst, now - last)
            last = now
        }, 10)
        await window.__R.resume.refresh(true)
        clearInterval(timer)
        return worst
    `)
    note(`worst event-loop gap during a full capture: ${gap.toFixed(1)}ms`)
    check('no stall over 250ms, which is what the diagnostics call one', gap < 250, true)

    console.log('── putting the profile back ──')
    await d.evaluate(`
        const c = window.__R.config
        c.store.resume.extraPrograms = []
        c.store.resume.excludedPrograms = []
        c.store.resume.notification = 'toast'
        c.store.resume.inputDelayMs = 1200
        await c.save()
        return true
    `)
    // The node processes this test started are children of the pane's shell and
    // go with it when the instance is stopped; killed here anyway so a --keep
    // run does not leave them.
    await d.evaluate('window.__R.term.sendInput(String.fromCharCode(3)); return true')
}

main().then(() => {
    closeAll()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}, error => {
    closeAll()
    console.log('ERROR', error)
    process.exit(1)
})
