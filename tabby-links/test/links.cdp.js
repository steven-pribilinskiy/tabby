// Drives the running hidden dev build to verify the link tooltip end to end.
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

async function main () {
    const { evaluate, close } = await connect()

    console.log('\n── the plugin is loaded ──')
    const plugins = await evaluate(`return (window.pluginModules || []).map(m => m.pluginName).filter(Boolean)`)
    check('tabby-links loaded', plugins.includes('links'), true)
    note(`plugins: ${plugins.join(', ')}`)

    // Only the active tab is in the DOM, so settings has to be opened *and*
    // selected before anything can be read off it.
    const OPEN_SETTINGS = `
        const cmp = ${ROOT}
        const provider = (cmp.toolbarButtonProviders || []).find(x => x.constructor.name === 'ButtonProvider')
        await provider.open()
        await new Promise(r => setTimeout(r, 600))
        const tab = cmp.app.tabs.find(t => t.constructor.name === 'SettingsTabComponent')
        cmp.app.selectTab(tab)
        await new Promise(r => setTimeout(r, 900))
        window.ng.applyChanges(cmp)
        await new Promise(r => setTimeout(r, 400))
    `

    console.log('\n── settings pages are registered ──')
    const navTitles = await evaluate(`
        ${OPEN_SETTINGS}
        return [...document.querySelectorAll('settings-tab .nav-link')].map(x => x.textContent.trim())
    `)
    check('Link Tooltip page present', navTitles.some(t => t.includes('Link Tooltip')), true)
    check('Integrations page present', navTitles.some(t => t.includes('Integrations')), true)
    note(`pages: ${navTitles.join(' | ')}`)

    console.log('\n── the Integrations page finds the four built-ins ──')
    const integrations = await evaluate(`
        const links = [...document.querySelectorAll('settings-tab .nav-link')]
        const target = links.find(x => x.textContent.includes('Integrations'))
        target.click()
        await new Promise(r => setTimeout(r, 1200))
        const el = document.querySelector('integrations-settings-tab')
        if (!el) { return { error: 'page did not render' } }
        const cmp = window.ng.getComponent(el)
        return {
            ids: cmp.integrations.map(i => i.id),
            names: cmp.integrations.map(i => i.name),
            sources: cmp.integrations.map(i => i.source),
            configured: cmp.integrations.map(i => i.configured),
            stithBaseUrl: cmp.registry.settingValue('stith', 'baseUrl'),
            userDirectory: cmp.userDirectory,
            encryptionAvailable: cmp.encryptionAvailable,
            rendered: el.textContent.includes('Jira') && el.textContent.includes('Slack') && el.textContent.includes('Stith'),
        }
    `)
    check('all four built-ins discovered', integrations.ids, ['github', 'jira', 'slack', 'stith'])
    check('sources say built-in', integrations.sources.every(x => x === 'built-in'), true)
    // Stith declares a required setting and no credentials, so "configured"
    // must track that setting exactly. Asserted as a relationship rather than a
    // fixed value, because this profile may legitimately have the server set.
    check('stith is configured exactly when its server setting is present',
        integrations.configured[integrations.ids.indexOf('stith')], !!integrations.stithBaseUrl)
    check('the page actually rendered them', integrations.rendered, true)
    check('safeStorage is available on this machine', integrations.encryptionAvailable, true)
    note(`user manifest dir: ${integrations.userDirectory}`)

    console.log('\n── configuring stith makes it usable ──')
    const configured = await evaluate(`
        const el = document.querySelector('integrations-settings-tab')
        const cmp = window.ng.getComponent(el)
        const stith = cmp.integrations.find(i => i.id === 'stith')
        cmp.setSetting(stith, 'baseUrl', 'https://stith.lvh.me')
        await cmp.registry.rebuild()
        await new Promise(r => setTimeout(r, 300))
        const after = cmp.registry.byId('stith')
        return { configured: after.configured, baseUrl: after.settings.baseUrl }
    `)
    check('stith is configured once its server is set', configured.configured, true)
    check('the setting round-tripped', configured.baseUrl, 'https://stith.lvh.me')

    console.log('\n── the Link Tooltip page ──')
    const linkPage = await evaluate(`
        const links = [...document.querySelectorAll('settings-tab .nav-link')]
        links.find(x => x.textContent.includes('Link Tooltip')).click()
        await new Promise(r => setTimeout(r, 1200))
        const el = document.querySelector('link-tooltip-settings-tab')
        if (!el) { return { error: 'page did not render' } }
        const cmp = window.ng.getComponent(el)
        const text = el.textContent
        return {
            rules: cmp.rules.length,
            hasDefaults: text.includes('Maximum width of the link tooltip')
                && text.includes('Delay before the link tooltip appears')
                && text.includes('Delay before the link tooltip disappears')
                && text.includes('Show buttons on the link tooltip')
                && text.includes('URI schemes that open without a warning'),
            integrationsInDropdown: cmp.integrations.map(i => i.id),
        }
    `)
    check('all seven defaults render', linkPage.hasDefaults, true)
    check('the rule editor can offer every integration', linkPage.integrationsInDropdown, ['github', 'jira', 'slack', 'stith'])
    // Not "zero": this profile is reused between runs and the rule this suite
    // adds is left behind for the hover checks that follow. The count only has
    // to grow by exactly one when a rule is added.
    const rulesBefore = linkPage.rules

    console.log('\n── adding a rule, and refusing a dangerous pattern ──')
    const ruleTest = await evaluate(`
        const el = document.querySelector('link-tooltip-settings-tab')
        const cmp = window.ng.getComponent(el)
        cmp.addRule()
        const rule = cmp.currentRule
        rule.match = 'text'
        const started = performance.now()
        cmp.setPattern(rule, '(a+)+b')
        const evilMs = performance.now() - started
        const evilError = cmp.patternError
        cmp.setPattern(rule, '\\\\b([A-Z][A-Z0-9]{1,9}-\\\\d{1,7})\\\\b')
        const goodError = cmp.patternError
        rule.integration = 'jira'
        rule.name = 'Jira issue keys'
        cmp.saveConfiguration()
        return { evilMs, evilError, goodError, rules: cmp.rules.length, summary: cmp.summary(rule) }
    `)
    check('a catastrophic pattern is refused', ruleTest.evilError.length > 0, true)
    check('refusing it is fast, not a freeze', ruleTest.evilMs < 500, true)
    check('a sane pattern is accepted', ruleTest.goodError, '')
    check('the rule was added', ruleTest.rules, rulesBefore + 1)
    note(`refusal: ${ruleTest.evilError.slice(0, 100)}`)
    note(`summary line: ${ruleTest.summary}`)
    note(`refusal took ${ruleTest.evilMs.toFixed(1)} ms`)

    await close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
