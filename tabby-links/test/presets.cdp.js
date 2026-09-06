// Rule presets, driven through the real settings page.
//
// `logic.test.js` proves the presets themselves — that they compile, pass the
// ReDoS guard, and match what they claim to. This asserts the two things only
// the running app can answer: that both entry points render and produce a rule,
// and that the rule they produce is one `LinkRulesService` then actually
// resolves against a real link.
//
// The profile is reused and may hold rules someone typed, so the rule list is
// snapshotted and put back before this exits.
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
const PAGE = `window.ng.getComponent(document.querySelector('link-tooltip-settings-tab'))`

// A real click, not `el.click()`.
//
// ng-bootstrap closes a dropdown from a `mousedown`/`mouseup` pair, not from the
// `click` event, so a bare `.click()` picks the item and leaves the menu open —
// which nothing in the app ever does, and which made this suite pass and fail on
// alternate runs as the leftover open state toggled the next run's caret shut.
const CLICK = `
    const realClick = el => {
        for (const type of ['mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
        }
    }
`

// The *live* rules service — the one the terminal's own decorator holds, not a
// fresh instance. `pluginModules` carries only each plugin's NgModule class, so
// there is no token to hand an injector; a decorator on a real tab is the way
// in. That also means what is asserted here is what a hover would do.
const RULES = `
    (() => {
        const cmp = ${ROOT}
        const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
        const term = all.find(t => t.decorators && t.frontend && t.frontend.xterm)
        if (!term) { throw new Error('no terminal tab to read the decorator from') }
        const decorator = term.decorators.find(d => d.constructor.name === 'LinkTooltipDecorator')
        if (!decorator) { throw new Error('the link decorator is not attached') }
        return decorator.rules
    })()
`

async function main () {
    const { evaluate, close } = await connect()

    console.log('\n── open Settings → Link Tooltip ──')
    const opened = await evaluate(`
        const cmp = ${ROOT}
        const provider = (cmp.toolbarButtonProviders || []).find(x => x.constructor.name === 'ButtonProvider')
        await provider.open()
        await new Promise(r => setTimeout(r, 600))
        const tab = cmp.app.tabs.find(t => t.constructor.name === 'SettingsTabComponent')
        cmp.app.selectTab(tab)
        await new Promise(r => setTimeout(r, 900))
        window.ng.applyChanges(cmp)
        // Polled, not slept on: on a cold instance the settings tab's nav takes
        // longer than any fixed wait worth writing, and a missing nav link then
        // reads as "the page is gone" rather than "it was not there yet".
        let nav = null
        for (let i = 0; i < 40 && !nav; i++) {
            nav = [...document.querySelectorAll('settings-tab .nav-link')]
                .find(x => x.textContent.includes('Link Tooltip'))
            if (!nav) { await new Promise(r => setTimeout(r, 250)) }
        }
        if (!nav) { return { error: 'the Link Tooltip nav link never appeared' } }
        nav.click()
        let page = null
        for (let i = 0; i < 40 && !page; i++) {
            await new Promise(r => setTimeout(r, 250))
            page = ${PAGE}
        }
        if (!page) { return { error: 'page did not render' } }
        // Put the rule list back exactly as it was, whatever happens below.
        window.__PRESETS = { saved: JSON.parse(JSON.stringify(page.rules)) }
        return { rules: page.rules.length, presets: page.presets.map(p => p.id) }
    `)
    check('the page rendered', opened.error, undefined)
    check('every preset reached the page', opened.presets, [
        'jira-issue-keys', 'jira-issue-links',
        'github-pull-requests', 'github-issues', 'github-commits',
        'slack-messages',
        'stith-session-uris', 'stith-web-links',
        'git-commit-hashes', 'media-files', 'source-code-files',
    ])
    note(`${opened.rules} rule(s) already on this profile`)

    console.log('\n── entry point 1: the "Add rule" split button ──')
    // Through the DOM, not the component: the point of this suite is that the
    // flyout is reachable, so the caret is clicked and the menu item is clicked.
    const viaMenu = await evaluate(`
        ${CLICK}
        const page = ${PAGE}
        // The caret is a toggle, so a menu left open by anything else would make
        // this click *close* it. Clear that first — the profile is shared.
        for (let i = 0; i < 4 && document.querySelector('.preset-menu.show'); i++) {
            realClick(document.body)
            await new Promise(r => setTimeout(r, 200))
        }
        const before = page.rules.length
        const host = document.querySelector('link-tooltip-settings-tab')
        const toggle = host.querySelector('.btn-group .dropdown-toggle-split')
        if (!toggle) { return { error: 'no split-button caret' } }
        realClick(toggle)
        await new Promise(r => setTimeout(r, 400))
        // container='body' moves the menu out of the component's subtree, so it
        // is found in the document and by the class ng-bootstrap sets when open.
        const menu = document.querySelector('.add-rule-presets.show')
        if (!menu) { return { error: 'the menu did not open' } }
        const items = [...menu.querySelectorAll('.dropdown-item')]
        const styled = getComputedStyle(items[0].querySelector('.preset-description'))
        const labels = items.map(i => i.querySelector('.preset-name').textContent.trim())
        const wanted = items.find(i => i.textContent.includes('Pull request'))
        realClick(wanted)
        await new Promise(r => setTimeout(r, 400))
        window.ng.applyChanges(page)
        const rule = page.currentRule
        return {
            header: menu.querySelector('.dropdown-header').textContent.trim(),
            count: items.length,
            labels,
            // The menu is styled from the component's stylesheet even after
            // ng-bootstrap reparents it to <body>.
            descriptionStyled: styled.fontSize,
            stillOpen: !!document.querySelector('.add-rule-presets.show'),
            added: page.rules.length - before,
            opened: page.currentRule === page.rules[page.rules.length - 1],
            error: page.patternError,
            rule: rule && {
                name: rule.name, match: rule.match, integration: rule.integration,
                pattern: rule.pattern, enabled: rule.enabled,
            },
        }
    `)
    check('the flyout opened', viaMenu.error, '')
    check('it lists every preset', viaMenu.count, 11)
    check('under a heading', viaMenu.header, 'Start from a preset')
    check('exactly one rule was added', viaMenu.added, 1)
    check('and opened in the editor', viaMenu.opened, true)
    check('filled in from the preset', viaMenu.rule, {
        name: 'GitHub: Pull request links',
        match: 'link',
        integration: 'github',
        pattern: '^https://github\\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/(?<ispull>pull)/(?<number>\\d+)',
        enabled: true,
    })
    check('the pattern was not refused by the guard', viaMenu.error, '')
    check('the menu keeps the component\'s styles after moving to body',
        viaMenu.descriptionStyled, '12px')
    check('picking one closes the menu', viaMenu.stillOpen, false)
    note(`menu: ${viaMenu.labels.join(' | ')}`)

    console.log('\n── the rule it made actually resolves ──')
    // Straight through the service the terminal uses, so this is the rule
    // firing rather than the settings page describing itself.
    const resolved = await evaluate(`
        const page = ${PAGE}
        const rules = page.rules
        const svc = ${RULES}
        const hit = svc.resolve('link', 'https://github.com/Eugeny/tabby/pull/11383', '', null)
        const miss = svc.resolve('link', 'https://github.com/Eugeny/tabby/issues/11383', '', null)
        return {
            hit: hit.rule && hit.rule.name,
            hitIntegration: hit.integration,
            miss: miss.rule && miss.rule.name,
            ruleCount: rules.length,
        }
    `)
    check('a pull request URL picks the preset rule', resolved.hit, 'GitHub: Pull request links')
    check('and asks GitHub for the preview', resolved.hitIntegration, 'github')
    check('an issue URL does not', resolved.miss === 'GitHub: Pull request links', false)
    note(`issue URL resolved to: ${resolved.miss ?? 'no rule'}`)

    console.log('\n── entry point 2: "Apply preset" inside the editor ──')
    const viaEditor = await evaluate(`
        ${CLICK}
        const page = ${PAGE}
        const rule = page.currentRule
        // A custom action the user wrote. Applying a preset must not eat it.
        rule.actions = [{ name: 'Show', icon: '', type: 'sendInput', value: 'git show %u' }]
        rule.showDelay = 1234
        rule.suppressOpen = true
        page.saveConfiguration()
        window.ng.applyChanges(page)
        await new Promise(r => setTimeout(r, 200))
        const before = page.rules.length
        const host = document.querySelector('link-tooltip-settings-tab')
        const toggles = [...host.querySelectorAll('.rule-editor [ngbdropdowntoggle], .rule-editor .dropdown button')]
        const toggle = toggles.find(t => t.textContent.includes('Apply preset'))
        if (!toggle) { return { error: 'no Apply preset button in the editor' } }
        realClick(toggle)
        await new Promise(r => setTimeout(r, 400))
        const menu = document.querySelector('.apply-preset.show')
        if (!menu) { return { error: 'the editor menu did not open' } }
        const items = [...menu.querySelectorAll('.dropdown-item')]
        const wanted = items.find(i => i.textContent.includes('Media'))
        realClick(wanted)
        await new Promise(r => setTimeout(r, 400))
        window.ng.applyChanges(page)
        return {
            error: '',
            stillOpen: !!document.querySelector('.apply-preset.show'),
            added: page.rules.length - before,
            sameObject: page.currentRule === rule,
            name: rule.name,
            match: rule.match,
            schemes: rule.schemes,
            fileTypeGroup: rule.fileTypeGroup,
            pattern: rule.pattern,
            showDelay: rule.showDelay,
            suppressOpen: rule.suppressOpen,
            actions: rule.actions.length,
            patternError: page.patternError,
            summary: page.summary(rule),
        }
    `)
    check('the editor dropdown opened', viaEditor.error, '')
    check('picking one closes it', viaEditor.stillOpen, false)
    check('it rewrote the open rule rather than adding one', viaEditor.added, 0)
    check('in place', viaEditor.sameObject, true)
    check('criteria replaced', {
        name: viaEditor.name, match: viaEditor.match,
        schemes: viaEditor.schemes, fileTypeGroup: viaEditor.fileTypeGroup, pattern: viaEditor.pattern,
    }, {
        name: 'Media: Images, audio and video', match: 'link',
        schemes: ['file', 'http', 'https'], fileTypeGroup: 'media', pattern: '',
    })
    check('the override went back to inheriting', viaEditor.showDelay, null)
    check('button suppression reset', viaEditor.suppressOpen, false)
    check('the custom action survived', viaEditor.actions, 1)
    check('no pattern error', viaEditor.patternError, '')
    note(`summary line: ${viaEditor.summary}`)

    console.log('\n── the file-type preset resolves against a real path ──')
    const media = await evaluate(`
        const svc = ${RULES}
        // The second pass the decorator makes, once the link has a resolved path.
        const image = svc.resolve('link', '/home/steve/a.png', '/home/steve/a.png', null)
        const text = svc.resolve('link', '/home/steve/a.md', '/home/steve/a.md', null)
        return { image: image.rule && image.rule.name, text: text.rule && text.rule.name }
    `)
    check('an image path picks the media rule', media.image, 'Media: Images, audio and video')
    check('a markdown path does not', media.text === 'Media: Images, audio and video', false)

    console.log('\n── the profile is left as it was found ──')
    const restored = await evaluate(`
        const page = ${PAGE}
        const cmp = ${ROOT}
        // In place: the getter hands back the stored array itself, and
        // assigning over the ConfigProxy member is the one thing that would not
        // reach the file.
        page.rules.splice(0, page.rules.length, ...window.__PRESETS.saved)
        page.currentRule = null
        await cmp.config.save()
        window.ng.applyChanges(page)
        return { rules: page.rules.length, saved: window.__PRESETS.saved.length }
    `)
    check('the rule list is back', restored.rules, restored.saved)

    await close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
