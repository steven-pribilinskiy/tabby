// What a native pane is running, against a real Windows process tree.
//
// The whole point of the rule is that it takes the FIRST thing the shell
// launched and not the deepest: a coding agent spawns a child per MCP server,
// so the deepest descendant of a pane running an agent is one of those and the
// pane would come back running a plugin instead of the agent. A synthetic tree
// can assert the traversal; only a real one asserts that
// `windows-process-tree` reports what the traversal assumes — names with
// `.exe`, a `commandLine` on every node, and children nested rather than flat.
//
// Native module, so it needs Electron's ABI but no window:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     tabby-resume/test/native.electron.js
const path = require('path')
const { spawn, spawnSync } = require('child_process')
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
        console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`)
    }
}

const Module = require('module')
const ts = require(path.join(REPO, 'node_modules/typescript'))
Module._extensions['.ts'] = function (module, filename) {
    const js = ts.transpileModule(require('fs').readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText
    module._compile(js, filename)
}
const select = require(path.join(REPO, 'tabby-resume/src/select.ts'))
const recognize = require(path.join(REPO, 'tabby-resume/src/recognize.ts'))
const wpt = require(path.join(REPO, 'app/node_modules/@tabby-gang/windows-process-tree'))

const MARKER = `resume-native-${process.pid}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const started = []

function cleanup () {
    for (const pid of started) {
        try {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
        } catch { }
    }
    console.log(`  (killed ${started.length} process tree(s) by pid)`)
}

function treeOf (pid) {
    return new Promise(resolve => wpt.getProcessTree(pid, resolve, wpt.ProcessDataFlag.CommandLine))
}

async function main () {
    console.log('── the first thing the shell launched, not the deepest ──')

    // A pane's shape: cmd.exe as the pane's own process, the program the user
    // typed under it, and that program's own children under that. Written as
    // one command line so nothing but cmd is between the shell and the agent
    // stand-in.
    const inner = `setTimeout(function(){},600000);require('child_process').spawn(process.execPath,['-e','setTimeout(function(){},600000)','mcp-${MARKER}'],{stdio:'ignore',env:Object.assign({},process.env,{ELECTRON_RUN_AS_NODE:'1'})})`
    const shell = spawn('cmd.exe', ['/c', process.execPath, '-e', inner, `agent-${MARKER}`], {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    started.push(shell.pid)
    await sleep(3000)

    const tree = await treeOf(shell.pid)
    const worker = select.firstWorkerBelow(tree)
    check('a program was found under the shell', typeof worker === 'string' && worker.length > 0, true)
    // Compared on the last argument, not by searching the string: the parent's
    // own command line contains the script that spawns the child, so both
    // markers appear in it either way.
    const lastArg = line => recognize.splitWindowsCommandLine(String(line)).pop()
    check('and it is the agent, not the child it spawned', lastArg(worker), `agent-${MARKER}`)

    // The same tree, read the way the old rule read it, to show the two
    // genuinely differ on this shape — otherwise a passing test proves nothing.
    const deepest = (node) => {
        let found = null
        const walk = n => {
            for (const child of n.children ?? []) {
                const name = recognize.baseName(child.name ?? '')
                if (name && !recognize.isShellName(name)) {
                    found = child.commandLine || child.name
                }
                walk(child)
            }
        }
        walk(node)
        return found
    }
    check('the deepest descendant really is the wrong answer here',
        lastArg(deepest(tree)), `mcp-${MARKER}`)

    console.log('── and the command line is argv, not a string ──')
    const argv = recognize.splitWindowsCommandLine(worker)
    check('argv[0] is the executable', /electron\.exe$|node\.exe$/i.test(argv[0]), true)
    check('the marker survives the split', argv.includes(`agent-${MARKER}`), true)
    check('an interpreter-hosted program is seen through',
        recognize.programName(['node', '/usr/lib/claude']).name, 'claude')

    console.log('── a shell with nothing under it ──')
    const idle = spawn('cmd.exe', ['/c', 'pause'], { windowsHide: true, stdio: 'ignore' })
    started.push(idle.pid)
    await sleep(1500)
    check('reports nothing to resume', select.firstWorkerBelow(await treeOf(idle.pid)), null)
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
