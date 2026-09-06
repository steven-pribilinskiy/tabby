// Click chords, driven with real mouse events against a real terminal.
//
// Everything here goes through xterm's own Linkifier — a mousemove to make it
// ask for links, a mousedown, a mouseup — because the parts that are easy to get
// wrong live exactly there: which listener sees the press, whether a drag counts
// as a click, and whether a gesture reaches the terminal underneath. Calling the
// decorator's callbacks directly would prove none of it.
//
//   node scripts/dev/launch-hidden.mjs --enable links,linkifier
//   node tabby-links/test/clicks.cdp.js
//
// `terminal.rightClick` and `terminal.pasteOnMiddleClick` are turned off for the
// run and put back afterwards. Both are Tabby's own mouse features, both fire on
// the same presses as a chord, and one of them pastes the real clipboard into
// the terminal — which is not something a test may do to a machine.
const { connect, closeAll } = require('./cdp')

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

/**
 * Find a terminal, take over the two things a click ends in, and expose the
 * helpers every case below uses.
 *
 * `decorator.actions` and each handler's `handle` are replaced rather than
 * observed because the real ones open a browser and reach the clipboard. They
 * are the seam every action id converges on, so recording there says which
 * action ran without saying anything about how it was dispatched.
 */
const SETUP = `
    const cmp = ${ROOT}
    const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const term = all.find(t => t.frontend && t.frontend.xterm)
    if (!term) { throw new Error('no terminal tab with an xterm') }
    const parent = cmp.app.tabs.find(t => t.getAllTabs && t.getAllTabs().includes(term)) || term
    cmp.app.selectTab(parent)
    await new Promise(r => setTimeout(r, 700))
    window.ng.applyChanges(cmp)

    const decorator = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator')
    if (!decorator) { throw new Error('LinkTooltipDecorator not attached — launch with --enable links,linkifier') }

    const T = window.__T = {
        root: cmp,
        tab: term,
        xterm: term.frontend.xterm,
        core: term.frontend.xterm._core,
        decorator,
        config: decorator.config,
        clicks: decorator.clicks,
        calls: [],
        reachedXterm: [],
    }

    T.realActions = decorator.actions
    decorator.actions = {
        open: (uri, filePath) => { T.calls.push(['open', uri || filePath]); return Promise.resolve() },
        copy: text => T.calls.push(['copy', text]),
        reveal: filePath => T.calls.push(['reveal', filePath]),
        runCustom: (action, uri) => { T.calls.push(['custom', action.name, uri]); return Promise.resolve() },
    }
    T.realHandles = (decorator.handlers || []).map(h => h.handle)
    for (const handler of decorator.handlers || []) {
        handler.handle = uri => T.calls.push(['open', uri])
    }

    // Whether a press got past .xterm-screen at all. Tabby's middle-click paste
    // and xterm's own selection both listen on ancestors of it, so "the paste
    // never runs" is exactly "this never fired" — a reading of the mechanism
    // rather than of its effect. On .xterm, the nearest ancestor: the terminal
    // stops a middle press itself at the frontend host, so a probe on document
    // would record nothing either way and prove nothing.
    T.probe = event => T.reachedXterm.push(event.button)
    T.core.element.addEventListener('mousedown', T.probe)

    const store = T.config.store
    T.saved = {
        linkTooltip: {
            clickable: store.linkTooltip.clickable,
            clickableKinds: [...(store.linkTooltip.clickableKinds || [])],
            primaryClickModifier: store.linkTooltip.primaryClickModifier,
            primaryClickGesture: store.linkTooltip.primaryClickGesture,
            primaryAction: store.linkTooltip.primaryAction,
            alternativeClickModifier: store.linkTooltip.alternativeClickModifier,
            alternativeClickGesture: store.linkTooltip.alternativeClickGesture,
            alternativeAction: store.linkTooltip.alternativeAction,
        },
        rules: [...(store.linkTooltip.rules || [])],
        legacyModifier: store.clickableLinks ? store.clickableLinks.modifier : null,
        rightClick: store.terminal.rightClick,
        pasteOnMiddleClick: store.terminal.pasteOnMiddleClick,
    }
    store.terminal.rightClick = 'off'
    store.terminal.pasteOnMiddleClick = false

    // No save() between cases: writing config.yaml on every one would be slow
    // and would race the file watcher. Everything reads config.store directly.
    T.setChords = patch => Object.assign(store.linkTooltip, patch)
    T.resetChords = () => T.setChords({
        clickable: true,
        clickableKinds: ['detected', 'rules', 'osc8'],
        primaryClickModifier: 'none',
        primaryClickGesture: 'left',
        primaryAction: 'open',
        alternativeClickModifier: 'ctrl',
        alternativeClickGesture: 'left',
        alternativeAction: 'open',
    })

    // A link's cell, in client pixels. Ranges are absolute buffer rows, 1-based,
    // which is what xterm's own Linkifier compares a pointer against.
    T.pointAt = (link, column) => {
        const rect = T.core.screenElement.getBoundingClientRect()
        const cell = T.core._renderService.dimensions.css.cell
        const row = link.range.start.y - 1 - T.xterm.buffer.active.viewportY
        const col = (column === undefined ? link.range.start.x : column) - 1
        return {
            clientX: Math.round(rect.left + (col + 0.5) * cell.width),
            clientY: Math.round(rect.top + (row + 0.5) * cell.height),
        }
    }

    T.fire = (type, point, options = {}) => {
        const event = new MouseEvent(type, Object.assign({
            bubbles: true, cancelable: true, view: window,
            button: 0, buttons: 1, detail: 1,
            clientX: point.clientX, clientY: point.clientY,
        }, options))
        T.core.screenElement.dispatchEvent(event)
        return event
    }

    T.clearSelection = () => { try { T.xterm.clearSelection() } catch {} }

    /**
     * Hover a link the way a pointer does, so xterm adopts it as currentLink.
     * Away first — column 1 of the same row, which is never a link here —
     * because the Linkifier only re-asks when the cell under the pointer changes.
     */
    T.hover = async (link, column) => {
        T.fire('mousemove', T.pointAt(link, 1), { buttons: 0 })
        const point = T.pointAt(link, column)
        T.fire('mousemove', point, { buttons: 0 })
        await new Promise(r => setTimeout(r, 60))
        return point
    }

    /**
     * Press and release on the same cell — a click, not a drag.
     *
     * The card is hidden first because it is deliberately never rebuilt while it
     * is open, and the settings it was built from are what a click on it uses. A
     * case that changes a rule and clicks again would otherwise measure the
     * previous case's answer, which is exactly what a person does *not* do: they
     * move the pointer away and back.
     */
    T.click = async (link, options = {}) => {
        T.calls.length = 0
        T.reachedXterm.length = 0
        T.clearSelection()
        T.decorator.hide(T.decorator.states.get(T.tab))
        const point = await T.hover(link)
        const selectionBefore = T.xterm.hasSelection()
        const down = T.fire('mousedown', point, options)
        await new Promise(r => setTimeout(r, 20))
        const up = T.fire('mouseup', point, Object.assign({ buttons: 0 }, options))
        await new Promise(r => setTimeout(r, 150))
        return {
            calls: [...T.calls],
            downPrevented: down.defaultPrevented,
            upPrevented: up.defaultPrevented,
            reachedXterm: [...T.reachedXterm],
            selectionBefore,
            selectionAfter: T.xterm.hasSelection(),
        }
    }

    /** The card is never rebuilt while it is open, so a re-read has to hide it. */
    T.rehover = async link => {
        T.decorator.hide(T.decorator.states.get(T.tab))
        await T.hover(link)
        await new Promise(r => setTimeout(r, 900))
        const el = document.querySelector('link-hover-card')
        return {
            model: window.ng.getComponent(el).model,
            shown: getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0,
        }
    }
`

/** Write a line and hand back the links our provider finds on it. */
const WRITE = (text, marker) => `
    {
        const T = window.__T
        T.clearSelection()
        T.xterm.write('\\r\\n' + ${JSON.stringify(text)} + '\\r\\n')
        await new Promise(r => setTimeout(r, 300))
        const buffer = T.xterm.buffer.active
        let row = -1
        for (let i = buffer.length - 1; i >= 0; i--) {
            const line = buffer.getLine(i)
            if (line && line.translateToString(true).includes(${JSON.stringify(marker)})) { row = i; break }
        }
        if (row === -1) { throw new Error('written line not found in the buffer') }
        const ours = T.core._linkProviderService.linkProviders[1]
        T.links = await new Promise(resolve => ours.provideLinks(row + 1, resolve))
        if (!T.links) { throw new Error('the provider found nothing on the line') }
    }
`

const URL = 'https://example.com/a-fairly-long-path-to-drag-across'

async function main () {
    const { evaluate } = await connect()

    console.log('\n── setup ──')
    const ready = await evaluate(`
        ${SETUP}
        ${WRITE(`see ${URL} done`, 'a-fairly-long-path')}
        T.resetChords()
        T.link = T.links.find(l => l.text.startsWith('https://example.com'))
        return { texts: T.links.map(l => l.text), found: !!T.link, range: T.link && T.link.range, saved: T.saved }
    `)
    check('the URL is detected', ready.found, true)
    note(`range: ${JSON.stringify(ready.range)}`)
    note(`saved for restore: ${JSON.stringify({ legacy: ready.saved.legacyModifier, rightClick: ready.saved.rightClick })}`)

    console.log('\n── each gesture fires its chord ──')
    const plain = await evaluate('return window.__T.click(window.__T.link)')
    check('a plain left click runs the primary action', plain.calls, [['open', URL]])

    const ctrl = await evaluate('return window.__T.click(window.__T.link, { ctrlKey: true })')
    check('ctrl+click runs the alternative', ctrl.calls, [['open', URL]])

    const middleOff = await evaluate('return window.__T.click(window.__T.link, { button: 1, buttons: 4 })')
    check('a middle click does nothing while no chord asks for one', middleOff.calls, [])
    check('and its press is left alone for the terminal underneath', middleOff.reachedXterm, [1])

    const middle = await evaluate(`
        const T = window.__T
        T.setChords({ primaryClickModifier: 'none', primaryClickGesture: 'middle', alternativeAction: 'none' })
        const result = await T.click(T.link, { button: 1, buttons: 4 })
        T.resetChords()
        return result
    `)
    check('a middle click runs a middle chord', middle.calls, [['open', URL]])
    // On the press, not the release: the terminal pastes on a middle mousedown,
    // and the only way to be ahead of that is to consume the same event.
    check('the middle press is consumed', middle.downPrevented, true)
    check('and never gets past .xterm-screen, where the paste listens', middle.reachedXterm, [])

    const double = await evaluate(`
        const T = window.__T
        T.setChords({ primaryAction: 'none', alternativeClickModifier: 'none', alternativeClickGesture: 'double' })
        T.calls.length = 0
        T.clearSelection()
        const point = await T.hover(T.link)
        T.fire('mousedown', point, { detail: 1 })
        T.fire('mouseup', point, { detail: 1, buttons: 0 })
        await new Promise(r => setTimeout(r, 20))
        const down = T.fire('mousedown', point, { detail: 2 })
        T.fire('mouseup', point, { detail: 2, buttons: 0 })
        await new Promise(r => setTimeout(r, 200))
        const result = { calls: [...T.calls], downPrevented: down.defaultPrevented }
        T.resetChords()
        T.clearSelection()
        return result
    `)
    // Resolved on the press, because the same press selects a word — waiting for
    // the release would mean the drag guard finding that selection and refusing.
    check('a double click runs a double chord', double.calls, [['open', URL]])
    check('the second press is consumed', double.downPrevented, true)

    console.log('\n── modifiers are matched exactly ──')
    const ctrlShift = await evaluate('return window.__T.click(window.__T.link, { ctrlKey: true, shiftKey: true })')
    check('ctrl+shift does not satisfy the plain-ctrl alternative', ctrlShift.calls, [])

    const altClick = await evaluate('return window.__T.click(window.__T.link, { altKey: true })')
    check('alt+click satisfies neither default chord', altClick.calls, [])

    const exact = await evaluate(`
        const T = window.__T
        T.setChords({ primaryAction: 'none', alternativeClickModifier: 'ctrlShift' })
        const hit = await T.click(T.link, { ctrlKey: true, shiftKey: true })
        const miss = await T.click(T.link, { ctrlKey: true })
        T.resetChords()
        T.clearSelection()
        return { hit: hit.calls, miss: miss.calls }
    `)
    check('a ctrlShift chord fires on ctrl+shift', exact.hit, [['open', URL]])
    check('and not on ctrl alone', exact.miss, [])

    console.log('\n── dragging across a link selects it, and does not open it ──')
    const drag = await evaluate(`
        const T = window.__T
        T.calls.length = 0
        T.clearSelection()
        const start = await T.hover(T.link, T.link.range.start.x + 2)
        T.fire('mousedown', start)
        // Through the middle, the way a hand does it — each move is what xterm's
        // SelectionService extends the selection on.
        for (const column of [6, 9, 12, 14]) {
            T.fire('mousemove', T.pointAt(T.link, T.link.range.start.x + column))
            await new Promise(r => setTimeout(r, 10))
        }
        const end = T.pointAt(T.link, T.link.range.start.x + 14)
        T.fire('mouseup', end, { buttons: 0 })
        await new Promise(r => setTimeout(r, 150))
        const result = { calls: [...T.calls], selection: T.xterm.getSelection(), hasSelection: T.xterm.hasSelection() }
        T.clearSelection()
        return result
    `)
    check('the drag made a selection', drag.hasSelection, true)
    check('and nothing was opened', drag.calls, [])
    note(`selected: ${JSON.stringify(drag.selection)}`)

    // The release still lands inside the link, so xterm calls `activate` — the
    // guard is ours, and this is the case that proves it does the work.
    const shortDrag = await evaluate(`
        const T = window.__T
        T.calls.length = 0
        T.clearSelection()
        const start = await T.hover(T.link, T.link.range.start.x + 2)
        T.fire('mousedown', start)
        const end = T.pointAt(T.link, T.link.range.start.x + 5)
        T.fire('mousemove', end)
        await new Promise(r => setTimeout(r, 10))
        T.fire('mouseup', end, { buttons: 0 })
        await new Promise(r => setTimeout(r, 150))
        const result = { calls: [...T.calls], hasSelection: T.xterm.hasSelection() }
        T.clearSelection()
        return result
    `)
    check('a three-cell drag inside the link still selects rather than opens',
        [shortDrag.hasSelection, shortDrag.calls], [true, []])

    const afterDrag = await evaluate('return window.__T.click(window.__T.link)')
    check('a plain click straight after a drag still opens', afterDrag.calls, [['open', URL]])
    note(`selection at the press: ${afterDrag.selectionBefore}, at the release: ${afterDrag.selectionAfter}`)

    console.log('\n── which kinds a click reaches ──')
    const kinds = await evaluate(`
        const T = window.__T
        T.setChords({ clickableKinds: ['rules', 'osc8'] })
        const clicked = await T.click(T.link)
        const card = await T.rehover(T.link)
        T.resetChords()
        return { calls: clicked.calls, shown: card.shown, text: card.model.text, hint: card.model.hint }
    `)
    check('with "detected" unticked, a detected link does not respond to a click', kinds.calls, [])
    check('but it still hovers and previews', [kinds.shown, kinds.text], [true, URL])
    check('and the card stops promising a click that does nothing', kinds.hint, '')

    const off = await evaluate(`
        const T = window.__T
        T.setChords({ clickable: false })
        const clicked = await T.click(T.link)
        const card = await T.rehover(T.link)
        T.resetChords()
        return { calls: clicked.calls, shown: card.shown, hint: card.model.hint }
    `)
    check('with clicking off entirely, nothing happens on a click', off.calls, [])
    check('the card is still shown', off.shown, true)
    check('with no hint', off.hint, '')

    const backOn = await evaluate('return window.__T.click(window.__T.link)')
    check('turning it back on restores the click, with no re-attach', backOn.calls, [['open', URL]])

    console.log('\n── the hint names the chord that follows the link ──')
    const hints = await evaluate(`
        const T = window.__T
        const read = async () => (await T.rehover(T.link)).model.hint
        const plain = await read()
        T.setChords({ primaryAction: 'none' })
        const viaAlternative = await read()
        T.setChords({ primaryClickModifier: 'alt', primaryClickGesture: 'middle', primaryAction: 'open', alternativeAction: 'none' })
        const middle = await read()
        T.setChords({ primaryAction: 'copyLink', alternativeAction: 'copyLink' })
        const neither = await read()
        T.resetChords()
        return { plain, viaAlternative, middle, neither }
    `)
    check('a plain-click primary reads as "Click"', hints.plain, 'Click to follow link')
    check('when only the alternative opens, it names that one', hints.viaAlternative, 'Ctrl+Click to follow link')
    check('a rebound chord is described as configured', hints.middle, 'Alt+Middle-click to follow link')
    check('when nothing opens, there is no hint', hints.neither, '')

    console.log('\n── a rule overrides what each chord runs ──')
    const rule = await evaluate(`
        const T = window.__T
        const store = T.config.store
        const made = {
            name: 'chord test', enabled: true, match: 'link',
            schemes: [], pattern: 'a-fairly-long-path', fileTypeGroup: 'none', extensions: [],
            integration: 'none', preview: false,
            showDelay: null, hideDelay: null, maxWidth: null,
            suppressOpen: false, suppressCopyLink: false, suppressCopyPath: false, suppressReveal: false,
            primaryAction: 'copyLink', alternativeAction: 'none',
            actions: [{ name: 'Ping', icon: '', type: 'sendInput', value: 'ping %u' }],
        }
        store.linkTooltip.rules = [made]

        const override = await T.click(T.link)
        const suppressed = await T.click(T.link, { ctrlKey: true })
        made.primaryAction = ''
        const inherited = await T.click(T.link)
        made.primaryAction = 'Ping'
        const custom = await T.click(T.link)
        made.primaryAction = 'copyPath'
        const noPath = await T.click(T.link)

        // Hiding the card's buttons must not silently unbind a chord that names
        // one of them.
        made.primaryAction = 'Ping'
        const savedShowButtons = store.linkTooltip.showButtons
        store.linkTooltip.showButtons = false
        const buttonsHidden = await T.click(T.link)
        store.linkTooltip.showButtons = savedShowButtons

        store.linkTooltip.rules = T.saved.rules
        return {
            override: override.calls,
            suppressed: suppressed.calls,
            inherited: inherited.calls,
            custom: custom.calls,
            noPath: noPath.calls,
            buttonsHidden: buttonsHidden.calls,
        }
    `)
    check("a rule's primaryAction replaces the global one", rule.override, [['copy', URL]])
    check('"none" suppresses that chord for this rule only', rule.suppressed, [])
    check('"" inherits the global action again', rule.inherited, [['open', URL]])
    check("a chord can run one of the rule's own custom actions", rule.custom, [['custom', 'Ping', URL]])
    check('an action needing a path does nothing when a URL has none', rule.noPath, [])
    check('and it still runs with the card\'s buttons turned off',
        rule.buttonsHidden, [['custom', 'Ping', URL]])

    console.log('\n── a rule-matched run is a different kind ──')
    // Its own rule rather than whatever the profile happens to hold: a `text`
    // match is the only way to produce the `rules` kind, and a suite that
    // depends on a Jira integration being configured proves nothing on a
    // machine where it is not.
    const text = await evaluate(`
        const T = window.__T
        const store = T.config.store
        store.linkTooltip.rules = [{
            name: 'ticket keys', enabled: true, match: 'text',
            schemes: [], pattern: 'CAB-[0-9]+', fileTypeGroup: 'none', extensions: [],
            integration: 'none', preview: false,
            showDelay: null, hideDelay: null, maxWidth: null,
            suppressOpen: false, suppressCopyLink: false, suppressCopyPath: false, suppressReveal: false,
            primaryAction: 'copyLink', alternativeAction: '',
            actions: [],
        }]
        ${WRITE('ticket CAB-8209 filed', 'CAB-8209')}
        const link = T.links.find(l => l.text === 'CAB-8209')
        if (!link) { store.linkTooltip.rules = T.saved.rules; return { skipped: true } }
        const withRules = await T.click(link)
        T.setChords({ clickableKinds: ['detected', 'osc8'] })
        const without = await T.click(link)
        T.resetChords()
        store.linkTooltip.rules = T.saved.rules
        return { withRules: withRules.calls, without: without.calls }
    `)
    if (text.skipped) {
        note('skipped: the text rule produced no match')
        failed++
    } else {
        check('a text match is clickable while "rules" is ticked, and runs its rule\'s action',
            text.withRules, [['copy', 'CAB-8209']])
        check('and stops responding when "rules" is unticked', text.without, [])
    }

    console.log('\n── an existing clickableLinks.modifier is migrated, not dropped ──')
    const migration = await evaluate(`
        const T = window.__T
        const store = T.config.store
        // Back to the shipped defaults first, so what the migration writes is
        // visible rather than being what was already there.
        T.resetChords()
        store.clickableLinks.modifier = 'ctrlKey'
        const ran = T.clicks.migrateLegacyModifier()
        return {
            ran,
            primaryClickModifier: store.linkTooltip.primaryClickModifier,
            primaryClickGesture: store.linkTooltip.primaryClickGesture,
            primaryAction: store.linkTooltip.primaryAction,
            alternativeAction: store.linkTooltip.alternativeAction,
            legacy: store.clickableLinks.modifier,
            // Twice is a no-op: the key it reads is the key it clears.
            again: T.clicks.migrateLegacyModifier(),
        }
    `)
    check('the migration reports that it ran', migration.ran, true)
    check('the modifier moves onto the primary chord',
        [migration.primaryClickModifier, migration.primaryClickGesture, migration.primaryAction],
        ['ctrl', 'left', 'open'])
    check('the alternative is silenced, or it would re-enable the click that was turned off',
        migration.alternativeAction, 'none')
    check('the old key is cleared', migration.legacy, null)
    check('running it again does nothing', migration.again, false)

    const migrated = await evaluate(`
        const T = window.__T
        ${WRITE(`after ${URL} migration`, 'a-fairly-long-path')}
        T.link = T.links.find(l => l.text.startsWith('https://example.com'))
        const plain = await T.click(T.link)
        const held = await T.click(T.link, { ctrlKey: true })
        return { plain: plain.calls, held: held.calls }
    `)
    check('after migrating, a plain click no longer opens', migrated.plain, [])
    check('and ctrl+click does, exactly as the old setting said', migrated.held, [['open', URL]])

    // Upstream's own Terminal settings page still writes that key ("Require a
    // key to click links"), so the migration is wired to config.changed$ as well
    // as to startup — otherwise that control would appear to do nothing and then
    // overwrite the chords at the next launch.
    const viaSave = await evaluate(`
        const T = window.__T
        const store = T.config.store
        T.resetChords()
        store.clickableLinks.modifier = 'altKey'
        await T.config.save()
        await new Promise(r => setTimeout(r, 400))
        return {
            modifier: store.linkTooltip.primaryClickModifier,
            alternativeAction: store.linkTooltip.alternativeAction,
            legacy: store.clickableLinks.modifier,
        }
    `)
    check('a save of the upstream control migrates at once, not at the next launch',
        [viaSave.modifier, viaSave.alternativeAction, viaSave.legacy], ['alt', 'none', null])

    console.log('\n── the settings page can express all of it ──')
    const settings = await evaluate(`
        const T = window.__T
        T.resetChords()
        // Only the active tab is in the DOM, so Settings has to be opened *and*
        // selected before anything can be read off it.
        const root = ${ROOT}
        const provider = (root.toolbarButtonProviders || []).find(x => x.constructor.name === 'ButtonProvider')
        await provider.open()
        await new Promise(r => setTimeout(r, 600))
        root.app.selectTab(root.app.tabs.find(t => t.constructor.name === 'SettingsTabComponent'))
        await new Promise(r => setTimeout(r, 900))
        window.ng.applyChanges(root)
        const nav = [...document.querySelectorAll('settings-tab .nav-link')]
            .find(el => el.textContent.includes('Link Tooltip'))
        if (!nav) { return { skipped: 'no Link Tooltip item in the settings nav' } }
        nav.click()
        await new Promise(r => setTimeout(r, 1200))
        const page = document.querySelector('link-tooltip-settings-tab')
        if (!page) { return { skipped: 'the Link Tooltip page did not render' } }
        const component = window.ng.getComponent(page)

        const chordRows = [...page.querySelectorAll('.chord-row')]
        const kindBoxes = [...page.querySelectorAll('.click-kinds input[type=checkbox]')]
        const before = T.config.store.linkTooltip.primaryClickGesture

        // Change the primary gesture through the select itself, the way a person
        // does — the value has to travel select → ngModel → config.
        const gestureSelect = chordRows[0].querySelectorAll('select')[1]
        gestureSelect.value = [...gestureSelect.options].find(o => o.textContent.trim() === 'Middle click').value
        gestureSelect.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise(r => setTimeout(r, 200))
        const afterSelect = T.config.store.linkTooltip.primaryClickGesture
        const described = chordRows[0].parentElement.querySelector('.description').textContent.trim()

        // And a kind checkbox, which is written back as a whole array.
        kindBoxes[0].click()
        await new Promise(r => setTimeout(r, 200))
        const afterKind = [...T.config.store.linkTooltip.clickableKinds]

        // And the per-rule override, which has to offer the rule's own buttons
        // alongside the built-in ids.
        component.currentRule = {
            name: 'editor probe', enabled: true, match: 'link',
            schemes: [], pattern: '', fileTypeGroup: 'none', extensions: [],
            integration: 'none', preview: false,
            showDelay: null, hideDelay: null, maxWidth: null,
            suppressOpen: false, suppressCopyLink: false, suppressCopyPath: false, suppressReveal: false,
            primaryAction: '', alternativeAction: '',
            actions: [{ name: 'Ping', icon: '', type: 'sendInput', value: 'ping %u' }],
        }
        window.ng.applyChanges(component)
        await new Promise(r => setTimeout(r, 300))
        const ruleSelects = [...page.querySelectorAll('.rule-editor select')]
            .filter(s => [...s.options].some(o => o.value === 'copyPath') && [...s.options].some(o => o.value === ''))
        const ruleOptions = ruleSelects.map(s => [...s.options].map(o => o.value))

        component.currentRule = null
        T.resetChords()
        window.ng.applyChanges(component)
        return {
            chordRows: chordRows.length,
            selectsPerRow: chordRows.map(r => r.querySelectorAll('select').length),
            kinds: kindBoxes.length,
            before, afterSelect, described, afterKind, ruleOptions,
        }
    `)
    if (settings.skipped) {
        note(`skipped: ${settings.skipped}`)
        failed++
    } else {
        check('both chords are on the page, three selects each',
            [settings.chordRows, settings.selectsPerRow], [2, [3, 3]])
        check('all three kinds are offered', settings.kinds, 3)
        check('picking a gesture reaches the config', [settings.before, settings.afterSelect], ['left', 'middle'])
        check('and the row says what the chord now is', settings.described, 'Middle-click')
        check('unticking a kind rewrites the list', settings.afterKind, ['rules', 'osc8'])
        check('the rule editor offers an override for each chord', settings.ruleOptions.length, 2)
        check('inherit, suppress, the built-ins, and the rule\'s own button',
            settings.ruleOptions[0], ['', 'none', 'open', 'copyLink', 'copyPath', 'reveal', 'Ping'])
    }

    console.log('\n── cleanup ──')
    const restored = await evaluate(`
        const T = window.__T
        const store = T.config.store
        Object.assign(store.linkTooltip, T.saved.linkTooltip)
        store.linkTooltip.rules = T.saved.rules
        store.clickableLinks.modifier = T.saved.legacyModifier
        store.terminal.rightClick = T.saved.rightClick
        store.terminal.pasteOnMiddleClick = T.saved.pasteOnMiddleClick
        T.core.element.removeEventListener('mousedown', T.probe)
        T.decorator.actions = T.realActions
        ;(T.decorator.handlers || []).forEach((h, i) => { h.handle = T.realHandles[i] })
        T.clearSelection()
        // Back to the terminal: the settings section above left Settings open.
        T.root.app.selectTab(T.root.app.tabs.find(t => t.getAllTabs && t.getAllTabs().includes(T.tab)) || T.tab)
        await T.config.save()
        return {
            legacy: store.clickableLinks.modifier,
            rightClick: store.terminal.rightClick,
            paste: store.terminal.pasteOnMiddleClick,
            rules: store.linkTooltip.rules.length,
            clickable: store.linkTooltip.clickable,
            actionsRestored: T.decorator.actions === T.realActions,
        }
    `)
    check('the profile is put back as it was found',
        [restored.legacy, restored.rightClick, restored.paste, restored.rules, restored.actionsRestored],
        [ready.saved.legacyModifier, ready.saved.rightClick, ready.saved.pasteOnMiddleClick, ready.saved.rules.length, true])
    note(`clickable: ${restored.clickable}, rules: ${restored.rules}`)

    console.log(`\n${passed} passed, ${failed} failed`)
    process.exitCode = failed ? 1 : 0
}

main()
    .catch(err => {
        console.error(err)
        process.exitCode = 1
    })
    // An open CDP socket holds the event loop, so without this every failure
    // leaves the process alive for ever.
    .finally(closeAll)
