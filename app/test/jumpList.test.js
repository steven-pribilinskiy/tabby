// The Windows jump list carries each profile's own icon.
//
//   node app/test/jumpList.test.js
//
// Needs a built dev build (`yarn build`, or at least the app and plugin
// bundles). One real launch of a hidden dev instance, ~40s.
//
// The dev build is electron.exe; the installed Tabby is Tabby.exe and holds
// live sessions. Nothing here touches it: the Tabby.exe count is taken before
// and after, only the PID we spawned is stopped, and a drop fails the run.
//
// A jump list is not process-local — it is shell state, keyed on the app's
// AppUserModelID, and writing one is visible to the whole desktop. So this test
// is careful twice over:
//
//   * every check that matters is made against `JumpListService.build()`, which
//     produces the categories and the icon files and publishes nothing;
//   * the one call that does publish is made only after the instance has been
//     given a scratch AppUserModelID of its own, and the file it leaves behind
//     is deleted afterwards.
//
// And it is checked rather than assumed: every `.customDestinations-ms` file
// that names a `Tabby.exe` — that is, belongs to a packaged build rather than
// to this electron.exe — is hashed before the run and must hash the same after.
// Measured on this machine before writing any of it, the dev build already
// keeps its own file (its entries name
// `…\projects\tabby\node_modules\electron\dist\electron.exe`) separate from the
// packaged builds' (`…\Tabby\builds\dev\Tabby.exe`), so the two identities are
// genuinely distinct — but "genuinely distinct" is exactly the kind of thing
// that stops being true quietly, so the run asserts it instead of relying on it.
//
// What is under test:
//
//   Upstream built the list with `iconPath: process.execPath` for every entry,
//   so the menu was a column of identical Tabby logos. Profile icons are a Font
//   Awesome class or an inline SVG document and the shell can draw neither, so
//   they are rasterized to `.ico` files first. An icon that cannot be drawn
//   falls back to the app icon; the entry is never dropped, and never blank.
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..', '..')
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const cdp = require(path.join(root, 'scripts', 'dev', 'cdp.cjs'))

let PORT = 0

if (process.platform !== 'win32') {
    console.log('skip  written against the Windows dev build')
    process.exit(0)
}
if (!fs.existsSync(electron) || !fs.existsSync(path.join(root, 'app', 'dist', 'main.js'))) {
    console.log('skip  no built dev build to launch')
    process.exit(0)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── The fixture ─────────────────────────────────────────────────────────────

// A filled circle rather than anything clever: the point is that pixels land,
// and `fill="currentColor"` is what Font Awesome's own SVG icons say, so the
// tinting path is the one the real icons take.
const SVG_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">'
    + '<circle cx="12" cy="12" r="11" fill="currentColor"/></svg>'

// A quote and a trailing backslash: the two characters the CRT's argument
// rules treat specially, in the two positions that matter.
const QUOTED_NAME = 'JL "q\\'

const FIXTURES = [
    { id: 'local:custom:jl-glyph', type: 'local', name: 'JL Glyph', icon: 'fas fa-desktop', options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-svg', type: 'local', name: 'JL Svg', icon: SVG_ICON, options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-brand', type: 'local', name: 'JL Brand', icon: 'fab fa-windows', options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-broken', type: 'local', name: 'JL Broken', icon: 'fas fa-definitely-not-an-icon', options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-markup', type: 'local', name: 'JL Markup', icon: '<not really svg', options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-none', type: 'local', name: 'JL None', icon: '', options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-quote', type: 'local', name: QUOTED_NAME, icon: 'fas fa-terminal', options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-dupe-a', type: 'local', name: 'JL Duplicate', icon: 'fas fa-cube', options: { command: 'cmd.exe' } },
    { id: 'local:custom:jl-dupe-b', type: 'local', name: 'JL Duplicate', icon: 'fas fa-cubes', options: { command: 'cmd.exe' } },
]

// YAML is a superset of JSON, and `app/lib/config.ts` parses with js-yaml — so
// the fixture is written as JSON and none of these names or icons has to
// survive being hand-quoted.
const CONFIG = {
    version: 8,
    terminal: { profile: 'local:cmd' },
    hotkeys: { 'toggle-window': [] },
    enableWelcomeTab: false,
    enableAutomaticUpdates: false,
    recoverTabs: false,
    // A scratch instance must not take the global hotkey or the MCP port from
    // the Tabby the user is actually using.
    pluginBlacklist: ['mcp-server', 'claude', 'claude-status'],
    profiles: FIXTURES,
}

// ── The desktop's jump lists ────────────────────────────────────────────────

const CUSTOM_DESTINATIONS = path.join(
    process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Recent', 'CustomDestinations')

function listing () {
    try {
        return fs.readdirSync(CUSTOM_DESTINATIONS)
    } catch {
        return []
    }
}

/**
 * Every jump list on this desktop that belongs to a packaged Tabby.
 *
 * The file is a stream of shell links; the paths inside are UTF-16, so naming
 * a `Tabby.exe` is enough to tell a packaged build's list from this
 * electron.exe's. Hashed, because a mtime says less than the bytes do.
 */
function packagedJumpLists () {
    const out = new Map()
    for (const name of listing()) {
        const file = path.join(CUSTOM_DESTINATIONS, name)
        let contents
        try {
            contents = fs.readFileSync(file)
        } catch {
            continue
        }
        if (!contents.toString('utf16le').toLowerCase().includes('tabby.exe')) {
            continue
        }
        out.set(name, crypto.createHash('sha256').update(contents).digest('hex'))
    }
    return out
}

// ── Reading an .ico ─────────────────────────────────────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Parse an icon file far enough to say whether Windows would accept it.
 *
 * Not a length check: a file of the right size full of the wrong bytes is
 * exactly the failure this is meant to catch. The directory is walked, every
 * entry's payload is required to be a PNG, and each PNG's own IHDR dimensions
 * are required to agree with the size the directory claims for it.
 */
function readIco (file) {
    const buf = fs.readFileSync(file)
    if (buf.length < 6) {
        return { error: 'shorter than an icon directory' }
    }
    if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
        return { error: `not an ICO — first four bytes are ${buf.subarray(0, 4).toString('hex')}` }
    }
    const count = buf.readUInt16LE(4)
    if (!count || buf.length < 6 + 16 * count) {
        return { error: `claims ${count} images but is ${buf.length} bytes` }
    }
    const entries = []
    for (let i = 0; i < count; i++) {
        const at = 6 + 16 * i
        // 0 means 256 in the directory; nothing here writes one that big.
        const width = buf.readUInt8(at) || 256
        const height = buf.readUInt8(at + 1) || 256
        const planes = buf.readUInt16LE(at + 4)
        const bpp = buf.readUInt16LE(at + 6)
        const bytes = buf.readUInt32LE(at + 8)
        const offset = buf.readUInt32LE(at + 12)
        if (offset + bytes > buf.length) {
            return { error: `image ${i} runs past the end of the file` }
        }
        const payload = buf.subarray(offset, offset + bytes)
        const png = payload.subarray(0, 8).equals(PNG_SIGNATURE)
        entries.push({
            width,
            height,
            planes,
            bpp,
            bytes,
            png,
            // IHDR is the first chunk, so its width and height sit at a fixed
            // offset in every PNG there is.
            pngWidth: png ? payload.readUInt32BE(16) : 0,
            pngHeight: png ? payload.readUInt32BE(20) : 0,
        })
    }
    return { size: buf.length, count, entries }
}

/** Everything wrong with an icon file, as a list of sentences. */
function icoProblems (file, expectedSizes) {
    const ico = readIco(file)
    if (ico.error) {
        return [ico.error]
    }
    const problems = []
    const sizes = ico.entries.map(e => e.width)
    if (sizes.join(',') !== expectedSizes.join(',')) {
        problems.push(`sizes are ${sizes.join('/')}, expected ${expectedSizes.join('/')}`)
    }
    for (const [i, entry] of ico.entries.entries()) {
        if (entry.width !== entry.height) {
            problems.push(`image ${i} is ${entry.width}x${entry.height}, not square`)
        }
        if (entry.planes !== 1 || entry.bpp !== 32) {
            problems.push(`image ${i} declares ${entry.planes} plane(s) at ${entry.bpp}bpp`)
        }
        if (!entry.png) {
            problems.push(`image ${i} is not a PNG`)
        } else if (entry.pngWidth !== entry.width || entry.pngHeight !== entry.height) {
            problems.push(`image ${i} says ${entry.width}px but its PNG is ${entry.pngWidth}x${entry.pngHeight}`)
        }
    }
    return problems
}

// ── Launching ───────────────────────────────────────────────────────────────

const live = []

function launch (label) {
    const dir = path.join(os.tmpdir(), `tabby-jumplist-${label}`)
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.yaml'), JSON.stringify(CONFIG, null, 2))

    // `--user-data-dir` must precede the app path or Electron hands the switch
    // to the app and silently ignores it, sharing %APPDATA%\tabby with the
    // installed Tabby. NODE_PATH is scrubbed to this repo for the same reason
    // it is everywhere else here: an inherited one points at another build's
    // plugins.
    const child = spawn(electron, [
        `--user-data-dir=${dir}`,
        `--remote-debugging-port=${PORT}`,
        'app',
        '--hidden',
        '--enable-logging=stderr',
    ], {
        cwd: root,
        env: {
            ...process.env,
            NODE_PATH: path.join(root, 'app', 'node_modules'),
            TABBY_PLUGINS: '',
            TABBY_DEV: '1',
            TABBY_CONFIG_DIRECTORY: dir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    })

    const log = fs.createWriteStream(path.join(dir, 'launch.log'))
    child.stdout.pipe(log)
    child.stderr.pipe(log)

    const handle = { label, dir, pid: child.pid, exit: null }
    child.on('exit', code => { handle.exit = code })
    live.push(handle)
    return handle
}

function stop (handle) {
    if (handle.exit !== null) {
        return
    }
    try {
        // By PID, never by name.
        execFileSync('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch { /* already gone */ }
}

function tabbyCount () {
    try {
        return parseInt(execFileSync('powershell', [
            '-NoProfile', '-Command',
            '@(Get-Process Tabby -ErrorAction SilentlyContinue).Count',
        ], { encoding: 'utf8' }).trim(), 10)
    } catch {
        return -1
    }
}

// ── Checks ──────────────────────────────────────────────────────────────────

let failed = 0

function check (ok, message) {
    console.log(`${ok ? 'ok   ' : 'FAIL '} ${message}`)
    if (!ok) {
        failed++
    }
}

const titled = (category, title) => category?.items.find(item => item.title === title)

// ── The run ─────────────────────────────────────────────────────────────────

const beforeTabby = tabbyCount()
const beforePackaged = packagedJumpLists()
const beforeListing = new Set(listing())

async function main () {
    PORT = parseInt(process.env.CDP_PORT ?? '', 10) || await cdp.pickPort()
    console.log(`     debugging on port ${PORT}`)
    console.log(`     ${beforePackaged.size} packaged jump list(s) on this desktop, hashed`)

    const instance = launch('build')
    const driver = await cdp.connect({ port: PORT, timeoutMs: 60000 })

    // The instance builds its own jump list once on `config.ready$`, and that
    // pass prunes. Starting a second pass on top of it is not wrong — both draw
    // the same files, and a rename replaces — but a prune from the first can
    // remove a file the second has just handed out, which would fail the
    // pruning check below for a reason that has nothing to do with pruning.
    await sleep(4000)

    // ── The list, built but not published ───────────────────────────────
    const built = await driver.evaluate(`
        const plugin = window.nodeRequire('tabby-electron')
        const core = window.nodeRequire('tabby-core')
        const injector = window.ng.getInjector(document.querySelector('app-root'))
        const jumpList = injector.get(plugin.JumpListService)
        const icons = injector.get(plugin.JumpListIconsService)
        const profiles = injector.get(core.ProfilesService)
        const all = await profiles.getProfiles()
        const ids = ${JSON.stringify(FIXTURES.map(p => p.id))}
        const mine = ids.map(id => all.find(p => p.id === id)).filter(p => p)
        // Kept for the later phases; the same singletons the app uses.
        window.__jl = { jumpList, icons, profiles, config: injector.get(core.ConfigService), all, mine }
        return {
            supported: jumpList.isSupported(),
            execPath: process.execPath,
            directory: icons.directory(),
            foreground: icons.foreground(),
            found: mine.map(p => p.id),
            total: all.length,
            categories: await jumpList.build(mine.slice(0, 2), all),
        }
    `)

    check(built.supported, 'the service reports the jump list as supported on this build')
    check(built.found.length === FIXTURES.length,
        `all ${FIXTURES.length} fixture profiles are in the profile list (${built.found.length} found)`)
    console.log(`     ${built.total} profiles in all; icons cached in ${built.directory}`)
    console.log(`     monochrome icons are drawn in ${built.foreground} (the system taskbar theme)`)

    const categories = built.categories ?? []
    check(categories.length === 2 && categories[0].name === 'Recent' && categories[1].name === 'Profiles',
        `two categories, Recent then Profiles (${categories.map(c => `${c.name}:${c.items.length}`).join(', ')})`)

    const recent = categories[0]
    const listed = categories[1]
    check(recent?.items.length === 2 && recent.items.every((item, i) => item.args === `recent ${i}`),
        `Recent holds the two most recent profiles, by index (${recent?.items.map(i => i.args).join(', ')})`)

    // ── The launch arguments ────────────────────────────────────────────
    const glyph = titled(listed, 'JL Glyph')
    check(glyph?.args === 'profile "JL Glyph"' && glyph.program === built.execPath,
        `an entry launches this build with the documented command (${glyph?.program ? path.basename(glyph.program) : '?'} ${glyph?.args})`)

    const quoted = titled(listed, QUOTED_NAME)
    // "JL \"q\\"  — the CRT gives that back as  JL "q\
    check(quoted?.args === 'profile "JL \\"q\\\\"',
        `a name with a quote and a trailing backslash is escaped for the CRT (${JSON.stringify(quoted?.args)})`)

    const duplicates = listed?.items.filter(item => item.title === 'JL Duplicate') ?? []
    check(duplicates.length === 1,
        `two profiles sharing a name produce one entry, not an unreachable second (${duplicates.length})`)

    // ── The icons ───────────────────────────────────────────────────────
    const svg = titled(listed, 'JL Svg')
    const brand = titled(listed, 'JL Brand')
    const broken = titled(listed, 'JL Broken')
    const markup = titled(listed, 'JL Markup')
    const none = titled(listed, 'JL None')

    const rasterized = entry => !!entry
        && entry.iconPath.toLowerCase().startsWith(built.directory.toLowerCase())
        && entry.iconPath.endsWith('.ico')

    check(rasterized(glyph), `a Font Awesome glyph became an icon file (${path.basename(glyph?.iconPath ?? '-')})`)
    check(rasterized(svg), `an inline SVG became an icon file (${path.basename(svg?.iconPath ?? '-')})`)
    check(rasterized(brand), `a brands-font glyph became one too (${path.basename(brand?.iconPath ?? '-')})`)
    check(glyph?.iconPath !== svg?.iconPath, 'and two different icons are two different files')

    for (const [label, entry] of [['an unknown class', broken], ['markup that will not parse', markup], ['no icon at all', none]]) {
        check(!!entry && entry.iconPath === built.execPath && entry.iconIndex === 0,
            `${label} still gets an entry, wearing the app icon (${entry ? path.basename(entry.iconPath) : 'no entry'})`)
    }

    const SIZES = [16, 24, 32, 48]
    for (const [label, entry] of [['the glyph', glyph], ['the SVG', svg], ['the brand glyph', brand]]) {
        if (!rasterized(entry)) {
            continue
        }
        const problems = icoProblems(entry.iconPath, SIZES)
        const ico = readIco(entry.iconPath)
        check(problems.length === 0, problems.length
            ? `${label} icon is malformed: ${problems.join('; ')}`
            : `${label} icon is a real ICO — ${ico.count} PNG images at ${ico.entries.map(e => e.width).join('/')}px, ${ico.size} bytes`)
    }

    // ── An empty category is rejected by the shell, so it is not sent ────
    const noRecent = await driver.evaluate(`
        return await window.__jl.jumpList.build([], window.__jl.all)
    `)
    check(noRecent.length === 1 && noRecent[0].name === 'Profiles',
        `with nothing recently opened the Recent category is dropped rather than sent empty `
        + `(${noRecent.map(c => c.name).join(', ')})`)

    // ── Pruning, and a cached file that has gone missing ─────────────────
    const before = fs.readdirSync(built.directory).length
    await driver.evaluate(`
        const glyph = window.__jl.mine.find(p => p.id === 'local:custom:jl-glyph')
        return await window.__jl.jumpList.build([], [glyph])
    `)
    const after = fs.readdirSync(built.directory)
    check(after.length === 1 && path.join(built.directory, after[0]) === glyph?.iconPath,
        `a pass prunes what it did not draw — ${before} files, then ${after.length}`)

    fs.unlinkSync(glyph.iconPath)
    const redrawn = await driver.evaluate(`
        const glyph = window.__jl.mine.find(p => p.id === 'local:custom:jl-glyph')
        const categories = await window.__jl.jumpList.build([], [glyph])
        return categories[0].items[0].iconPath
    `)
    check(redrawn === glyph.iconPath && fs.existsSync(redrawn),
        'a cached icon that has been swept off disk is drawn again rather than handed out missing')

    // ── The list follows the profiles ───────────────────────────────────
    //
    // Through the real wiring: `DockMenuService` subscribes to `config.changed$`,
    // and every path that changes a build — including `tabby-builds`' "make this
    // the active build", which is a `config.save()` — goes through it.
    const changed = await driver.evaluate(`
        const { jumpList, config } = window.__jl
        const calls = []
        const real = jumpList.update
        // Recorded, not called through: publishing is the one thing this test
        // does not do behind its own back.
        jumpList.update = async (recent, profiles) => { calls.push(profiles.map(p => p.name)) }
        try {
            config.store.profiles.push({
                id: 'local:custom:jl-added', type: 'local', name: 'JL Added',
                icon: 'fas fa-plug', options: { command: 'cmd.exe' },
            })
            await config.save()
            await new Promise(resolve => setTimeout(resolve, 1500))
        } finally {
            jumpList.update = real
        }
        return { calls: calls.length, sawIt: calls.some(names => names.includes('JL Added')) }
    `)
    check(changed.calls > 0 && changed.sawIt,
        `saving a new profile rebuilt the jump list, and the new profile was in it `
        + `(${changed.calls} rebuild(s))`)

    // ── Everywhere else, it does nothing at all ─────────────────────────
    // Both halves of the guard: the platform is not Windows, and — which is
    // what macOS and Linux actually look like — `app.setJumpList` is not there
    // to call. The spy replaces the service's own reference to `app` rather
    // than reaching across `@electron/remote` and mutating the main process.
    const elsewhere = await driver.evaluate(`
        const plugin = window.nodeRequire('tabby-electron')
        const injector = window.ng.getInjector(document.querySelector('app-root'))
        const { jumpList, all } = window.__jl
        const electron = injector.get(plugin.ElectronService)
        const realApp = electron.app
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
        if (!descriptor.configurable) {
            return { redefined: false }
        }
        const out = { redefined: true, published: 0, threw: null }
        try {
            electron.app = { setJumpList: () => { out.published++; return 'ok' } }
            Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' })
            out.notWindows = jumpList.isSupported()
            await jumpList.update([], all)
            Object.defineProperty(process, 'platform', descriptor)

            electron.app = {}
            out.noMethod = jumpList.isSupported()
            await jumpList.update([], all)
        } catch (err) {
            out.threw = String(err)
        } finally {
            Object.defineProperty(process, 'platform', descriptor)
            electron.app = realApp
        }
        return out
    `)
    if (elsewhere.redefined) {
        check(elsewhere.notWindows === false && elsewhere.noMethod === false
            && elsewhere.published === 0 && !elsewhere.threw,
        'off Windows, and with no setJumpList to call, it is a silent no-op — '
            + `nothing published, nothing thrown (${JSON.stringify(elsewhere)})`)
    } else {
        check(false, 'process.platform could not be redefined, so the non-Windows path went unchecked')
    }

    // ── Publishing, under an identity of its own ────────────────────────
    //
    // The only call here that reaches the shell. The AppUserModelID is changed
    // first, so whatever this writes lands on a name nothing else owns; the
    // file it creates is deleted below.
    const AUMID = `org.tabby.jumplist-test.${process.pid}`
    const published = await driver.evaluate(`
        const remote = window.nodeRequire('@electron/remote')
        remote.app.setAppUserModelId(${JSON.stringify(AUMID)})
        const categories = await window.__jl.jumpList.build(window.__jl.mine.slice(0, 2), window.__jl.all)
        return { result: remote.app.setJumpList(categories), items: categories.reduce((n, c) => n + c.items.length, 0) }
    `)
    check(published.result === 'ok',
        `the shell accepted the list under a scratch AppUserModelID — ${published.items} entries, `
        + `answered ${JSON.stringify(published.result)}`)

    // Whatever that produced is ours and nobody else's; take it away again.
    for (let i = 0; i < 10 && !newFiles().length; i++) {
        await sleep(300)
    }
    const created = newFiles()
    for (const name of created) {
        try {
            fs.unlinkSync(path.join(CUSTOM_DESTINATIONS, name))
        } catch { /* the shell may still hold it; it names nothing real either way */ }
    }
    check(created.length <= 1,
        `publishing created ${created.length} jump list file(s), now removed`
        + (created.length ? ` (${created.join(', ')})` : ''))

    driver.close()
    stop(instance)
}

function newFiles () {
    return listing().filter(name => !beforeListing.has(name))
}

// Nothing here should take four minutes. A hang is a result too.
const overall = setTimeout(() => {
    console.error('FAIL  the run did not finish in 4 minutes')
    for (const handle of live) {
        stop(handle)
    }
    process.exit(1)
}, 4 * 60 * 1000)

main().catch(err => {
    console.error('FAIL  the test itself threw:', err)
    failed++
}).finally(async () => {
    clearTimeout(overall)
    cdp.closeAll()
    for (const handle of live) {
        stop(handle)
    }
    await sleep(1000)

    // The guarantee, checked rather than assumed: no packaged build's jump list
    // moved while a dev build was running and writing its own.
    const afterPackaged = packagedJumpLists()
    const moved = [...beforePackaged].filter(([name, digest]) => afterPackaged.get(name) !== digest)
    if (moved.length) {
        console.error(`REFUSING TO PASS: a packaged Tabby's jump list changed during the run: `
            + moved.map(([name]) => name).join(', '))
        process.exitCode = 3
        return
    }
    console.log(`ok    ${beforePackaged.size} packaged Tabby jump list(s) byte-identical after the run`)

    const afterTabby = tabbyCount()
    if (afterTabby < beforeTabby) {
        console.error(`REFUSING TO PASS: Tabby.exe count fell ${beforeTabby} -> ${afterTabby}`)
        process.exit(3)
    }
    console.log(`Tabby.exe ${beforeTabby} -> ${afterTabby}`)
    process.exitCode = failed ? 1 : 0
})
