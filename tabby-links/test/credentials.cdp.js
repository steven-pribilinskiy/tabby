// Credential round-trip through safeStorage, and proof it never reaches config.yaml.
const fs = require('fs')
const path = require('path')
const { connect } = require('./cdp')

// Ask the running instance where its profile is, rather than assuming. The dev
// build is launched with an isolated `TABBY_CONFIG_DIRECTORY` that lives outside
// the repo, so guessing a path here silently tests nothing.
const PROFILE = process.env.TABBY_CONFIG_DIRECTORY || path.join(__dirname, 'tabby-profile')

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

const OPEN_INTEGRATIONS = `
    const cmp = window.ng.getComponent(document.querySelector('app-root'))
    const provider = (cmp.toolbarButtonProviders || []).find(x => x.constructor.name === 'ButtonProvider')
    await provider.open()
    await new Promise(r => setTimeout(r, 500))
    cmp.app.selectTab(cmp.app.tabs.find(t => t.constructor.name === 'SettingsTabComponent'))
    await new Promise(r => setTimeout(r, 800))
    window.ng.applyChanges(cmp)
    await new Promise(r => setTimeout(r, 400))
    const navs = [...document.querySelectorAll('settings-tab .nav-link')]
    navs.find(x => x.textContent.includes('Integrations')).click()
    await new Promise(r => setTimeout(r, 900))
    const page = window.ng.getComponent(document.querySelector('integrations-settings-tab'))
`

async function main () {
    const { evaluate, close } = await connect()
    const secret = `super-secret-token-${Date.now()}`

    console.log('\n── storing a credential ──')
    const stored = await evaluate(`
        ${OPEN_INTEGRATIONS}
        const creds = page.credentials
        await creds.set('jira', 'token', ${JSON.stringify(secret)})
        await creds.set('jira', 'email', 'someone@example.com')
        const readBack = await creds.get('jira', 'token')
        const has = await creds.has('jira', 'token')
        // The id, not the Integration. Passing the object stringifies to
        // '[object Object]' and quietly writes the setting under that key,
        // leaving the real one untouched — which then fails the host guard
        // check further down for a reason that looks nothing like the cause.
        window.__priorJiraHost = page.registry.settingValue('jira', 'host')
        page.registry.setSetting('jira', 'host', 'acme.atlassian.net')
        await page.registry.rebuild()
        await new Promise(r => setTimeout(r, 400))
        const jira = page.registry.byId('jira')
        await ${'window.ng.getComponent(document.querySelector("app-root"))'}.config.save()
        return {
            roundTrip: readBack === ${JSON.stringify(secret)},
            has,
            configuredAfter: jira.configured,
            credKeys: Object.keys(jira.credentials).sort(),
        }
    `)
    check('the secret round-trips through the OS keystore', stored.roundTrip, true)
    check('it reports as stored', stored.has, true)
    check('Jira is configured once host + both credentials are set', stored.configuredAfter, true)
    check('both credentials are in the in-memory snapshot', stored.credKeys, ['email', 'token'])

    console.log('\n── the secret is not in config.yaml ──')
    await new Promise(r => setTimeout(r, 800))
    const configPath = path.join(PROFILE, 'config.yaml')
    const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : ''
    check('config.yaml exists', configText.length > 0, true)
    check('the secret is absent from config.yaml', configText.includes(secret), false)
    check('the word "token" does not appear as a stored value', /token:\s*\S/.test(configText), false)
    check('the non-secret host setting IS in config.yaml', configText.includes('acme.atlassian.net'), true)

    console.log('\n── the sidecar holds only ciphertext ──')
    const sidecarPath = path.join(PROFILE, 'integration-credentials.json')
    const sidecar = fs.existsSync(sidecarPath) ? fs.readFileSync(sidecarPath, 'utf8') : ''
    check('the sidecar exists', sidecar.length > 0, true)
    check('the plaintext secret is not in it', sidecar.includes(secret), false)
    check('it records the jira keys', Object.keys(JSON.parse(sidecar || '{}').jira ?? {}).sort(), ['email', 'token'])
    note(`sidecar: ${sidecarPath}`)
    note(`stored token (ciphertext, truncated): ${(JSON.parse(sidecar || '{}').jira?.token ?? '').slice(0, 48)}…`)

    console.log('\n── a look-alike host still gets nothing, now that Jira IS configured ──')
    const guard = await evaluate(`
        const cmp = window.ng.getComponent(document.querySelector('app-root'))
        const all = cmp.app.tabs.flatMap(t => t.getAllTabs ? t.getAllTabs() : [t])
        const term = all.find(t => t.frontend && t.frontend.xterm)
        const runtime = (term.decorators || []).find(d => d.constructor.name === 'LinkTooltipDecorator').runtime
        return {
            evil: runtime.canPreview('link', 'https://evil.example/browse/CAB-1', ''),
            real: runtime.canPreview('link', 'https://acme.atlassian.net/browse/CAB-1', ''),
        }
    `)
    check('a look-alike host is still refused', guard.evil, false)
    check('the configured host is accepted', guard.real, true)

    console.log('\n── clearing it ──')
    const cleared = await evaluate(`
        ${OPEN_INTEGRATIONS}
        await page.credentials.clear('jira', 'token')
        await page.credentials.clear('jira', 'email')
        // Put the host back the way it was found. This profile is reused across
        // runs and may hold a real one someone typed by hand; leaving a test
        // value in it makes the *next* run fail somewhere unrelated.
        page.registry.setSetting('jira', 'host', window.__priorJiraHost || '')
        await page.registry.rebuild()
        await new Promise(r => setTimeout(r, 300))
        return {
            has: await page.credentials.has('jira', 'token'),
            configured: page.registry.byId('jira').configured,
            hostRestored: page.registry.settingValue('jira', 'host') === (window.__priorJiraHost || ''),
        }
    `)
    check('the credential is gone', cleared.has, false)
    check('and Jira is unconfigured again', cleared.configured, false)
    check('the host setting was left as it was found', cleared.hostRestored, true)

    await close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
