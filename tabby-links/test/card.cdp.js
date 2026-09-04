// Verifies the hover card itself, inside a real terminal, over CDP.
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
function note (t) { console.log(`       ${t}`) }

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

// Find a terminal tab, select it, and expose it plus its xterm on window.__T.
const SETUP = `
    const cmp = ${ROOT}
    const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const term = all.find(t => t.frontend && t.frontend.xterm)
    if (!term) { throw new Error('no terminal tab with an xterm') }
    const parent = cmp.app.tabs.find(t => t.getAllTabs && t.getAllTabs().includes(term)) || term
    cmp.app.selectTab(parent)
    await new Promise(r => setTimeout(r, 700))
    window.ng.applyChanges(cmp)
    window.__T = { root: cmp, tab: term, xterm: term.frontend.xterm, core: term.frontend.xterm._core }
`

async function main () {
    const { evaluate, close } = await connect()

    console.log('\n── provider registration ──')
    const providers = await evaluate(`
        ${SETUP}
        const list = window.__T.core._linkProviderService.linkProviders
        return {
            count: list.length,
            names: list.map(p => p.constructor.name),
            screenElement: !!window.__T.core.screenElement,
            cardMounted: !!window.__T.core.screenElement.querySelector('link-hover-card'),
            cardIsXtermHover: window.__T.core.screenElement.querySelector('link-hover-card')?.classList.contains('xterm-hover'),
            cardPosition: getComputedStyle(window.__T.core.screenElement.querySelector('link-hover-card')).position,
        }
    `)
    check('our card is mounted inside .xterm-screen', providers.cardMounted, true)
    check('the card carries the xterm-hover class', providers.cardIsXtermHover, true)
    check('the card is position: fixed, so .content overflow cannot clip it', providers.cardPosition, 'fixed')
    check('there is more than just the OSC provider', providers.count >= 2, true)
    note(`providers: ${providers.names.join(', ')} (${providers.count})`)

    console.log('\n── detection: a URL, a Windows path, a bare IP, and a Jira key ──')
    const detected = await evaluate(`
        const { xterm, core } = window.__T
        xterm.clear()
        xterm.write('\\r\\nsee https://example.com/a,b and 10.0.0.7 and C:\\\\\\\\Windows\\\\\\\\notepad.exe CAB-8209 done\\r\\n')
        await new Promise(r => setTimeout(r, 400))
        const buffer = xterm.buffer.active
        // Find the row we just wrote.
        let row = -1
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i)
            if (line && line.translateToString(true).includes('example.com')) { row = i; break }
        }
        if (row === -1) { return { error: 'text not found in buffer' } }
        const ours = core._linkProviderService.linkProviders[1]
        const links = await new Promise(resolve => ours.provideLinks(row + 1, resolve))
        window.__T.row = row
        window.__T.links = links
        return {
            row,
            texts: (links || []).map(l => l.text),
        }
    `)
    if (detected.error) {
        console.log(`  FAIL setup: ${detected.error}`)
        failed++
    } else {
        note(`matched: ${detected.texts.join('  |  ')}`)
        check('the URL is detected', detected.texts.some(t => t.startsWith('https://example.com')), true)
        // These two are the upstream regression: addon-web-links' isUrl() filter
        // drops anything that is not a parseable URL.
        check('a bare IP is detected (broken upstream)', detected.texts.some(t => t === '10.0.0.7'), true)
        check('a Windows path is detected (broken upstream)', detected.texts.some(t => t.includes('notepad.exe')), true)
        check('the Jira key is detected by the text rule', detected.texts.includes('CAB-8209'), true)
    }

    console.log('\n── hovering shows a card, inside the window ──')
    const card = await evaluate(`
        const { links } = window.__T
        const link = links.find(l => l.text.startsWith('https://example.com'))
        link.hover()
        await new Promise(r => setTimeout(r, 900))
        const el = document.querySelector('link-hover-card')
        const box = el.getBoundingClientRect()
        const cmp = window.ng.getComponent(el)
        return {
            visible: getComputedStyle(el).display !== 'none' && box.width > 0,
            text: cmp.model.text,
            hint: cmp.model.hint,
            buttons: [...el.querySelectorAll('button')].map(b => b.textContent.trim()),
            box: { top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) },
            insideWindow: box.left >= 0 && box.top >= 0
                && box.right <= window.innerWidth + 1 && box.bottom <= window.innerHeight + 1,
            maxWidth: getComputedStyle(el.querySelector('.link-card')).maxWidth,
        }
    `)
    check('the card is visible', card.visible, true)
    check('it names the link', card.text, 'https://example.com/a,b')
    check('it shows the follow hint', card.hint.length > 0, true)
    check('Open and Copy link are offered', card.buttons.filter(b => b === 'Open' || b === 'Copy link').length, 2)
    check('no Copy path for a URL', card.buttons.includes('Copy path'), false)
    check('the card is fully inside the window', card.insideWindow, true)
    check('the configured max width is applied', card.maxWidth, '640px')
    note(`box: ${JSON.stringify(card.box)}  buttons: ${card.buttons.join(', ')}`)

    console.log('\n── a file path offers Copy path and Show in folder ──')
    const fileCard = await evaluate(`
        const { links } = window.__T
        const link = links.find(l => l.text.includes('notepad.exe'))
        if (!link) { return { skipped: true } }
        link.hover()
        await new Promise(r => setTimeout(r, 900))
        const el = document.querySelector('link-hover-card')
        const cmp = window.ng.getComponent(el)
        return {
            text: cmp.model.text,
            showCopyPath: cmp.model.showCopyPath,
            showReveal: cmp.model.showReveal,
            buttons: [...el.querySelectorAll('button')].map(b => b.textContent.trim()),
        }
    `)
    if (fileCard.skipped) {
        note('skipped: no file link matched')
    } else {
        check('Copy path is offered for a real file', fileCard.showCopyPath, true)
        check('Show in folder is offered for a real file', fileCard.showReveal, true)
        note(`buttons: ${fileCard.buttons.join(', ')}`)
    }

    console.log('\n── the card flips near the bottom edge and stays on screen ──')
    const flip = await evaluate(`
        const { xterm, core } = window.__T
        const rows = xterm.rows
        xterm.write('\\r\\n'.repeat(rows) + 'tail https://example.com/bottom-edge\\r\\n')
        await new Promise(r => setTimeout(r, 500))
        const buffer = xterm.buffer.active
        let row = -1
        for (let i = buffer.length - 1; i >= 0; i--) {
            const line = buffer.getLine(i)
            if (line && line.translateToString(true).includes('bottom-edge')) { row = i; break }
        }
        const ours = core._linkProviderService.linkProviders[1]
        const links = await new Promise(resolve => ours.provideLinks(row + 1, resolve))
        const link = (links || []).find(l => l.text.includes('bottom-edge'))
        if (!link) { return { skipped: true } }
        link.hover()
        await new Promise(r => setTimeout(r, 900))
        const el = document.querySelector('link-hover-card')
        const box = el.getBoundingClientRect()
        const screenBox = core.screenElement.getBoundingClientRect()
        return {
            box: { top: Math.round(box.top), bottom: Math.round(box.bottom) },
            screenBottom: Math.round(screenBox.bottom),
            windowHeight: window.innerHeight,
            insideWindow: box.top >= 0 && box.bottom <= window.innerHeight + 1,
        }
    `)
    if (flip.skipped) {
        note('skipped: link at the bottom edge not matched')
    } else {
        check('still fully on screen at the bottom edge', flip.insideWindow, true)
        note(`card ${JSON.stringify(flip.box)}, window height ${flip.windowHeight}, screen bottom ${flip.screenBottom}`)
    }

    console.log('\n── the card does not rebuild while output scrolls past ──')
    const stability = await evaluate(`
        const { links } = window.__T
        const link = links.find(l => l.text.startsWith('https://example.com'))
        link.hover()
        await new Promise(r => setTimeout(r, 700))
        const el = document.querySelector('link-hover-card')
        const before = window.ng.getComponent(el)
        let rebuilds = 0
        for (let i = 0; i < 30; i++) {
            link.hover()
            const now = window.ng.getComponent(document.querySelector('link-hover-card'))
            if (now !== before) { rebuilds++ }
        }
        return { rebuilds }
    `)
    check('repeat hovers of the same link do not rebuild the card', stability.rebuilds, 0)

    await close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
