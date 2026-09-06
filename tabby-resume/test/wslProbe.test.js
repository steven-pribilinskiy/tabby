// How a WSL pane is identified, against a real distro.
//
// None of a WSL pane's processes are Windows processes, so nothing Tabby knows
// about a pane — least of all its conpty pid — can be matched against them.
// The join is `TABBY_SESSION`, a per-pane token the session exports and lists
// in `WSLENV` so it crosses the boundary; every descendant of the pane's shell
// inherits it. This proves that end to end, including the two filters that
// make the answer usable: a detached daemon that inherited the same token is
// not the pane, and neither is anything a multiplexer owns.
//
//   node tabby-resume/test/wslProbe.test.js [distro]
//
// Starts its own processes inside the distro and kills them by pid. Never
// touches anything it did not start, and never the distro itself.
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const REPO = path.resolve(__dirname, '../..')

const DISTRO = process.argv[2] || 'Ubuntu'
const UID_A = `resume-test-a-${process.pid}`
const UID_B = `resume-test-b-${process.pid}`
const UID_C = `resume-test-c-${process.pid}`
const TMUX_SESSION = `resume-test-${process.pid}`

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
        console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`)
    }
}
function ok (name, condition, detail) {
    check(name, !!condition, true)
    if (!condition && detail !== undefined) {
        console.log(`       ${detail}`)
    }
}

// The service is loaded, not copied: the probe script is a shell program built
// out of a template literal, and a transcription of it into this file would be
// a different program the moment either changed. Angular is stubbed away —
// nothing in the module body needs it, only the decorators do.
const Module = require('module')
const ts = require(path.join(REPO, 'node_modules/typescript'))
Module._extensions['.ts'] = function (module, filename) {
    const js = ts.transpileModule(require('fs').readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText
    module._compile(js, filename)
}
const stubs = {
    '@angular/core': new Proxy({}, { get: () => (() => target => target) }),
    'tabby-core': new Proxy({}, { get: (_t, k) => k === '__esModule' ? true : class Stub {} }),
}
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
    return stubs[request] ? request : originalResolve.call(this, request, ...rest)
}
const originalLoad = Module._load
Module._load = function (request, ...rest) {
    return stubs[request] ?? originalLoad.call(this, request, ...rest)
}
const select = require(path.join(REPO, 'tabby-resume/src/select.ts'))
const recognize = require(path.join(REPO, 'tabby-resume/src/recognize.ts'))
const { WSL_PROBE_SCRIPT } = require(path.join(REPO, 'tabby-resume/src/services/paneCapture.service.ts'))

function wslSync (script, extraEnv) {
    return spawnSync('wsl.exe', ['-d', DISTRO, '--', 'sh', '-s'], {
        input: script,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ...extraEnv ?? {} },
    })
}

function runProbe () {
    const result = wslSync(WSL_PROBE_SCRIPT)
    if (result.error) {
        throw result.error
    }
    return select.parseProbe(result.stdout)
}

/**
 * A stand-in for a pane: an interactive bash on its own pty, carrying
 * TABBY_SESSION the same way a real pane does — set as a Windows environment
 * variable and named in WSLENV, which is the only thing that carries a
 * variable into a distro at all.
 *
 * `script` is what gives it a controlling terminal. Without one there is no
 * foreground process group, which is exactly what the probe reads, so a pane
 * faked with a pipe would prove nothing.
 */
function startPane (sessionUID) {
    const child = spawn('wsl.exe', ['-d', DISTRO, '--', 'script', '-qec', 'bash -i', '/dev/null'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, TABBY_SESSION: sessionUID, WSLENV: 'TABBY_SESSION' },
    })
    child.stdout.on('data', () => { })
    child.stderr.on('data', () => { })
    return child
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const started = []
function cleanup () {
    // By pid, and only pids from processes started here.
    const pids = []
    try {
        const listing = wslSync(`
            for f in /proc/[0-9]*/environ; do
              grep -aqs 'TABBY_SESSION=${UID_A}' "$f" 2>/dev/null && { d=\${f%/environ}; echo \${d##*/}; }
              grep -aqs 'TABBY_SESSION=${UID_B}' "$f" 2>/dev/null && { d=\${f%/environ}; echo \${d##*/}; }
            done
        `)
        for (const line of String(listing.stdout ?? '').split('\n')) {
            const pid = parseInt(line.trim(), 10)
            if (pid > 0) {
                pids.push(pid)
            }
        }
    } catch { }
    if (pids.length) {
        wslSync(`kill -9 ${pids.join(' ')} 2>/dev/null; exit 0`)
    }
    wslSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null; exit 0`)
    for (const child of started) {
        try {
            spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
        } catch { }
    }
    console.log(`  (cleaned up ${pids.length} linux pid(s) and ${started.length} wsl.exe process(es))`)
}

async function main () {
    console.log(`── a WSL pane is identified by TABBY_SESSION, across WSLENV (${DISTRO}) ──`)

    const paneA = startPane(UID_A)
    const paneB = startPane(UID_B)
    started.push(paneA, paneB)
    await sleep(2500)

    // Pane A runs a program; pane B runs nothing, and must not be confused for A.
    paneA.stdin.write('sleep 400\n')
    // A daemon started from a pane inherits its TABBY_SESSION and keeps it for
    // ever. Without the controlling-terminal filter this is indistinguishable
    // from the pane's own work.
    paneB.stdin.write('setsid sleep 401 >/dev/null 2>&1 &\n')
    await sleep(2500)

    let records = runProbe()
    ok('the probe answered at all', records.length > 0, `records: ${records.length}`)

    const foregroundA = select.foregroundOf(records, UID_A)
    ok('pane A reports the program it is running', !!foregroundA, JSON.stringify(records.filter(x => x.sessionUID === UID_A), null, 1))
    if (foregroundA) {
        check('and it is the sleep, not the shell', foregroundA.argv, ['sleep', '400'])
    }
    // The fixture puts a pty wrapper above the shell, which a real pane does
    // not have — see the relay check below — so pane B's idle shell is a
    // descendant here rather than the root. It is still nothing to resume, and
    // that is decided by name, one layer up.
    check('a pane running nothing has nothing to resume', planFor(select.foregroundOf(records, UID_B)), null)
    check('a session token nobody has matches nothing', select.foregroundOf(records, 'no-such-token'), null)
    check('an empty token matches nothing', select.foregroundOf(records, ''), null)

    const daemons = records.filter(x => x.sessionUID === UID_B && x.argv.join(' ').includes('401'))
    check('a detached daemon that inherited the pane token is filtered out', daemons.length, 0)

    console.log('── a multiplexer owns what it runs ──')
    // Started from pane B, so the server and everything inside it inherits
    // pane B's TABBY_SESSION — the exact way this goes wrong.
    paneB.stdin.write(`tmux new-session -d -s ${TMUX_SESSION} 'sleep 402'\n`)
    await sleep(1500)
    paneB.stdin.write(`tmux attach -t ${TMUX_SESSION}\n`)
    await sleep(2500)

    records = runProbe()
    const inside = records.filter(x => x.argv.join(' ').includes('402'))
    check('what tmux is running is never reported', inside.length, 0)

    const foregroundB = select.foregroundOf(records, UID_B)
    ok('pane B now reports tmux itself', !!foregroundB, JSON.stringify(records.filter(x => x.sessionUID === UID_B), null, 1))
    if (foregroundB) {
        check('and it is the attach, not the session inside it', recognize.baseName(foregroundB.argv[0]), 'tmux')
        const plan = recognize.buildPlan(
            { paneId: 'b', argv: foregroundB.argv },
            { agents: true, multiplexers: true, extra: [], excluded: [] },
        )
        check('which resumes as an attach, not a relaunch', plan,
            { command: `tmux new-session -A -s ${TMUX_SESSION}`, resumesAgentSession: false })
    }

    console.log('── the shell alone is not something to resume ──')
    // Pane A's sleep is still running; kill it and the pane goes back to being
    // a bare prompt, which must clear rather than keep the old answer.
    paneA.stdin.write('\x03')
    await sleep(1500)
    records = runProbe()
    check('a pane back at its prompt has nothing to resume', planFor(select.foregroundOf(records, UID_A)), null)

    console.log('── in a real pane, the shell itself is the root ──')
    // Which is what makes the depth-0 rejection right: the process WSL spawns
    // to relay a `wsl.exe` invocation does not carry the pane's environment,
    // so the pane's own shell is the topmost process holding the token and an
    // idle pane has no descendant at all.
    const relay = wslSync(`
        sleep 20 &
        sleep 1
        for f in /proc/[0-9]*/environ; do
          if grep -aqs 'TABBY_SESSION=${UID_C}' "$f" 2>/dev/null; then
            d=\${f%/environ}
            p=\${d##*/}
            set -- $(sed 's/.*) //' "$d/stat")
            echo "$p $2"
          fi
        done
        kill %1 2>/dev/null
        exit 0
    `, { TABBY_SESSION: UID_C, WSLENV: 'TABBY_SESSION' })
    const holders = String(relay.stdout ?? '').trim().split('\n')
        .map(line => line.trim().split(/\s+/).map(Number))
        .filter(([pid]) => pid > 0)
    ok('the fixture found its own processes', holders.length >= 2, relay.stdout)
    const pids = new Set(holders.map(([pid]) => pid))
    const roots = holders.filter(([, ppid]) => !pids.has(ppid))
    check('exactly one process holding the token has no parent holding it', roots.length, 1)
}

/** What the pane would actually be brought back with, everything switched on. */
function planFor (record) {
    return record
        ? recognize.buildPlan({ paneId: 'x', argv: record.argv }, { agents: true, multiplexers: true, extra: [], excluded: [] })
        : null
}

main().then(() => {
    cleanup()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed ? 1 : 0)
}, error => {
    cleanup()
    console.log('ERROR', error)
    process.exit(1)
})
