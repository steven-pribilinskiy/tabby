/**
 * What a pane is running, and what command would bring it back.
 *
 * Everything here is pure: strings in, strings out, no Angular and no I/O, so
 * it can be exercised by `test/logic.test.js` without a running app. The
 * platform-specific half — reading process trees, probing a distro — lives in
 * `services/paneCapture.service.ts` and produces the `CapturedPane` this
 * consumes.
 */

/** How an agent spells "reopen this conversation". */
export type SelectorStyle = 'flag-space' | 'flag-equals' | 'subcommand'

export interface AgentRow {
    /** Matched against argv[0]'s basename. */
    name: string
    /** What we actually run, when it differs from the name. */
    program: string
    selector: string
    style: SelectorStyle
}

/**
 * Deliberately only the agents whose resume syntax is *known*. Guessing a flag
 * produces a command that fails at restore, which is worse than getting a
 * shell back — anything unlisted can still be named in `extraPrograms`, where
 * it is replayed exactly as it was found rather than rewritten.
 *
 * Mirrors the table in the Windows Terminal fork's `PaneSessionCapture.h`,
 * itself checked row by row against each agent's own `--help`; keep the two in
 * step rather than adding rows from memory.
 */
export const AGENT_TABLE: AgentRow[] = [
    { name: 'claude', program: 'claude', selector: '--resume', style: 'flag-space' },
    { name: 'codex', program: 'codex', selector: 'resume', style: 'subcommand' },
    { name: 'copilot', program: 'copilot', selector: '--resume', style: 'flag-equals' },
    { name: 'devin', program: 'devin', selector: '--resume', style: 'flag-space' },
    { name: 'droid', program: 'droid', selector: '--resume', style: 'flag-space' },
    { name: 'kimi', program: 'kimi', selector: '--session', style: 'flag-space' },
    { name: 'mastracode', program: 'mastracode', selector: '--thread', style: 'flag-space' },
    { name: 'pi', program: 'pi', selector: '--session', style: 'flag-space' },
    { name: 'omp', program: 'omp', selector: '--resume', style: 'flag-equals' },
    { name: 'hermes', program: 'hermes', selector: '--resume', style: 'flag-space' },
    { name: 'opencode', program: 'opencode', selector: '--session', style: 'flag-space' },
    { name: 'qodercli', program: 'qodercli', selector: '--resume', style: 'flag-space' },
    { name: 'qwen', program: 'qwen', selector: '--resume', style: 'flag-space' },
    { name: 'kilo', program: 'kilo', selector: '--session', style: 'flag-space' },
    { name: 'cursor', program: 'cursor-agent', selector: '--resume', style: 'flag-space' },
    { name: 'agy', program: 'agy', selector: '--conversation', style: 'flag-space' },
    { name: 'grok', program: 'grok', selector: '--resume', style: 'flag-space' },
]

/**
 * Daemon-backed session hosts. Their server outlives Tabby and still owns the
 * shells and agents inside it, so getting back in is an *attach*, and the
 * things it is running are never resumed separately — the daemon restores
 * those itself, and doing it here too would start a second copy of every one.
 */
export const MULTIPLEXERS = ['shefrd', 'herdr', 'tmux', 'screen', 'zellij']

/**
 * Environment variables a multiplexer stamps on the processes it owns. A probe
 * that sees one of these is looking at the daemon's work, not the pane's.
 */
export const MULTIPLEXER_MARKERS = ['HERDR_ENV', 'TMUX', 'STY', 'ZELLIJ']

/**
 * Scaffolding rather than work: a pane whose first descendant is one of these
 * is running nothing worth bringing back.
 */
export const SHELL_NAMES = [
    'cmd', 'powershell', 'pwsh', 'wsl', 'wslhost', 'wslservice', 'bash', 'sh', 'zsh', 'fish',
    'conhost', 'openconsole', 'clink', 'clink_x64', 'clink_x86', 'login', 'su', 'sudo',
]

/** Interpreters that front for the program we care about: `node …/claude` is claude. */
export const SCRIPT_HOSTS = ['node', 'python', 'python3', 'py', 'ruby', 'bun', 'deno', 'perl']

/** How the restored pane's own shell wants an argument quoted. */
export type QuotingStyle = 'posix' | 'cmd' | 'powershell'

export interface CapturedPane {
    /** Opaque key joining this answer back to the pane it came from. */
    paneId: string
    /** The foreground argv, flags included, exactly as found. */
    argv: string[]
    /** An agent conversation id, where one was discoverable. */
    agentSessionId?: string
    quoting?: QuotingStyle
}

export interface ResumePlan {
    command: string
    /**
     * True only when the command reopens an agent CONVERSATION rather than
     * merely re-running a program. Such a pane must not repaint its saved
     * scrollback: the agent redraws its own history, and both would leave the
     * pane showing the same transcript twice.
     */
    resumesAgentSession: boolean
}

export interface ResumePolicy {
    agents: boolean
    multiplexers: boolean
    extra: string[]
    excluded: string[]
}

/** argv[0] reduced to what a table row matches: no directory, no .exe/.cmd/.bat. */
export function baseName (argv0: string): string {
    let name = String(argv0)
    const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
    if (slash !== -1) {
        name = name.substring(slash + 1)
    }
    const dot = name.lastIndexOf('.')
    if (dot > 0 && ['exe', 'cmd', 'bat', 'ps1', 'com'].includes(name.substring(dot + 1).toLowerCase())) {
        name = name.substring(0, dot)
    }
    return name
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

export function findAgent (name: string): AgentRow | null {
    return AGENT_TABLE.find(row => sameName(name, row.name)) ?? null
}

export function isMultiplexer (name: string): boolean {
    return MULTIPLEXERS.some(x => sameName(name, x))
}

export function isShellName (name: string): boolean {
    return SHELL_NAMES.some(x => sameName(name, x))
}

/**
 * The program a captured argv is really running, seeing through an
 * interpreter: `node /usr/lib/claude --foo` is claude, not node.
 */
export function programName (argv: string[]): { name: string, hostLaunched: boolean } {
    const first = baseName(argv[0] ?? '')
    if (SCRIPT_HOSTS.some(x => sameName(first, x)) && argv.length > 1 && !argv[1].startsWith('-')) {
        return { name: baseName(argv[1]), hostLaunched: true }
    }
    return { name: first, hostLaunched: false }
}

/**
 * Drop a session selector the recorded argv already carries, so appending a
 * fresh one cannot leave two.
 *
 * `-c` is deliberately absent: codex spells `--config` that way, and dropping a
 * config flag would change what the command does rather than de-duplicate a
 * selector.
 */
export function stripSessionSelectors (argv: string[]): string[] {
    const takesValue = ['--resume', '-r', '--session', '--thread', '--conversation']
    const valueless = ['--continue']
    const prefixes = ['--resume=', '--session=', '--thread=', '--conversation=']
    const out: string[] = []
    let skipValue = false
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (skipValue) {
            skipValue = false
            continue
        }
        if (takesValue.includes(arg)) {
            skipValue = true
            continue
        }
        if (valueless.includes(arg) || prefixes.some(p => arg.startsWith(p))) {
            continue
        }
        // codex resumes through a subcommand, and only in first position. Its
        // session id follows as a bare argument, so dropping the subcommand
        // alone would leave the id behind as codex's first positional and
        // change what the command means.
        if (i === 1 && arg === 'resume') {
            skipValue = i + 1 < argv.length && !argv[i + 1].startsWith('-')
            continue
        }
        out.push(arg)
    }
    return out
}

/**
 * The options a command was carrying, without its positional arguments.
 *
 * Used only when rebuilding an agent command around a session selector, and
 * only there. An agent's positional argument is its opening prompt, and
 * replaying that alongside `--resume` would re-send the first turn of the
 * conversation being reopened — so a token is kept when it is an option, or
 * the value of one, and dropped otherwise. A flag taking two values loses the
 * second, which costs an argument; keeping it would cost a duplicated turn.
 */
export function optionsOnly (args: string[]): string[] {
    const out: string[] = []
    for (let i = 0; i < args.length; i++) {
        if (args[i].startsWith('-')) {
            out.push(args[i])
            continue
        }
        if (i > 0 && args[i - 1].startsWith('-') && !args[i - 1].includes('=')) {
            out.push(args[i])
        }
    }
    return out
}

/** The session name a multiplexer was started with, if it names one. */
export function sessionNameIn (argv: string[]): string {
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i]
        if (['-s', '-S', '-t', '--session'].includes(arg) && i + 1 < argv.length) {
            return argv[i + 1]
        }
        for (const prefix of ['--session=', '-s=', '-S=']) {
            if (arg.startsWith(prefix)) {
                return arg.substring(prefix.length)
            }
        }
    }
    return ''
}

/**
 * Quote one argument for the shell the restored pane is actually running.
 *
 * The Windows Terminal fork quotes POSIX-style always, which is right for it
 * because everything it captures natively is re-run by a shell that came from
 * the same place. Here a native pane may well be cmd or PowerShell, where a
 * single-quoted `C:\Program Files\…` is not a path but an error.
 */
export function quoteArg (arg: string, quoting: QuotingStyle = 'posix'): string {
    const text = String(arg)
    if (quoting === 'cmd') {
        // cmd has no escape for a quote inside a quoted string; a caret works
        // only outside one. An argument containing `"` is left as it was
        // rather than mangled into something that parses differently.
        return /[\s&|<>^()"]/.test(text) && !text.includes('"') ? `"${text}"` : text
    }
    if (quoting === 'powershell') {
        return /[\s'"`$;,(){}&|<>@#]/.test(text) ? `'${text.replace(/'/g, '\'\'')}'` : text
    }
    if (text && !/[\s"'\\$`|&;<>()*?[\]{}~#!]/.test(text)) {
        return text
    }
    // Single quotes, POSIX style: everything inside is literal, and an
    // embedded quote is spelled by closing, escaping, reopening.
    return `'${text.split('\'').join('\'\\\'\'')}'`
}

export function joinArgv (argv: string[], quoting: QuotingStyle = 'posix'): string {
    return argv.map(x => quoteArg(x, quoting)).join(' ')
}

/**
 * How to get BACK into a multiplexer, which is not the command that started
 * it. Replaying the launch verbatim is actively wrong: `tmux new-session -s
 * demo` answers "duplicate session: demo" and leaves the pane at a prompt with
 * the session still detached.
 *
 * shefrd and herdr are the exception — their client attaches to the running
 * server by itself, so the bare command is already the right answer. The rest
 * need an explicit attach, spelled differently by each. The `||` fallbacks are
 * safe because this is typed into the pane's own shell: with nothing to attach
 * to, because the server died with the machine, a fresh session is the sane
 * outcome.
 */
export function multiplexerResume (name: string, argv: string[], quoting: QuotingStyle = 'posix'): string {
    const session = sessionNameIn(argv)
    const q = (x: string) => quoteArg(x, quoting)
    if (sameName(name, 'tmux')) {
        return session ? `tmux new-session -A -s ${q(session)}` : 'tmux attach || tmux'
    }
    if (sameName(name, 'screen')) {
        // -R reattaches if it can and creates if it cannot, which is exactly
        // the semantic wanted here.
        return session ? `screen -R ${q(session)}` : 'screen -R'
    }
    if (sameName(name, 'zellij')) {
        return session ? `zellij attach -c ${q(session)}` : 'zellij attach || zellij'
    }
    return name
}

/**
 * Whether a command line reopens an agent conversation, recomputed from the
 * string itself rather than persisted alongside it. One source of truth: a
 * command and a flag saying what it does can disagree after a hand-edited
 * config, and the flag is the half nothing would notice was wrong.
 */
export function resumesAgentSession (commandLine: string): boolean {
    const text = String(commandLine)
    // Only the last statement matters — the rest is the `cd` that got us there.
    const tail = text.split(/&&|;/).pop()!.trim()
    const end = tail.search(/\s/)
    if (end === -1) {
        return false
    }
    const program = baseName(tail.substring(0, end))
    for (const row of AGENT_TABLE) {
        if (sameName(program, row.name) || sameName(program, row.program)) {
            return tail.includes(row.selector)
        }
    }
    return false
}

/**
 * Whether policy lets this program come back at all.
 *
 * An exclusion beats every other reason to bring something back, including an
 * explicit extra entry — it is the only way to say "not this one" about a
 * program the built-in tables already cover.
 */
export function programAllowed (name: string, policy: ResumePolicy): boolean {
    const listed = (list: string[]) => list.some(entry => sameName(name, baseName(entry)))
    if (listed(policy.excluded)) {
        return false
    }
    return !!findAgent(name) && policy.agents || isMultiplexer(name) && policy.multiplexers || listed(policy.extra)
}

/**
 * The command that brings a pane back, or null when policy excludes it or
 * there is nothing worth replaying — a bare shell, or a program no rule covers.
 */
export function buildPlan (captured: CapturedPane, policy: ResumePolicy): ResumePlan | null {
    const argv = captured.argv
    if (!argv.length) {
        return null
    }
    const quoting = captured.quoting ?? 'posix'
    const { name, hostLaunched } = programName(argv)
    if (!name || isShellName(name)) {
        return null
    }

    if (!programAllowed(name, policy)) {
        return null
    }
    const agent = findAgent(name)
    const multiplexer = isMultiplexer(name)

    if (multiplexer) {
        return { command: multiplexerResume(name, argv, quoting), resumesAgentSession: false }
    }

    if (!agent || !captured.agentSessionId) {
        // Replayed exactly as found, interpreter and all: we do not rewrite a
        // command we have no row for, and an agent with no discoverable
        // conversation is a program we can restart but not a session we can
        // reopen — so its scrollback stays, which is where its history is.
        return { command: joinArgv(argv, quoting), resumesAgentSession: false }
    }

    const stripped = stripSessionSelectors(hostLaunched ? argv.slice(1) : argv)
    if (!stripped.length) {
        return null
    }
    // Run the program the row names, keeping the options it was launched with —
    // `claude --dangerously-skip-permissions` must come back with that flag.
    const rebuilt = [agent.program, ...optionsOnly(stripped.slice(1))]
    if (agent.style === 'flag-equals') {
        rebuilt.push(`${agent.selector}=${captured.agentSessionId}`)
    } else {
        // A subcommand lands in the same place a flag does — after everything
        // the command was already carrying — which is what keeps a global flag
        // applying to it: `codex --yolo resume <id>`, the order codex wants,
        // rather than `codex resume <id> --yolo`.
        rebuilt.push(agent.selector, captured.agentSessionId)
    }

    return { command: joinArgv(rebuilt, quoting), resumesAgentSession: true }
}

/**
 * Split a Windows command line into argv the way CommandLineToArgvW does.
 *
 * `windows-process-tree` reports the raw command line string; every other
 * source here is already an argv, so this is the one place that has to know
 * the rules — a backslash is only an escape when it precedes a quote, and a
 * quote inside a quoted run doubles.
 */
export function splitWindowsCommandLine (commandLine: string): string[] {
    const text = String(commandLine)
    const argv: string[] = []
    let current = ''
    let quoted = false
    let started = false
    let backslashes = 0

    const flushBackslashes = (halve: boolean) => {
        current += '\\'.repeat(halve ? Math.floor(backslashes / 2) : backslashes)
        backslashes = 0
    }

    for (let i = 0; i < text.length; i++) {
        const ch = text[i]
        if (ch === '\\') {
            backslashes++
            continue
        }
        if (ch === '"') {
            const escaped = backslashes % 2 === 1
            flushBackslashes(true)
            started = true
            if (escaped) {
                current += '"'
            } else if (quoted && text[i + 1] === '"') {
                // `""` inside a quoted run is one literal quote, and the run
                // continues.
                current += '"'
                i++
            } else {
                quoted = !quoted
            }
            continue
        }
        flushBackslashes(false)
        if (!quoted && (ch === ' ' || ch === '\t')) {
            if (started || current) {
                argv.push(current)
            }
            current = ''
            started = false
            continue
        }
        started = true
        current += ch
    }
    flushBackslashes(false)
    if (started || current) {
        argv.push(current)
    }
    return argv
}
