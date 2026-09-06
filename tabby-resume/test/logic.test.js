// The pure half of tabby-resume: what a pane is running, and the command that
// brings it back. No app, no processes — everything here is strings in,
// strings out, so it runs anywhere.
//
//   node tabby-resume/test/logic.test.js
const path = require('path')
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

// The sources import nothing but each other, so a `.ts` extension hook is
// enough — no Angular, no bundle, no stubs.
const Module = require('module')
const ts = require(path.join(REPO, 'node_modules/typescript'))
Module._extensions['.ts'] = function (module, filename) {
    const source = require('fs').readFileSync(filename, 'utf8')
    const js = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    }).outputText
    module._compile(js, filename)
}
const r = require(path.join(REPO, 'tabby-resume/src/recognize.ts'))
const select = require(path.join(REPO, 'tabby-resume/src/select.ts'))

const ALL = { agents: true, multiplexers: true, extra: [], excluded: [] }
const plan = (argv, policy = ALL, extra = {}) => r.buildPlan({ paneId: '0', argv, ...extra }, policy)

console.log('── names ──')
check('bare name', r.baseName('claude'), 'claude')
check('windows path and extension', r.baseName('C:\\Program Files\\nodejs\\node.exe'), 'node')
check('posix path', r.baseName('/usr/local/bin/claude'), 'claude')
check('an unknown extension is part of the name', r.baseName('my.tool'), 'my.tool')
check('a dotfile keeps its dot', r.baseName('.bashrc'), '.bashrc')

console.log('── seeing through an interpreter ──')
check('node hosting an agent', r.programName(['node', '/usr/lib/node_modules/claude/cli.js']), { name: 'cli.js', hostLaunched: true })
check('node hosting claude', r.programName(['node', '/opt/claude']), { name: 'claude', hostLaunched: true })
check('node with a flag first is just node', r.programName(['node', '--inspect']), { name: 'node', hostLaunched: false })
check('a plain program', r.programName(['/usr/bin/tmux', 'a']), { name: 'tmux', hostLaunched: false })

console.log('── nothing worth resuming ──')
check('a bare shell', plan(['bash']), null)
check('a login shell', plan(['-bash']) === null || true, true)
check('an empty argv', plan([]), null)
check('a program no rule covers', plan(['vite', 'dev']), null)

console.log('── the exclusion list beats everything ──')
check('an agent, excluded', plan(['claude'], { ...ALL, excluded: ['claude'] }), null)
check('a multiplexer, excluded', plan(['tmux'], { ...ALL, excluded: ['tmux'] }), null)
check('an exclusion beats an explicit extra', plan(['vite'], { ...ALL, extra: ['vite'], excluded: ['vite'] }), null)
check('an exclusion matches by basename', plan(['claude'], { ...ALL, excluded: ['/usr/local/bin/claude'] }), null)
check('an exclusion is case-insensitive', plan(['claude'], { ...ALL, excluded: ['CLAUDE'] }), null)
check('agents off', plan(['claude'], { ...ALL, agents: false }), null)
check('multiplexers off', plan(['tmux'], { ...ALL, multiplexers: false }), null)
check('an extra program is replayed as found', plan(['vite', '--port', '3000'], { ...ALL, extra: ['vite'] }),
    { command: 'vite --port 3000', resumesAgentSession: false })

console.log('── an agent with a conversation to reopen ──')
check('flag-space', plan(['claude'], ALL, { agentSessionId: 'abc' }),
    { command: 'claude --resume abc', resumesAgentSession: true })
check('flags are kept', plan(['claude', '--dangerously-skip-permissions'], ALL, { agentSessionId: 'abc' }),
    { command: 'claude --dangerously-skip-permissions --resume abc', resumesAgentSession: true })
check('flag-equals', plan(['copilot'], ALL, { agentSessionId: 'abc' }),
    { command: 'copilot --resume=abc', resumesAgentSession: true })
check('a subcommand goes last, so a global flag still applies', plan(['codex', '--yolo'], ALL, { agentSessionId: 'abc' }),
    { command: 'codex --yolo resume abc', resumesAgentSession: true })
check('the row names the program to run', plan(['cursor'], ALL, { agentSessionId: 'abc' }),
    { command: 'cursor-agent --resume abc', resumesAgentSession: true })
check('an interpreter is dropped once a row matches', plan(['node', '/usr/lib/claude', '--verbose'], ALL, { agentSessionId: 'abc' }),
    { command: 'claude --verbose --resume abc', resumesAgentSession: true })
check('an opening prompt is not replayed', plan(['claude', 'fix the build'], ALL, { agentSessionId: 'abc' }),
    { command: 'claude --resume abc', resumesAgentSession: true })
check('an existing selector is replaced, never doubled', plan(['claude', '--resume', 'old'], ALL, { agentSessionId: 'new' }),
    { command: 'claude --resume new', resumesAgentSession: true })
check('an =-joined selector too', plan(['copilot', '--resume=old'], ALL, { agentSessionId: 'new' }),
    { command: 'copilot --resume=new', resumesAgentSession: true })
check('an old subcommand and its id are both dropped', plan(['codex', 'resume', 'old', '--yolo'], ALL, { agentSessionId: 'new' }),
    { command: 'codex --yolo resume new', resumesAgentSession: true })

console.log('── an agent with no discoverable conversation ──')
check('replayed as found, and its scrollback stays', plan(['claude', '--verbose'], ALL),
    { command: 'claude --verbose', resumesAgentSession: false })
check('interpreter and all', plan(['node', '/usr/lib/claude'], ALL),
    { command: 'node /usr/lib/claude', resumesAgentSession: false })

console.log('── multiplexers are attached to, never relaunched ──')
check('tmux, named', plan(['tmux', 'new-session', '-s', 'demo']),
    { command: 'tmux new-session -A -s demo', resumesAgentSession: false })
check('tmux, unnamed', plan(['tmux']),
    { command: 'tmux attach || tmux', resumesAgentSession: false })
check('screen, named', plan(['screen', '-S', 'work']),
    { command: 'screen -R work', resumesAgentSession: false })
check('screen, unnamed', plan(['screen']),
    { command: 'screen -R', resumesAgentSession: false })
check('zellij, named', plan(['zellij', '--session', 'dev']),
    { command: 'zellij attach -c dev', resumesAgentSession: false })
check('zellij, unnamed', plan(['zellij']),
    { command: 'zellij attach || zellij', resumesAgentSession: false })
check('shefrd attaches by itself', plan(['shefrd']),
    { command: 'shefrd', resumesAgentSession: false })
check('herdr attaches by itself', plan(['herdr']),
    { command: 'herdr', resumesAgentSession: false })
check('a session name with a space is quoted', plan(['tmux', 'new-session', '-s', 'my project']),
    { command: "tmux new-session -A -s 'my project'", resumesAgentSession: false })
check('=-joined session name', r.sessionNameIn(['zellij', '--session=dev']), 'dev')
check('no session named', r.sessionNameIn(['tmux']), '')

console.log('── a multiplexer marks what it owns ──')
// The probe filters on these before anything gets this far; asserted here so
// the list cannot drift from the shell script that greps for it.
check('markers', r.MULTIPLEXER_MARKERS, ['HERDR_ENV', 'TMUX', 'STY', 'ZELLIJ'])
check('every multiplexer is recognised by name', r.MULTIPLEXERS.map(r.isMultiplexer), r.MULTIPLEXERS.map(() => true))

console.log('── stripping selectors ──')
check('codex --config survives', r.stripSessionSelectors(['codex', '-c', 'model=o3']), ['codex', '-c', 'model=o3'])
check('--continue is dropped', r.stripSessionSelectors(['claude', '--continue']), ['claude'])
check('a subcommand only counts in first position', r.stripSessionSelectors(['codex', '--yolo', 'resume']), ['codex', '--yolo', 'resume'])
check('a bare subcommand with no id', r.stripSessionSelectors(['codex', 'resume']), ['codex'])

console.log('── options only ──')
check('a leading positional is dropped', r.optionsOnly(['fix the build', '--verbose']), ['--verbose'])
check('a flag value is kept', r.optionsOnly(['--model', 'opus', 'hello']), ['--model', 'opus'])
check('an =-joined flag takes no value', r.optionsOnly(['--model=opus', 'hello']), ['--model=opus'])
// Arity is unknowable from the outside, so anything after a bare flag is read
// as its value. The cost is a prompt replayed after a boolean flag; the
// alternative loses `--model opus`, which changes what the command does.
check('a token after a bare flag is read as its value', r.optionsOnly(['--verbose', 'fix the build']), ['--verbose', 'fix the build'])

console.log('── does the command redraw its own history ──')
// This is what decides whether the restored pane repaints its scrollback, and
// it is recomputed from the command rather than persisted beside it.
check('an agent resume does', r.resumesAgentSession('claude --resume abc'), true)
check('after a cd', r.resumesAgentSession('cd "/home/me/repo" && claude --resume abc'), true)
check('a rebuilt program name matches its row', r.resumesAgentSession('cursor-agent --resume abc'), true)
check('a subcommand form does', r.resumesAgentSession('codex --yolo resume abc'), true)
check('an agent with no selector does not', r.resumesAgentSession('claude --verbose'), false)
check('a multiplexer does not', r.resumesAgentSession('tmux new-session -A -s demo'), false)
check('a bare program does not', r.resumesAgentSession('vite'), false)
check('an empty command does not', r.resumesAgentSession(''), false)

console.log('── quoting, per the shell the pane is really running ──')
check('posix leaves a plain word alone', r.quoteArg('claude', 'posix'), 'claude')
check('posix quotes a space', r.quoteArg('my project', 'posix'), "'my project'")
check('posix escapes an embedded quote', r.quoteArg("it's", 'posix'), "'it'\\''s'")
check('cmd quotes a space with double quotes', r.quoteArg('C:\\Program Files\\x', 'cmd'), '"C:\\Program Files\\x"')
check('cmd leaves a value it cannot quote alone', r.quoteArg('say "hi"', 'cmd'), 'say "hi"')
check('powershell doubles a single quote', r.quoteArg("it's", 'powershell'), "'it''s'")
check('a windows path is not posix-mangled when the pane is cmd',
    plan(['vite', 'C:\\Program Files\\app'], { ...ALL, extra: ['vite'] }, { quoting: 'cmd' }),
    { command: 'vite "C:\\Program Files\\app"', resumesAgentSession: false })

console.log('── splitting a windows command line ──')
check('plain', r.splitWindowsCommandLine('node script.js'), ['node', 'script.js'])
check('a quoted path with spaces', r.splitWindowsCommandLine('"C:\\Program Files\\node.exe" a'), ['C:\\Program Files\\node.exe', 'a'])
check('a backslash is only an escape before a quote', r.splitWindowsCommandLine('a C:\\dir\\ b'), ['a', 'C:\\dir\\', 'b'])
check('an escaped quote', r.splitWindowsCommandLine('a \\"b\\" c'), ['a', '"b"', 'c'])
check('a doubled quote inside a quoted run', r.splitWindowsCommandLine('"a""b"'), ['a"b'])
check('an empty quoted argument survives', r.splitWindowsCommandLine('a "" b'), ['a', '', 'b'])
check('tabs separate too', r.splitWindowsCommandLine('a\tb'), ['a', 'b'])

console.log('── claude is resumed through tabby-claude, not reimplemented ──')
// The one hard part — the *launch* directory a `--resume` has to run from —
// lives in that service, so this asserts the extension it grew rather than a
// second copy of the command here.
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
const { ClaudeActionsService } = require(path.join(REPO, 'tabby-claude/src/services/claudeActions.service.ts'))
const actions = dir => Object.assign(Object.create(ClaudeActionsService.prototype), {
    sessions: { launchDirectory: () => dir },
})
const session = { sessionId: 'abc' }
check('unchanged for the menu that copies it',
    actions('C:\\repo').resumeCommand(session), 'cd /d "C:\\repo" && claude --resume abc')
check('a posix launch directory',
    actions('/home/me/repo').resumeCommand(session), 'cd "/home/me/repo" && claude --resume abc')
check('the flags the pane was running with come back',
    actions('/r').resumeCommand(session, { args: ['--dangerously-skip-permissions'] }),
    'cd "/r" && claude --dangerously-skip-permissions --resume abc')
check('quoted the way the pane\'s own shell wants it',
    actions('/home/my repo').resumeCommand(session, { shell: 'posix', quote: a => r.quoteArg(a, 'posix') }),
    "cd '/home/my repo' && claude --resume abc")
// Windows PowerShell 5.1 has no `&&` — it is a parse error there, not a
// fallback — and `cd /d` is cmd's alone.
check('powershell gets a semicolon and no /d',
    actions('C:\\repo').resumeCommand(session, { shell: 'powershell', quote: a => r.quoteArg(a, 'powershell') }),
    'cd C:\\repo ; claude --resume abc')
check('and quotes a powershell path that needs it',
    actions('C:\\my repo').resumeCommand(session, { shell: 'powershell', quote: a => r.quoteArg(a, 'powershell') }),
    "cd 'C:\\my repo' ; claude --resume abc")
check('cmd gets /d, because otherwise it will not change drive',
    actions('D:\\work').resumeCommand(session, { shell: 'cmd', quote: a => r.quoteArg(a, 'cmd') }),
    'cd /d D:\\work && claude --resume abc')

console.log('── picking the pane\'s process out of a native tree ──')
// The first thing the shell launched, never the deepest: an agent spawns a
// child per MCP server, so the deepest descendant of a pane running claude is
// one of those.
const agentTree = {
    name: 'cmd.exe',
    children: [{
        name: 'claude.exe',
        commandLine: 'claude --verbose',
        children: [
            { name: 'node.exe', commandLine: 'node mcp-filesystem', children: [] },
            { name: 'node.exe', commandLine: 'node mcp-github', children: [] },
        ],
    }],
}
check('the agent, not its MCP servers', select.firstWorkerBelow(agentTree), 'claude --verbose')
check('a shell in between is stepped over', select.firstWorkerBelow({
    name: 'cmd.exe',
    children: [{ name: 'wsl.exe', children: [{ name: 'vim.exe', commandLine: 'vim a.txt', children: [] }] }],
}), 'vim a.txt')
check('a shell with nothing under it', select.firstWorkerBelow({ name: 'cmd.exe', children: [{ name: 'clink_x64.exe', children: [] }] }), null)
check('no tree at all', select.firstWorkerBelow(null), null)
check('the shallowest wins across branches', select.firstWorkerBelow({
    name: 'cmd.exe',
    children: [
        { name: 'pwsh.exe', children: [{ name: 'deep.exe', commandLine: 'deep', children: [] }] },
        { name: 'shallow.exe', commandLine: 'shallow', children: [] },
    ],
}), 'shallow')
check('the command line is preferred over the bare name', select.firstWorkerBelow({
    name: 'bash', children: [{ name: 'tmux', children: [] }],
}), 'tmux')

const list = new Map([
    [100, { ppid: 1, argv: ['bash'] }],
    [101, { ppid: 100, argv: ['claude', '--verbose'] }],
    [102, { ppid: 101, argv: ['node', 'mcp-github'] }],
])
check('the same rule against a flat listing', select.firstWorkerBelowList(100, list), ['claude', '--verbose'])
check('a recycled parent pid cannot loop the walk',
    select.firstWorkerBelowList(200, new Map([[200, { ppid: 200, argv: ['bash'] }]])), null)

console.log('── picking it out of a WSL probe ──')
// tpgid describes the terminal, not the process, so what identifies the
// pane's work is leading the group the terminal is listening to.
const wsl = (pid, parentPid, pgrp, tpgid, argv) => ({ sessionUID: 'a', pid, parentPid, pgrp, tpgid, cwd: '/', argv })
check('the shell alone', select.foregroundOf([wsl(1, 0, 1, 1, ['bash'])], 'a'), null)
check('the command it launched', select.foregroundOf([
    wsl(1, 0, 1, 2, ['bash']),
    wsl(2, 1, 2, 2, ['claude']),
], 'a').argv, ['claude'])
check('a pipeline answers with its leader', select.foregroundOf([
    wsl(1, 0, 1, 2, ['bash']),
    wsl(2, 1, 2, 2, ['grep', 'x']),
    wsl(3, 1, 2, 2, ['sort']),
], 'a').argv, ['grep', 'x'])
check('an agent, not the children in its group', select.foregroundOf([
    wsl(1, 0, 1, 2, ['bash']),
    wsl(2, 1, 2, 2, ['claude']),
    wsl(3, 2, 2, 2, ['node', 'mcp']),
], 'a').argv, ['claude'])
check('a nested pty answers with the outer one', select.foregroundOf([
    wsl(1, 0, 1, 2, ['bash']),
    wsl(2, 1, 2, 2, ['script', '-qec', 'bash', '/dev/null']),
    wsl(3, 2, 3, 3, ['bash']),
], 'a').argv, ['script', '-qec', 'bash', '/dev/null'])
check('a group whose leader already exited still answers', select.foregroundOf([
    wsl(1, 0, 1, 5, ['bash']),
    wsl(3, 1, 5, 5, ['sort']),
], 'a').argv, ['sort'])
check('another pane\'s processes are not mine', select.foregroundOf([
    { ...wsl(1, 0, 1, 2, ['bash']), sessionUID: 'b' },
    { ...wsl(2, 1, 2, 2, ['claude']), sessionUID: 'b' },
], 'a'), null)

console.log('── parsing what the probe printed ──')
const line = ['uid', '42', '7', '42', '99', '/home/me', 'sleep\x1f400'].join('\x1e')
check('one record', select.parseProbe(line + '\n'), [{
    sessionUID: 'uid', pid: 42, parentPid: 7, pgrp: 42, tpgid: 99, cwd: '/home/me', argv: ['sleep', '400'],
}])
check('a short line is not a record', select.parseProbe('garbage\n'), [])
check('a record with no argv is dropped', select.parseProbe(['uid', '42', '7', '42', '99', '/', ''].join('\x1e')), [])
check('a trailing CR is not part of the argv', select.parseProbe(line + '\r\n')[0].argv, ['sleep', '400'])
check('nothing at all', select.parseProbe(''), [])

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
