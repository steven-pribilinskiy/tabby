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

    // The card was only ever guaranteed to stay inside the *window*. In a split
    // it could still cover the pane next door, because `linkTooltip.maxWidth`
    // (640px) knows nothing about how the window is divided — so a card wider
    // than its pane overflowed however the placement clamp worked out. Every
    // check here is measured against `.xterm-screen`, the hovered pane's own
    // grid, and each one reports what the old window-bounded placement would
    // have done with the same numbers: that is the part that used to fail.
    console.log('\n── a narrow split pane confines the card, on both axes ──')
    const split = await evaluate(`
        const { root, tab, core } = window.__T
        const parent = root.app.tabs.find(t => t.getAllTabs && t.getAllTabs().includes(tab))
        if (!parent || !parent.splitTab) { return { skipped: 'the terminal is not in a split host' } }

        // A pane on two inner edges: neither its right edge nor its bottom edge
        // is the window's, which is the whole point.
        const right = await parent.splitTab(tab, 'r')
        const below = await parent.splitTab(tab, 'b')
        window.__T.spawned = [right, below].filter(x => x)
        // Half a window is still wider than a 640px card here, so squeeze it.
        const vertical = parent.getParentOf(tab)
        const horizontal = vertical ? parent.getParentOf(vertical) : null
        if (vertical) { vertical.ratios = [0.42, 0.58] }
        if (horizontal) { horizontal.ratios = [0.26, 0.74] }
        parent.layout()
        await new Promise(r => setTimeout(r, 1500))
        window.ng.applyChanges(root)

        // Hover a long URI written at \`mode\` and report where the card landed,
        // beside where the pre-change placement would have put it.
        window.__T.probe = async (marker, mode) => {
            const { xterm, core } = window.__T
            const uri = 'https://example.com/' + marker + '/' + 'segment/'.repeat(12) + 'tail'
            const pad = mode === 'right' ? Math.max(0, xterm.cols - 6) : 0
            const lead = mode === 'bottom' ? '\\r\\n'.repeat(xterm.rows) : '\\r\\n'
            xterm.write(lead + ' '.repeat(pad) + uri + '\\r\\n')
            await new Promise(r => setTimeout(r, 400))
            const buffer = xterm.buffer.active
            let row = -1
            for (let i = buffer.length - 1; i >= 0; i--) {
                const line = buffer.getLine(i)
                if (line && line.translateToString(true).includes(marker)) { row = i; break }
            }
            if (row === -1) { return { error: 'not written: ' + marker } }
            const ours = core._linkProviderService.linkProviders[1]
            const links = await new Promise(resolve => ours.provideLinks(row + 1, resolve))
            const link = (links || []).find(l => l.text.includes(marker))
            if (!link) { return { error: 'not detected: ' + marker } }
            link.hover()
            await new Promise(r => setTimeout(r, 900))

            const el = core.screenElement.querySelector('link-hover-card')
            const box = el.getBoundingClientRect()
            const pane = core.screenElement.getBoundingClientRect()

            // What the old code produced: no width cap, and both clamps taken
            // against the window. Measured, not assumed — the card is widened
            // back to the configured 640px to find the size it would have been.
            const capped = el.style.getPropertyValue('--link-card-max-width')
            el.style.setProperty('--link-card-max-width', '640px')
            const uncapped = el.getBoundingClientRect()
            el.style.setProperty('--link-card-max-width', capped)

            const cell = core._renderService.dimensions.css.cell
            const cellLeft = pane.left + (link.range.start.x - 1) * cell.width
            const viewportY = xterm.buffer.active.viewportY || 0
            const cellTop = pane.top + (link.range.start.y - 1 - viewportY) * cell.height
            const m = 6
            const oldMaxX = Math.max(m, window.innerWidth - uncapped.width - m)
            const oldMaxY = Math.max(m, window.innerHeight - uncapped.height - m)
            let oldX = cellLeft
            let oldY = cellTop + cell.height + 2
            if (oldY > oldMaxY) { oldY = cellTop - uncapped.height - 2 }
            if (oldX > oldMaxX) { oldX = cellLeft + cell.width - uncapped.width }
            oldX = Math.min(Math.max(oldX, m), oldMaxX)
            oldY = Math.min(Math.max(oldY, m), oldMaxY)

            const r = n => Math.round(n)
            return {
                card: { left: r(box.left), top: r(box.top), right: r(box.right), bottom: r(box.bottom), width: r(box.width) },
                pane: { left: r(pane.left), top: r(pane.top), right: r(pane.right), bottom: r(pane.bottom), width: r(pane.width) },
                insidePane: box.left >= pane.left - 1 && box.right <= pane.right + 1
                    && box.top >= pane.top - 1 && box.bottom <= pane.bottom + 1,
                wasInsidePane: oldX >= pane.left - 1 && oldX + uncapped.width <= pane.right + 1
                    && oldY >= pane.top - 1 && oldY + uncapped.height <= pane.bottom + 1,
                oldOverflowRight: r(Math.max(0, oldX + uncapped.width - pane.right)),
                oldOverflowBottom: r(Math.max(0, oldY + uncapped.height - pane.bottom)),
                oldWidth: r(uncapped.width),
            }
        }
        const pane = core.screenElement.getBoundingClientRect()
        return { paneWidth: Math.round(pane.width), paneHeight: Math.round(pane.height), windowWidth: window.innerWidth }
    `)
    if (split.skipped) {
        note(`skipped: ${split.skipped}`)
    } else {
        note(`pane ${split.paneWidth}x${split.paneHeight} in a ${split.windowWidth}px window`)
        check('the pane is narrower than the configured max width, so this is the case that overflowed',
            split.paneWidth < 640, true)

        for (const [marker, mode] of [['right-edge', 'right'], ['left-edge', 'left'], ['bottom-edge', 'bottom']]) {
            const probe = await evaluate(`return window.__T.probe('${marker}', '${mode}')`)
            if (probe.error) {
                console.log(`  FAIL ${marker}: ${probe.error}`)
                failed++
                continue
            }
            check(`${marker}: the card stays inside the pane`, probe.insidePane, true)
            check(`${marker}: the old window-bounded placement did not`, probe.wasInsidePane, false)
            note(`card ${JSON.stringify(probe.card)} in pane ${JSON.stringify(probe.pane)}`)
            note(`old: ${probe.oldWidth}px wide, ${probe.oldOverflowRight}px past the right edge, ${probe.oldOverflowBottom}px past the bottom`)
        }
    }

    // Put the tab back the way it was found: this profile is reused.
    await evaluate(`
        for (const t of window.__T.spawned || []) { t.destroy() }
        await new Promise(r => setTimeout(r, 500))
        window.ng.applyChanges(window.__T.root)
    `)

    await close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
