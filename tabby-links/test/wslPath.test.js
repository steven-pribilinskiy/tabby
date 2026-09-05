// The resolution *order*, proved against the real filesystem.
//
// `filesystemPath` is a table of strings and `logic.test.js` checks it as one.
// What was broken was not the translation but when it ran: existence was asked
// of the path as written — `fs.access('/home/you/notes.md')`, which Windows
// answers about `C:\home\you\notes.md` — and that answer gated the translation
// that would have made the path real. Both halves are claims about a machine,
// so they are measured on one.
//
//   node tabby-links/test/wslPath.test.js
//   WSL_DISTRO=Debian WSL_PATH=/etc node tabby-links/test/wslPath.test.js
//
// Needs nothing running: no dev build, no app, and no distro is started — the
// share is only read, and the tab that would print such a path has the distro
// up by definition.

const fs = require('fs')
const path = require('path')
const Module = require('module')
const { execFileSync } = require('child_process')

const REPO = path.resolve(__dirname, '../..')

let passed = 0
let failed = 0
function check (name, actual, expected) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) {
        passed++
    } else {
        failed++
        console.log(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`)
    }
}

// The service is loaded from source through a `.ts` require hook, the way
// `logic.test.js` reaches the same helpers. Only the decorators are evaluated
// at module scope, so stubbing them is enough.
const stubs = {
    '@angular/core': new Proxy({}, { get: () => (() => (target) => target) }),
    'tabby-core': new Proxy({}, { get: (_t, k) => k === '__esModule' ? true : class Stub {} }),
    'tabby-terminal': new Proxy({}, { get: () => class Stub {} }),
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
    return stubs[request] ? request : originalResolve.call(this, request, ...rest)
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
    return stubs[request] ?? originalLoad.call(this, request, ...rest)
}
const ts = require(path.join(REPO, 'node_modules/typescript'))
Module._extensions['.ts'] = function (module, filename) {
    const source = fs.readFileSync(filename, 'utf8')
    module._compile(ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText, filename)
}
const { filesystemPath } = require(path.join(REPO, 'tabby-links/src/services/linkTarget.service.ts'))

function exists (p) {
    try {
        fs.accessSync(p)
        return true
    } catch {
        return false
    }
}

// `wsl -l -q` lists the default distro first, and lists without starting one.
function distros () {
    try {
        return execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer' })
            .toString('utf16le')
            .split('\n')
            .map(x => x.trim())
            .filter(x => x)
    } catch {
        return []
    }
}

if (process.platform !== 'win32') {
    console.log('skipped: WSL paths are a Windows question')
    process.exit(0)
}

const distro = process.env.WSL_DISTRO || distros()[0]
const posix = process.env.WSL_PATH || '/etc/hosts'
if (!distro || !exists(`\\\\wsl.localhost\\${distro}`)) {
    console.log(`skipped: no reachable WSL distro (${distro || 'none registered'})`)
    process.exit(0)
}
console.log(`── ${distro}: ${posix} ──`)

// What the shipped code did, kept here so the two orderings can be compared
// rather than asserted about. `BaseFileHandler.verify` is `fs.access` on the
// string as written and ignores the tab it is handed
// (tabby-linkifier/src/handlers.ts).
function oldOrdering (text) {
    const isFileLike = exists(text)
    if (!isFileLike) {
        return ''
    }
    return filesystemPath(text, distro, true)
}
// Upstream's `verify` is the load-bearing half of that. If it ever stops being
// a bare `fs.access` on the uri, this comparison is measuring the wrong thing.
const upstream = fs.readFileSync(path.join(REPO, 'tabby-linkifier/src/handlers.ts'), 'utf8')
check('upstream verify is still fs.access on the uri as written',
    /async verify \(uri: string\)[^}]*await fs\.access\(uri\)/.test(upstream), true)

check('the path as written is not reachable from Windows', exists(posix), false)
check('the old ordering never got as far as translating', oldOrdering(posix), '')

const resolved = filesystemPath(posix, distro, true)
check('the translated path is the distro share',
    resolved, `\\\\wsl.localhost\\${distro}${posix.replace(/\//g, '\\')}`)
check('and it is reachable', exists(resolved), true)

// The form Claude Code emits for `hosts:6-7`, which carried its fragment into
// both the existence check and the share path.
const withFragment = `file://${posix}#L6-L7`
check('a file:// URI with a fragment resolves to the same path',
    filesystemPath(withFragment, distro, true), resolved)
check('and it is reachable too',
    exists(filesystemPath(withFragment, distro, true)), true)
check('the old ordering could not reach that one either',
    oldOrdering(withFragment), '')

// A Windows drive mounted into the distro resolves to the drive itself, which
// is the same file without the 9p server in the way.
const mounted = filesystemPath('/mnt/c/Windows/System32/drivers/etc/hosts', distro, true)
check('a /mnt path is the Windows path', mounted, 'C:\\Windows\\System32\\drivers\\etc\\hosts')
check('and it is reachable', exists(mounted), true)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
