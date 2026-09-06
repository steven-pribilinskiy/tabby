// The table view: its own placeholder, a width that fits, and a path that says
// what clicking it does.
//
//   node scripts/dev/launch-hidden.mjs --enable builds &
//   node tabby-builds/test/tableView.cdp.js
//
// All three were reported from a screenshot: card skeletons stacked above the
// table's own header row, a grey bar under the table that was its permanent
// horizontal scrollbar, and a path that looked like a link but copied itself.
const { closeAll, connect } = require('./cdp')

function ok (message) { console.log(`ok    ${message}`) }
function fail (message) { console.error(`FAIL  ${message}`); process.exitCode = 1 }

const OPEN = `
    const root = window.ng.getComponent(document.querySelector('app-root'))
    const settings = window['nodeRequire']('tabby-settings')
    root.app.openNewTabRaw({ type: settings.SettingsTabComponent, inputs: { activeTab: 'builds' } })
    let link = null
    for (let i = 0; i < 60 && !link; i++) {
        await new Promise(r => setTimeout(r, 250))
        link = [...document.querySelectorAll('.nav-link')].find(e => e.textContent.trim() === 'Builds')
    }
    if (!link) { throw new Error('no Builds item in the settings nav') }
    link.click()
    for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500))
        if (document.querySelector('.build-card:not(.skeleton)')) { break }
    }
    window.__B = window.ng.getComponent(document.querySelector('builds-settings-tab'))
    return window.__B.builds.length
`

// The real loading state lasts about a second, so it is staged rather than
// waited for: what is under test is what gets drawn while scanning, not how
// long that takes.
const SKELETON = `
    const c = window.__B
    c.setView('table')
    const builds = c.builds, visible = c.visible
    c.builds = []; c.visible = []; c.scanning = true
    window.ng.applyChanges(c)
    await new Promise(r => setTimeout(r, 200))
    const header = document.querySelector('.builds-table thead')
    const first = document.querySelector('.builds-table .skeleton-row')
    const result = {
        rows: document.querySelectorAll('.builds-table .skeleton-row').length,
        cards: document.querySelectorAll('.build-card.skeleton').length,
        belowHeader: !!(header && first) && first.getBoundingClientRect().top > header.getBoundingClientRect().top,
    }
    c.builds = builds; c.visible = visible; c.scanning = false
    window.ng.applyChanges(c)
    return result
`

const FITS = `
    const c = window.__B
    c.setView('table')
    window.ng.applyChanges(c)
    await new Promise(r => setTimeout(r, 300))
    const wrap = document.querySelector('.table-wrap')
    const text = document.querySelector('.path-cell .path-text')
    return {
        overflow: wrap.scrollWidth - wrap.clientWidth,
        truncates: text ? text.scrollWidth > text.clientWidth : null,
    }
`

const TOOLTIP = `
    const cell = document.querySelector('.path-cell')
    cell.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await new Promise(r => setTimeout(r, 400))
    const tip = document.querySelector('.builds-path-tooltip .tooltip-inner')
    const result = {
        text: tip && tip.textContent,
        whiteSpace: tip && getComputedStyle(tip).whiteSpace,
        root: window.__B.visible[0].root,
    }
    cell.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    return result
`

// reveal() opens a file manager window, which would take focus. The wiring is
// what is under test, so it is stubbed out.
const CLICK = `
    const c = window.__B
    const real = c.actions.reveal
    const seen = []
    c.actions.reveal = b => seen.push(b.root)
    document.querySelector('.path-cell').click()
    c.actions.reveal = real
    return seen
`

async function main () {
    const cdp = await connect()
    const builds = await cdp.evaluate(OPEN)
    if (!builds) {
        fail('no builds were found — the rest of this test proves nothing')
        cdp.close()
        return
    }
    ok(`the page listed ${builds} builds`)

    const skeleton = await cdp.evaluate(SKELETON)
    if (skeleton.rows && !skeleton.cards && skeleton.belowHeader) {
        ok(`while scanning, the table draws ${skeleton.rows} skeleton rows under its own header and no cards`)
    } else {
        fail(`wrong placeholder for the table view: ${JSON.stringify(skeleton)}`)
    }

    const fits = await cdp.evaluate(FITS)
    if (fits.overflow <= 1) {
        ok(`the table fits its container (${fits.overflow}px over), so there is no permanent scrollbar`)
    } else {
        fail(`the table is ${fits.overflow}px wider than its container`)
    }
    if (fits.truncates) {
        ok('the path cell truncates rather than widening the table')
    } else {
        fail('the path cell is not truncating — a long path will widen the table again')
    }

    const tooltip = await cdp.evaluate(TOOLTIP)
    if (tooltip.text?.includes(tooltip.root) && /open/i.test(tooltip.text) && tooltip.whiteSpace === 'pre-line') {
        ok(`the path tooltip carries both lines: ${JSON.stringify(tooltip.text)}`)
    } else {
        fail(`the path tooltip is wrong: ${JSON.stringify(tooltip)}`)
    }

    const clicked = await cdp.evaluate(CLICK)
    if (clicked.length === 1) {
        ok(`clicking a path opens its folder (${clicked[0]})`)
    } else {
        fail(`clicking a path called reveal ${clicked.length} times`)
    }

    cdp.close()
}

// Reports by exit code rather than exiting, so the socket has to go with it or
// a failure leaves the process alive.
main().catch(err => {
    console.error(err)
    process.exitCode = 1
}).finally(closeAll)
