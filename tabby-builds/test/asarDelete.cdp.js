// Deleting a build must not trip over its own app.asar.
//
//   node scripts/dev/launch-hidden.mjs --enable builds --port 9239 &
//   CDP_PORT=9239 node tabby-builds/test/asarDelete.cdp.js
//
// Electron patches `fs` so an `.asar` archive looks like a directory, and the
// first patched call on one opens the archive and holds the handle for the
// life of the process. Sizing a build was such a call, so by the time you
// pressed Delete the archive was pinned by the renderer itself and the
// removal died on it:
//
//   EBUSY: resource busy or locked, rmdir '…\resources\app.asar'
//
// Two fixtures, because the fix is only meaningful next to the bug. The
// control is touched through the patched `fs` first and must still fail that
// way — which is also what proves the fixture is an archive Electron
// recognises, rather than a file it ignores. The subject is walked and deleted
// by the real services, and must come out gone.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { connect } = require('./cdp')

const TMP = path.join(os.tmpdir(), `tabby-builds-asar-${process.pid}`)

/**
 * A minimal but genuine asar: four little-endian uint32s — 4, the header
 * pickle's size, its payload's size, the JSON's length — then the JSON padded
 * to a multiple of 4, then the file contents. Hand-written rather than taken
 * from `@electron/asar`, which is a transitive dependency of the packager and
 * has no business being one of this test's.
 */
function writeAsar (file, contents) {
    let offset = 0
    const files = {}
    const bodies = []
    for (const [name, text] of Object.entries(contents)) {
        const body = Buffer.from(text, 'utf8')
        files[name] = { size: body.length, offset: String(offset) }
        offset += body.length
        bodies.push(body)
    }
    const json = Buffer.from(JSON.stringify({ files }), 'utf8')
    const padded = Math.ceil(json.length / 4) * 4
    const header = Buffer.alloc(16 + padded)
    header.writeUInt32LE(4, 0)
    header.writeUInt32LE(padded + 8, 4)
    header.writeUInt32LE(padded + 4, 8)
    header.writeUInt32LE(json.length, 12)
    json.copy(header, 16)
    fs.writeFileSync(file, Buffer.concat([header, ...bodies]))
}

/** A build directory shaped like a frozen slot: read-only, with an archive. */
function fixture (name) {
    const root = path.join(TMP, name)
    fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'Tabby.exe'), 'not really an executable')
    writeAsar(path.join(root, 'resources', 'app.asar'), {
        'index.js': 'console.log("hello")\n',
        'package.json': '{"name":"fixture","main":"index.js"}',
    })
    for (const f of ['Tabby.exe', 'resources/app.asar']) {
        fs.chmodSync(path.join(root, f), 0o444)
    }
    return root
}

/** What the walk should find: every real file, the archive counted as one. */
function subjectSize (root) {
    const files = [path.join(root, 'Tabby.exe'), path.join(root, 'resources', 'app.asar')]
    return { files: files.length, bytes: files.reduce((n, f) => n + fs.statSync(f).size, 0) }
}

function fail (message) {
    console.error(`FAIL  ${message}`)
    process.exitCode = 1
}

function ok (message) {
    console.log(`ok    ${message}`)
}

// The control's archive is open in the renderer by the time we get here, so
// Windows will not let this process unlink it either. Best effort.
function cleanup () {
    try {
        fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch { /* goes with the instance */ }
}

async function main () {
    fs.rmSync(TMP, { recursive: true, force: true })
    const control = fixture('control')
    const subject = fixture('subject')
    const expected = subjectSize(subject)
    const cdp = await connect()

    // ── The bug, still reproducible on demand ────────────────────────────
    const before = await cdp.evaluate(`
        const fs = require('fs')
        const stat = fs.lstatSync(${JSON.stringify(path.join(control, 'resources', 'app.asar'))})
        let error = null
        try {
            await fs.promises.rm(${JSON.stringify(control)}, { recursive: true, force: true })
        } catch (err) {
            error = { code: err.code, syscall: err.syscall }
        }
        return { isDirectory: stat.isDirectory(), error }
    `)
    if (!before.isDirectory) {
        fail('the fixture is not an archive Electron recognises — the rest of this test proves nothing')
        cleanup()
        return
    }
    ok('patched fs reports the archive as a directory')
    if (before.error?.code === 'EBUSY' && before.error.syscall === 'rmdir') {
        ok('patched fs cannot delete a build containing one (EBUSY on rmdir), as reported')
    } else {
        fail(`expected EBUSY/rmdir from the patched fs, got ${JSON.stringify(before.error)}`)
    }

    // ── The fix: the real services, over an untouched build ──────────────
    const result = await cdp.evaluate(`
        const plugin = window.nodeRequire('tabby-builds')
        const injector = window.ng.getInjector(document.querySelector('app-root'))
        const sizes = injector.get(plugin.BuildSizeService)
        const actions = injector.get(plugin.BuildActionsService)
        const root = ${JSON.stringify(subject)}
        const build = {
            id: root.toLowerCase(), kind: 'portable', name: 'fixture', root, extraPaths: [],
            executable: null, stampPath: null, version: null, builtAt: null, arch: null,
            git: null, repoPath: null, configPath: null, uninstaller: null, upstreamBase: null,
            detail: 'test fixture', isCurrent: false, isActive: false, exists: true,
            processes: [], size: null, sizeState: 'idle', health: null,
        }

        // What the page does on its own: measure every build it lists.
        await new Promise(resolve => sizes.request(build, resolve))
        // Read before the delete: a successful one invalidates the cached size.
        const size = build.size

        // The confirmation is a native modal; a hidden instance must not put
        // one on screen, so it is answered rather than shown.
        const said = []
        const platform = actions.platform
        const notifications = actions.notifications
        const realBox = platform.showMessageBox
        const realError = notifications.error
        const realInfo = notifications.info
        platform.showMessageBox = async () => ({ response: 1 })
        notifications.error = m => said.push(['error', m])
        notifications.info = m => said.push(['info', m])
        try {
            await actions.delete(build, () => {})
        } finally {
            platform.showMessageBox = realBox
            notifications.error = realError
            notifications.info = realInfo
        }
        return { size, said, exists: build.exists }
    `)

    // The archive is counted once, at its own size, rather than walked into as
    // if it were the directory the patched fs claims it is.
    if (result.size && result.size.files === expected.files && result.size.bytes === expected.bytes) {
        ok(`the size walk counted the archive as one file (${result.size.files} files, ${result.size.bytes} bytes)`)
    } else {
        fail(`expected ${JSON.stringify(expected)} from the size walk, got ${JSON.stringify(result.size)}`)
    }
    const [kind, message] = result.said[0] ?? []
    if (kind === 'info') {
        ok(`delete reported success: ${message}`)
    } else {
        fail(`delete reported ${kind}: ${message}`)
    }
    if (!fs.existsSync(subject)) {
        ok('the build is gone from disk, archive included')
    } else {
        fail(`still on disk: ${fs.readdirSync(path.join(subject, 'resources')).join(', ')}`)
    }

    cdp.close()
    cleanup()
}

main().catch(err => {
    console.error(err)
    process.exitCode = 1
    cleanup()
})
