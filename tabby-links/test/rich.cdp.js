// Verifies the "rich integrations" manifest features in a running renderer:
// the four built-ins load, detectPatterns join the scan pool, and a preview
// carrying groups/tabs/actions renders as one.
//
// Launch the dev build hidden first — see README.md.
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

// Pick a terminal the decorator actually attached to. A restored-but-never-
// rendered tab has a frontend and an xterm but no link provider of ours, and
// picking one of those makes a working detector look broken.
const DECORATOR = `
    const root = window.ng.getComponent(document.querySelector('app-root'))
    const all = root.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
    const withXterm = all.filter(t => t.frontend && t.frontend.xterm)
    const anyDec = withXterm
        .map(t => (t.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator'))
        .find(d => d)
    const term = withXterm.find(t => anyDec && anyDec.states.has(t)) || withXterm[0]
    const dec = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator')
`

async function main () {
    const cdp = await connect()

    console.log('\n── the four built-ins ──')
    const registry = await cdp.evaluate(`
        ${DECORATOR}
        const reg = dec.runtime.registry
        const list = reg.current()
        const jira = list.find(x => x.id === 'jira')
        return {
            ids: list.map(x => x.id).sort(),
            jiraGroups: (jira.manifest.fieldGroups || []).length,
            jiraTabs: (jira.manifest.tabs || []).length,
            jiraActions: (jira.manifest.actions || []).length,
            jiraOptionalSteps: (jira.manifest.fetch || []).filter(s => s.optional).length,
            githubSteps: (list.find(x => x.id === 'github').manifest.fetch || []).length,
            detect: reg.detectPatterns(),
        }
    `)
    check('all four built-ins discovered', registry.ids, ['github', 'jira', 'slack', 'stith'])
    check('jira brought its field groups', registry.jiraGroups > 0, true)
    check('jira brought its tabs', registry.jiraTabs > 0, true)
    check('jira brought its choice action', registry.jiraActions > 0, true)
    check('jira has optional steps', registry.jiraOptionalSteps > 0, true)
    check('github brought its whole pipeline', registry.githubSteps > 5, true)
    check('stith owns a detect pattern',
        registry.detect.map(d => d.integrationId), ['stith'])

    console.log('\n── detectPatterns join the scan pool ──')
    const pool = await cdp.evaluate(`
        ${DECORATOR}
        const rules = dec.rules.textRules()
        return {
            count: rules.length,
            // A synthetic rule carries the integration that owns it, which is
            // what makes the match resolve to a preview without a user rule.
            synthetic: rules.filter(r => r.rule.integration === 'stith').map(r => r.rule.pattern),
        }
    `)
    check('a stith pattern is in the pool', pool.synthetic.length, 1)
    check('and it is bound to stith',
        pool.synthetic[0].includes('stith://'), true)
    check('the 16-pattern cap still holds', pool.count <= 16, true)

    console.log('\n── a grouped, tabbed, actionable preview renders ──')
    const rendered = await cdp.evaluate(`
        const host = document.querySelector('link-hover-card')
        let el = host
        while (el && el !== document.body) {
            if (el.style && el.style.display === 'none') { el.style.display = '' }
            el = el.parentElement
        }
        const card = window.ng.getComponent(host)
        // The preview itself — groups, tabs, actions — is rendered by
        // link-preview-view, which the preview pane renders through too. The
        // choice state lives there.
        const view = window.ng.getComponent(host.querySelector('link-preview-view'))
        // That component outlives any one run of this suite, so a choice and a
        // filled-in form survive from last time and the "blocked before you
        // choose" assertions below would pass against stale state.
        view.chosen = {}
        view.pendingFields = {}
        view.actionError = ''
        card.model = Object.assign(card.model, {
            key: 'rich:' + Date.now(),
            allowHtml: true, loading: false,
            text: 'CAB-1', target: 'https://x.test/CAB-1',
            preview: {
                integrationId: 'x', integrationName: 'X', icon: '', error: '', link: '',
                html: '', data: {}, skipped: ['devsummary'],
                fields: [
                    { key: 'summary', label: 'Summary', value: 'A ticket', kind: 'title', iconUri: '', color: '' },
                    { key: 'branches', label: 'Branches', value: '2', kind: 'text', iconUri: '', color: '' },
                ],
                groups: [
                    { key: 'details', label: '', fields: [
                        { key: 'summary', label: 'Summary', value: 'A ticket', kind: 'title', iconUri: '', color: '' },
                    ] },
                    { key: 'dev', label: 'Development', fields: [
                        { key: 'branches', label: 'Branches', value: '2', kind: 'text', iconUri: '', color: '' },
                    ] },
                ],
                tabs: [
                    { key: 'description', label: 'Description', kind: 'body',
                      body: '# Heading\\n\\nSome **bold** text.', markdown: true, items: [] },
                    { key: 'comments', label: 'Comments', kind: 'list', body: '', markdown: false,
                      items: [{ author: 'Ada', avatarUri: '', body: 'Looks good', time: 'just now' }] },
                ],
                actions: [
                    { key: 'transition', label: 'Move to', kind: 'choice', currentState: '1', options: [
                        { id: '11', label: 'Start', badge: 'In Progress', color: 'yellow', targetId: '2', fields: [] },
                        { id: '21', label: 'Done', badge: 'Done', color: 'green', targetId: '3',
                          fields: [{ key: 'resolution', label: 'Resolution', required: true }] },
                    ] },
                ],
            },
        })
        window.ng.applyChanges(card)
        card.refresh()
        await new Promise(r => setTimeout(r, 300))

        const text = host.textContent
        const groupLabels = [...host.querySelectorAll('.group-label')].map(x => x.textContent.trim())
        const tabs = [...host.querySelectorAll('.tab')].map(x => x.textContent.trim())
        const options = [...host.querySelectorAll('.option')].map(x => x.textContent.trim())

        // Pick the option that demands a form, and see the form appear.
        const applyBefore = host.querySelector('.action-buttons .btn-primary').disabled
        view.chooseOption(card.model.preview.actions[0], '21')
        window.ng.applyChanges(card)
        await new Promise(r => setTimeout(r, 200))
        const fieldsShown = [...host.querySelectorAll('.action-field-label')].map(x => x.textContent.trim())
        const applyBlocked = host.querySelector('.action-buttons .btn-primary').disabled
        view.setFieldValue(card.model.preview.actions[0], 'resolution', 'Done')
        window.ng.applyChanges(card)
        await new Promise(r => setTimeout(r, 200))
        const applyAfter = host.querySelector('.action-buttons .btn-primary').disabled

        return {
            groupLabels, tabs, options, fieldsShown,
            applyBefore, applyBlocked, applyAfter,
            markdownBlocks: host.querySelectorAll('.md').length,
            renderedBold: !!host.querySelector('.md b'),
            noRawMarkdown: !text.includes('**bold**'),
        }
    `)

    check('the labelled group has a heading', rendered.groupLabels, ['Development'])
    check('both tabs are on the strip', rendered.tabs, ['Description', 'Comments'])
    check('markdown rendered as blocks', rendered.markdownBlocks > 0, true)
    check('and as real emphasis, not asterisks', rendered.renderedBold, true)
    check('the raw markdown is not shown', rendered.noRawMarkdown, true)
    check('the choice offers both options', rendered.options.length, 2)
    check('an option shows the state it leads to',
        rendered.options[0].includes('In Progress'), true)
    check('Apply is blocked before anything is chosen', rendered.applyBefore, true)
    check('choosing an option reveals its required form', rendered.fieldsShown, ['Resolution'])
    check('and Apply stays blocked while it is empty', rendered.applyBlocked, true)
    check('filling it unblocks Apply', rendered.applyAfter, false)

    // The headline case for detectPatterns: a bare stith:// URI printed as
    // plain text, with no OSC 8 and no rule the user wrote.
    console.log('\n── a bare stith:// in plain output is hoverable ──')
    const detected = await cdp.evaluate(`
        ${DECORATOR}
        const xterm = term.frontend.xterm
        const core = xterm._core
        xterm.write('\\r\\nsession stith://session/abc123def456 started\\r\\n')
        await new Promise(r => setTimeout(r, 500))
        const buffer = xterm.buffer.active
        let row = -1
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i)
            if (line && line.translateToString(true).includes('stith://session/abc123def456')) { row = i; break }
        }
        if (row === -1) { return { error: 'text not found in the buffer' } }
        // Ask every registered provider rather than assuming an index: which
        // slot ours occupies depends on what else attached to this terminal.
        const providers = core._linkProviderService.linkProviders
        const found = []
        for (const provider of providers) {
            const links = await new Promise(resolve => {
                let done = false
                provider.provideLinks(row + 1, result => { done = true; resolve(result) })
                setTimeout(() => { if (!done) { resolve(null) } }, 500)
            })
            for (const link of links || []) { found.push(link) }
        }
        // And the detect pattern itself, exercised directly — whoever wins the
        // race to claim the text, the pattern has to be live and matching.
        const stithRule = dec.rules.textRules().find(r => r.rule.integration === 'stith')
        const hits = stithRule
            ? stithRule.search.execAll('a stith://session/abc123def456 b').map(m => m[0])
            : []

        return {
            texts: found.map(l => l.text),
            previews: dec.runtime.canPreview('link', 'stith://session/abc123def456', ''),
            hits,
        }
    `)
    if (detected.error) {
        console.log(`  FAIL ${detected.error}`)
        failed++
    } else {
        check('the bare uri was detected',
            detected.texts.includes('stith://session/abc123def456'), true)
        check('and it resolves to a stith preview', detected.previews, true)
        // Note it is the *link* detectors that claim this one: Tabby's built-in
        // URI matcher already takes anything with a scheme, so for a scheme-
        // shaped pattern detectPatterns is belt and braces. It earns its keep on
        // patterns that are not URIs at all — hence testing the pattern itself.
        check('the detect pattern is live in the pool and matches',
            detected.hits, ['stith://session/abc123def456'])
    }

    cdp.close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
