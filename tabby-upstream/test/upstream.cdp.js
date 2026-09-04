// Verifies the Upstream settings page against this checkout, in a dev build
// launched hidden. See tabby-links/test/README.md for the launch line.
const { connect } = require('../../tabby-links/test/cdp')
const { execFileSync } = require('child_process')
const path = require('path')

const REPO = path.resolve(__dirname, '../..')

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

function git (...args) {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
}

async function main () {
    // The truth to compare the page against, straight from git.
    const expectedBehind = Number(git('rev-list', '--count', 'HEAD..upstream/master'))
    const expectedAhead = Number(git('rev-list', '--count', 'upstream/master..HEAD'))
    const expectedBranch = git('rev-parse', '--abbrev-ref', 'HEAD')
    console.log(`\n  (git says: ${expectedBehind} behind, ${expectedAhead} ahead, on ${expectedBranch})`)

    const cdp = await connect()

    console.log('\n── the upstream page ──')
    const result = await cdp.evaluate(`
        // Only the active tab is in the DOM, so Settings has to be opened *and*
        // selected before anything can be read off it. The toolbar provider is
        // the way in — a module specifier cannot be resolved from here.
        const root = window.ng.getComponent(document.querySelector('app-root'))
        const provider = (root.toolbarButtonProviders || [])
            .find(x => x.constructor.name === 'ButtonProvider')
        await provider.open()
        await new Promise(r => setTimeout(r, 1000))
        const tab = root.app.tabs.find(t => t.constructor.name === 'SettingsTabComponent')
        root.app.selectTab(tab)
        // Long enough for the nav to be built. Too short here and the page list
        // comes back empty, which reads exactly like the plugin not loading.
        for (let i = 0; i < 30; i++) {
            if (document.querySelectorAll('settings-tab .nav-link').length) { break }
            await new Promise(r => setTimeout(r, 100))
        }

        const links = [...document.querySelectorAll('settings-tab .nav-link')]
        const target = links.find(x => x.textContent.includes('Upstream'))
        if (!target) {
            return { error: 'no Upstream page in the settings nav: ' + links.map(x => x.textContent.trim()).join(' | ') }
        }
        target.click()
        await new Promise(r => setTimeout(r, 1500))

        const el = document.querySelector('upstream-settings-tab')
        if (!el) { return { error: 'upstream page did not render' } }
        const page = window.ng.getComponent(el)
        // Give the git calls time to land.
        for (let i = 0; i < 40 && page.loading; i++) { await new Promise(r => setTimeout(r, 100)) }
        window.ng.applyChanges(page)

        const text = el.textContent
        return {
            error: page.error,
            problem: page.status && page.status.problem,
            repository: page.status && page.status.repository,
            branch: page.status && page.status.branch,
            upstreamRef: page.status && page.status.upstreamRef,
            behind: page.behindCount,
            ahead: page.aheadCount,
            fetchedAgo: page.fetchedAgo,
            stale: page.fetchIsStale,
            firstAhead: page.status && page.status.ahead[0] && page.status.ahead[0].subject,
            rendersHeading: text.includes('Not pulled in yet'),
            rendersCarried: text.includes('Carried on top'),
            upstreamUrl: page.status && page.status.upstreamUrl,
        }
    `)

    if (result.error) {
        console.log(`  FAIL ${result.error}`)
        process.exit(1)
    }

    check('no problem reported', result.problem, '')
    const samePath = (p) => p.replace(/\\/g, '/').toLowerCase()
    check('found this checkout', samePath(result.repository), samePath(REPO))
    check('reports the right branch', result.branch, expectedBranch)
    check('compares against upstream/master', result.upstreamRef, 'upstream/master')
    check('behind count matches git', result.behind, expectedBehind)
    check('ahead count matches git', result.ahead, expectedAhead)
    check('resolved the upstream web url', result.upstreamUrl, 'https://github.com/Eugeny/tabby')
    check('the page rendered both sections', result.rendersHeading && result.rendersCarried, true)
    // The newest local commit should be the one git also calls newest.
    check('the newest local patch matches git',
        result.firstAhead, git('log', '-1', '--format=%s', 'HEAD'))
    console.log(`       last fetched: ${result.fetchedAgo || 'never'} (stale: ${result.stale})`)

    cdp.close()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
