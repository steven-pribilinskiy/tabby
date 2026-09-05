// A WSL path resolving inside the running app: real DI, the real registry
// lookup for the default distro, and the card that comes out of it.
//
//   node scripts/dev/launch-hidden.mjs --enable links,linkifier --port 9241
//   CDP_PORT=9241 node tabby-links/test/wslPath.cdp.js
//
// The pure translation is checked in logic.test.js and the ordering against the
// filesystem in wslPath.test.js. What only the app can answer is whether the
// service is wired up, whether `distroHost` really finds the default distro in
// the registry, and whether a hovered path reaches the card as one.
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
function note (text) {
    console.log(`       ${text}`)
}

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`
const DECORATOR = `
    const cmp = ${ROOT}
    const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const term = all.find(t => t.frontend && t.frontend.xterm)
    const decorator = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator')
    if (!decorator) { throw new Error('decorator not attached to any terminal') }
`
// Tabby stores a WSL shell as wsl.exe, with the distro after -d and nothing at
// all for the default one (tabby-electron/src/shells/wsl.ts).
const WSL = `{ profile: { options: { command: 'C:\\\\Windows\\\\system32\\\\wsl.exe', args: ['-d', 'Ubuntu'] } } }`
const WSL_DEFAULT = `{ profile: { options: { command: 'C:\\\\Windows\\\\system32\\\\wsl.exe', args: [] } } }`
const CMD = `{ profile: { options: { command: 'C:\\\\Windows\\\\system32\\\\cmd.exe', args: [] } } }`

const POSIX = '/home/stevenp/projects'
const UNC = '\\\\wsl.localhost\\Ubuntu\\home\\stevenp\\projects'

async function main () {
    const { evaluate, close } = await connect()

    console.log('\n── the service resolves a WSL path ──')
    const resolved = await evaluate(`
        ${DECORATOR}
        const t = decorator.targets
        const one = (text, tab) => t.resolve(text, text, tab)
        return {
            posix: await one('${POSIX}', ${WSL}),
            fragment: await one('file://${POSIX}#L6-L7', ${WSL}),
            defaultDistro: await one('${POSIX}', ${WSL_DEFAULT}),
            notWsl: await one('${POSIX}', ${CMD}),
            windows: await one('C:\\\\Windows\\\\notepad.exe', ${CMD}),
            url: await one('https://example.com/x', ${WSL}),
            missing: await one('/home/stevenp/no-such-directory-here', ${WSL}),
            host: t.distroHost(${WSL_DEFAULT}),
            hostNotWsl: t.distroHost(${CMD}),
        }
    `)
    check('a POSIX path becomes the distro share', resolved.posix.filePath, UNC)
    check('and the card is told to show it', resolved.posix.display, UNC)
    check('a file:// URI with a fragment resolves to the same path',
        resolved.fragment.filePath, UNC)
    // The registry read this needs is the reason the ordinary `wsl` profile,
    // the one with no -d at all, used to have no Copy path at all.
    check('the default distro is found in the registry', resolved.host, 'Ubuntu')
    check('and an unnamed distro resolves like a named one',
        resolved.defaultDistro.filePath, UNC)
    check('a tab that is not WSL is not given a distro', resolved.hostNotWsl, null)
    check('and gets no path for a POSIX one', resolved.notWsl.filePath, '')
    check('a Windows path is unaffected', resolved.windows.filePath, 'C:\\Windows\\notepad.exe')
    check('and says nothing the text did not', resolved.windows.display, '')
    check('a url is not a file', resolved.url.filePath, '')
    check('a path that does not exist is still not offered', resolved.missing.filePath, '')

    console.log('\n── and the card carries it ──')
    // Drive `show()` itself: everything the card renders comes from there, and
    // it is where the handler's `verify` used to gate the whole translation.
    const card = await evaluate(`
        ${DECORATOR}
        const state = decorator.states.get(term)
        // The whole profile is replaced, not \`profile.options\`: that is a
        // ConfigProxy member and an assignment to it goes to the config file
        // and comes straight back as what it was.
        const saved = Object.getOwnPropertyDescriptor(term, 'profile')
        Object.defineProperty(term, 'profile', {
            value: { ...term.profile, options: { command: 'C:\\\\Windows\\\\system32\\\\wsl.exe', args: ['-d', 'Ubuntu'] } },
            configurable: true,
            writable: true,
        })
        try {
            const range = { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }
            const link = { kind: 'link', text: '${POSIX}', range, handlerIndex: -1, rule: null }
            const timing = decorator.rules.resolve('link', link.text, '', null)
            await decorator.show(state, link, timing, 'test:' + Date.now())
            const model = state.componentRef.instance.model
            return { target: model.target, copyPath: model.showCopyPath, reveal: model.showReveal }
        } finally {
            Object.defineProperty(term, 'profile', saved)
            decorator.hide(state)
        }
    `)
    check('the card shows the path it would open', card.target, UNC)
    check('Copy path is offered', card.copyPath, true)
    check('Show in folder is offered', card.reveal, true)
    note(`card target: ${card.target}`)

    console.log('\n── and a click opens it ──')
    // Clicking went through the handler's own `handle`, which for a WSL path
    // means `openExternal('file:///home/…')` — a path the shell resolves
    // against the system drive. Only a link whose resolution actually changed
    // takes the new route; everything else still goes where it went.
    const clicks = await evaluate(`
        ${DECORATOR}
        const state = decorator.states.get(term)
        const handlerNamed = (name) => decorator.handlers.findIndex(h => h.constructor.name === name)
        const savedProfile = Object.getOwnPropertyDescriptor(term, 'profile')
        const savedOpen = decorator.actions.open
        const handles = []
        const opens = []
        const savedHandles = decorator.handlers.map(h => h.handle)
        decorator.actions.open = (uri, filePath) => { opens.push([uri, filePath]) }
        decorator.handlers.forEach(h => { h.handle = (uri) => { handles.push([h.constructor.name, uri]) } })
        const click = async (text, handlerName, wsl) => {
            Object.defineProperty(term, 'profile', {
                value: wsl
                    ? { ...term.profile, options: { command: 'wsl.exe', args: ['-d', 'Ubuntu'] } }
                    : { ...term.profile, options: { command: 'cmd.exe', args: [] } },
                configurable: true, writable: true,
            })
            const range = { start: { x: 0, y: 0 }, end: { x: 0, y: 0 } }
            decorator.activate(state, { kind: 'link', text, range, handlerIndex: handlerNamed(handlerName), rule: null },
                { ctrlKey: true, metaKey: true })
            await new Promise(r => setTimeout(r, 250))
        }
        try {
            await click('${POSIX}', 'UnixFileHandler', true)
            const wslOpens = opens.splice(0), wslHandles = handles.splice(0)
            await click('C:\\\\Windows\\\\notepad.exe', 'WindowsFileHandler', false)
            const winOpens = opens.splice(0), winHandles = handles.splice(0)
            await click('https://example.com/x', 'URLHandler', false)
            return {
                wslOpens, wslHandles,
                winOpens, winHandles,
                urlOpens: opens.splice(0), urlHandles: handles.splice(0),
            }
        } finally {
            Object.defineProperty(term, 'profile', savedProfile)
            decorator.actions.open = savedOpen
            decorator.handlers.forEach((h, i) => { h.handle = savedHandles[i] })
        }
    `)
    check('a WSL path opens its resolved path', clicks.wslOpens, [['', UNC]])
    check('and does not reach the handler that could not open it', clicks.wslHandles, [])
    check('a Windows path still goes through its handler',
        clicks.winHandles, [['WindowsFileHandler', 'C:\\Windows\\notepad.exe']])
    check('and is not rerouted', clicks.winOpens, [])
    check('a url still goes through its handler',
        clicks.urlHandles, [['URLHandler', 'https://example.com/x']])
    check('and is not rerouted either', clicks.urlOpens, [])

    close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
