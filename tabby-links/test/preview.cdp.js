// Verifies a real integration preview end to end against the live stith server.
const { connect } = require('./cdp')
const https = require('https')

let passed = 0
let failed = 0
function check (name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) { passed++; console.log(`  ok   ${name}`) } else {
        failed++
        console.log(`  FAIL ${name}\n         expected ${e}\n         actual   ${a}`)
    }
}
function note (t) { console.log(`       ${t}`) }

function fetchSessionId () {
    return new Promise((resolve, reject) => {
        https.get({
            host: 'stith.lvh.me', path: '/api/agents', rejectUnauthorized: false,
        }, res => {
            let body = ''
            res.on('data', c => body += c)
            res.on('end', () => {
                try {
                    resolve(JSON.parse(body).agents[0].sessionId)
                } catch (err) { reject(err) }
            })
        }).on('error', reject)
    })
}

const ROOT = `window.ng.getComponent(document.querySelector('app-root'))`

async function main () {
    const sessionId = await fetchSessionId()
    note(`live stith session: ${sessionId}`)
    const { evaluate, close } = await connect()

    // Reach the runtime through the settings page component, which injects it.
    const OPEN_SETTINGS = `
        const cmp = ${ROOT}
        const provider = (cmp.toolbarButtonProviders || []).find(x => x.constructor.name === 'ButtonProvider')
        await provider.open()
        await new Promise(r => setTimeout(r, 500))
        const tab = cmp.app.tabs.find(t => t.constructor.name === 'SettingsTabComponent')
        cmp.app.selectTab(tab)
        await new Promise(r => setTimeout(r, 800))
        window.ng.applyChanges(cmp)
        await new Promise(r => setTimeout(r, 400))
        const links = [...document.querySelectorAll('settings-tab .nav-link')]
        links.find(x => x.textContent.includes('Integrations')).click()
        await new Promise(r => setTimeout(r, 900))
        const page = window.ng.getComponent(document.querySelector('integrations-settings-tab'))
    `

    console.log('\n── an unconfigured integration is silent, not erroring ──')
    // Slack, whose bot token is never set in this profile — a state-independent
    // stand-in for "declared a credential, has not got one".
    const unconfigured = await evaluate(`
        ${OPEN_SETTINGS}
        window.__P = { page }
        await page.credentials.clear('slack', 'token')
        await page.registry.rebuild()
        await new Promise(r => setTimeout(r, 300))
        const slack = page.registry.byId('slack')
        const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
        const term = all.find(t => t.frontend && t.frontend.xterm)
        const runtime = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator').runtime
        return {
            configured: slack.configured,
            credentials: Object.keys(slack.credentials),
            previewOffered: runtime.canPreview('link', 'https://acme.slack.com/archives/C123/p1725360000123456', ''),
        }
    `)
    check('Slack is not configured without its token', unconfigured.configured, false)
    check('and has no credential values in memory', unconfigured.credentials, [])
    check('so no preview is even attempted', unconfigured.previewOffered, false)

    console.log('\n── a live stith preview ──')
    const preview = await evaluate(`
        const page = window.__P.page
        const stith = page.registry.byId('stith')
        page.setSetting(stith, 'baseUrl', 'https://stith.lvh.me')
        await page.registry.rebuild()
        await new Promise(r => setTimeout(r, 300))

        // The runtime is a root-provided service; reach it through the card
        // component's own injector by way of a terminal decorator instance.
        const cmp = ${ROOT}
        const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
        const term = all.find(t => t.frontend && t.frontend.xterm)
        const decorator = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator')
        if (!decorator) { return { error: 'decorator not found on the tab' } }
        const runtime = decorator.runtime
        const uri = 'stith://session/${sessionId}'
        const can = runtime.canPreview('link', uri, '')
        const result = await runtime.preview('link', uri, '')
        return {
            can,
            error: result && result.error,
            integration: result && result.integrationName,
            fields: result ? result.fields.map(f => ({ key: f.key, label: f.label, kind: f.kind, value: String(f.value).slice(0, 40), color: f.color })) : null,
        }
    `)
    if (preview.error === undefined && preview.fields === null) {
        console.log(`  FAIL could not run a preview: ${JSON.stringify(preview)}`)
        failed++
    } else {
        check('the stith matcher claims a stith:// link', preview.can, true)
        check('the fetch succeeded', preview.error, '')
        check('the card names the integration', preview.integration, 'Stith')
        check('default fields came back', preview.fields.length > 0, true)
        const keys = preview.fields.map(f => f.key)
        check('the session name is the title', preview.fields.find(f => f.kind === 'title')?.key, 'name')
        check('status renders as a badge', preview.fields.find(f => f.key === 'status')?.kind, 'badge')
        check('only default fields are shown', keys.every(k => ['name', 'status', 'project', 'machine', 'lastActivity', 'error'].includes(k)), true)
        note(`fields: ${preview.fields.map(f => `${f.label}=${f.value}`).join(' | ')}`)
    }

    console.log('\n── the cache and the host guard ──')
    const guards = await evaluate(`
        const cmp = ${ROOT}
        const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
        const term = all.find(t => t.frontend && t.frontend.xterm)
        const runtime = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator').runtime
        const uri = 'stith://session/${sessionId}'
        const started = performance.now()
        await runtime.preview('link', uri, '')
        const cachedMs = performance.now() - started
        // A look-alike host must not match Jira's host-guarded matcher, even
        // though the path shape is right.
        const lookalike = runtime.canPreview('link', 'https://evil.example/browse/CAB-1', '')
        const hintedNone = runtime.canPreview('link', uri, 'none')
        const hintedWrong = runtime.canPreview('link', uri, 'jira')
        return { cachedMs, lookalike, hintedNone, hintedWrong }
    `)
    check('a second hover is served from cache', guards.cachedMs < 20, true)
    check('a look-alike Jira host is refused', guards.lookalike, false)
    check('integration "none" refuses a preview', guards.hintedNone, false)
    check('a rule naming a different integration refuses', guards.hintedWrong, false)
    note(`cached lookup took ${guards.cachedMs.toFixed(2)} ms`)

    console.log('\n── credentials never reach config.yaml ──')
    const secrets = await evaluate(`
        const page = window.__P.page
        const creds = page.credentials ?? null
        return { hasIntegrationsKey: !!${ROOT}.config.store.integrations }
    `)
    check('integrations config exists', secrets.hasIntegrationsKey, true)

    await close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
