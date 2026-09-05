// Clicking an integration must not freeze the window.
//
//   node scripts/dev/launch-hidden.mjs --enable links,linkifier --port 9246 &
//   CDP_PORT=9246 node tabby-links/test/integrationsFreeze.cdp.js
//
// The detail view iterates the manifest's field groups, and those used to be
// built by a method the template called: `*ngFor` tracks by identity, so a
// fresh array every change-detection pass destroyed and re-created every
// checkbox, and each new `ngModel` queued the microtask that writes its value
// — which scheduled another pass. The renderer span at 100% CPU for ever, and
// not even the inspector could interrupt it: `Debugger.enable` got no reply.
//
// So the assertion is liveness, not appearance. The click is fired without
// waiting for it, and the renderer is then asked simple questions with a
// deadline. A frozen one answers none of them.
const { connect } = require('./cdp')

const PING_MS = 1500
const ROUNDS = 3

function ok (message) { console.log(`ok    ${message}`) }
function fail (message) { console.error(`FAIL  ${message}`); process.exitCode = 1 }

function deadline (promise, ms, label) {
    return Promise.race([promise, new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`no answer in ${ms}ms (${label})`)), ms))])
}

const OPEN = `
    const root = window.ng.getComponent(document.querySelector('app-root'))
    const settings = window['nodeRequire']('tabby-settings')
    root.app.openNewTabRaw({ type: settings.SettingsTabComponent, inputs: { activeTab: 'integrations' } })
    let link = null
    for (let i = 0; i < 40 && !link; i++) {
        await new Promise(r => setTimeout(r, 250))
        link = [...document.querySelectorAll('.nav-link')].find(e => e.textContent.trim() === 'Integrations')
    }
    if (!link) { throw new Error('no Integrations item in the settings nav') }
    link.click()
    await new Promise(r => setTimeout(r, 800))
    window.__C = window.ng.getComponent(document.querySelector('integrations-settings-tab'))
    if (!window.__C) { throw new Error('the Integrations page did not render') }
    return window.__C.integrations.map(x => ({ id: x.id, name: x.name }))
`

/** Back to the list, so the next integration is clicked from the same state. */
const BACK = `
    await window.__C.select(null)
    window.ng.applyChanges(window.__C)
    return !!document.querySelector('.integration-list')
`

async function clickAndWatch (cdp, integration) {
    // Fired, not awaited: a frozen renderer never returns from the click.
    cdp.send('Runtime.evaluate', {
        expression: `[...document.querySelectorAll('.integration-row')]
            .find(e => e.textContent.includes(${JSON.stringify(integration.name)})).click()`,
    })
    for (let i = 0; i < ROUNDS; i++) {
        await new Promise(r => setTimeout(r, PING_MS))
        try {
            await deadline(cdp.evaluate('return document.querySelectorAll("*").length'), PING_MS, integration.id)
        } catch (err) {
            fail(`${integration.name}: the renderer stopped answering — ${err.message}`)
            return false
        }
    }
    const rendered = await deadline(cdp.evaluate(`
        return {
            detail: !!document.querySelector('.detail-head'),
            current: window.__C.current && window.__C.current.id,
            checkboxes: document.querySelectorAll('.field-check checkbox').length,
        }
    `), PING_MS, 'render')
    if (rendered.current !== integration.id || !rendered.detail) {
        fail(`${integration.name}: the detail view did not open (${JSON.stringify(rendered)})`)
        return false
    }
    ok(`${integration.name}: stayed responsive, detail view rendered with ${rendered.checkboxes} field checkboxes`)
    return true
}

async function main () {
    const cdp = await connect()
    const integrations = await cdp.evaluate(OPEN)
    // The page remembers its selection, and a run has to start from the list.
    await cdp.evaluate(BACK)
    if (!integrations.length) {
        fail('no integrations were listed — nothing to click')
        cdp.close()
        return
    }

    for (const integration of integrations) {
        if (!await clickAndWatch(cdp, integration)) {
            // A frozen renderer answers nothing after this, so there is no
            // point trying the rest — and the process must not hang waiting.
            cdp.close()
            return
        }
        await cdp.evaluate(BACK)
    }

    // A group checkbox writes config, which rebuilds the registry and hands
    // the page a new Integration object. The derived groups have to follow, or
    // the boxes would go on showing the state of an integration that is gone.
    const toggled = await deadline(cdp.evaluate(`
        const c = window.__C
        const first = c.integrations[0]
        await c.select(first)
        const group = c.currentGroups.find(g => g.fields.length)
        const key = group.fields[0].key || group.fields[0].label || ''
        const before = c.isFieldVisible(c.current, key)
        c.setFieldVisible(c.current, key, !before)
        await new Promise(r => setTimeout(r, 600))
        window.ng.applyChanges(c)
        const after = c.isFieldVisible(c.current, key)
        c.setFieldVisible(c.current, key, before)
        await new Promise(r => setTimeout(r, 400))
        return { id: first.id, key, before, after, groups: c.currentGroups.length }
    `), 8000, 'toggle')
    if (toggled.after === !toggled.before && toggled.groups) {
        ok(`toggling a display field still works (${toggled.id}: ${toggled.key} ${toggled.before} → ${toggled.after})`)
    } else {
        fail(`toggling a display field did not take: ${JSON.stringify(toggled)}`)
    }

    cdp.close()
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
})
