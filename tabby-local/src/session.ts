import * as fs from 'mz/fs'
import * as fsSync from 'fs'
import { Injector } from '@angular/core'
import { HostAppService, ConfigService, WIN_BUILD_CONPTY_SUPPORTED, isWindowsBuild, Platform, BootstrapData, BOOTSTRAP_DATA, LogService } from 'tabby-core'
import { BaseSession } from 'tabby-terminal'
import { SessionOptions, ChildProcess, PTYInterface, PTYProxy } from './api'
import { getEnvironment, substituteEnv } from './environment'

const windowsDirectoryRegex = /([a-zA-Z]:[^\:\[\]\?\"\<\>\|]+)/mi

/**
 * The per-pane identity exported into every session as `TABBY_SESSION`, and
 * listed in `WSLENV` so it crosses into a distro.
 *
 * It exists because nothing else can say what a WSL pane is running: the
 * processes inside a distro have Linux pids, which can never be matched
 * against the Windows conpty pids Tabby knows about, so a probe running inside
 * the distro has to be able to tell one pane's processes from another's. Every
 * descendant of the shell inherits this, which is exactly the join.
 *
 * Windows Terminal has `WT_SESSION` for the same reason; Tabby had no
 * equivalent. It is an opaque token, and nothing but us reads it.
 */
export const TABBY_SESSION_ENV = 'TABBY_SESSION'

function newSessionUID (): string {
    const uuid = (globalThis as any).crypto?.randomUUID?.()
    if (typeof uuid === 'string') {
        return uuid
    }
    // Not a security boundary — it only has to be unique among the panes of
    // one machine at one moment.
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
}

function mergeEnv (...envs) {
    const result = {}
    const keyMap = {}
    for (const env of envs) {
        for (const [key, value] of Object.entries(env)) {
            // const lookup = process.platform === 'win32' ? key.toLowerCase() : key
            const lookup = key.toLowerCase()
            keyMap[lookup] ??= key
            result[keyMap[lookup]] = value
        }
    }
    return result
}

/** @hidden */
export class Session extends BaseSession {
    private pty: PTYProxy|null = null
    private ptyClosed = false
    private pauseAfterExit = false
    private guessedCWD: string|null = null
    private initialCWD: string|null = null
    /** @see TABBY_SESSION_ENV. Null for a session restored onto an existing PTY. */
    sessionUID: string|null = null
    private config: ConfigService
    private hostApp: HostAppService
    private bootstrapData: BootstrapData
    private ptyInterface: PTYInterface

    constructor (
        injector: Injector,
    ) {
        super(injector.get(LogService).create('local'))
        this.config = injector.get(ConfigService)
        this.hostApp = injector.get(HostAppService)
        this.ptyInterface = injector.get(PTYInterface)
        this.bootstrapData = injector.get(BOOTSTRAP_DATA)
    }

    async start (options: SessionOptions): Promise<void> {
        let pty: PTYProxy|null = null

        if (options.restoreFromPTYID) {
            pty = await this.ptyInterface.restore(options.restoreFromPTYID)
            options.restoreFromPTYID = null
        }

        if (!pty) {
            const baseEnv = getEnvironment(
                this.hostApp.platform === Platform.Windows && this.config.store.terminal.windowsRefreshEnvironment,
            )

            let env = mergeEnv(
                baseEnv,
                {
                    COLORTERM: 'truecolor',
                    TERM: 'xterm-256color',
                    TERM_PROGRAM: 'Tabby',
                },
                substituteEnv(options.env),
                this.config.store.terminal.environment || {},
            )

            if (this.hostApp.platform === Platform.Windows && this.config.store.terminal.setComSpec) {
                env = mergeEnv(env, { COMSPEC: this.bootstrapData.executable })
            }

            delete env['']

            this.sessionUID = newSessionUID()
            env = mergeEnv(env, { [TABBY_SESSION_ENV]: this.sessionUID })
            if (this.hostApp.platform === Platform.Windows) {
                // WSLENV is the only thing that carries a Windows variable into
                // a distro — a name not listed there simply does not arrive.
                // Read case-insensitively: mergeEnv keeps whichever spelling
                // the inherited environment used.
                const key = Object.keys(env).find(x => x.toLowerCase() === 'wslenv') ?? 'WSLENV'
                const existing = String(env[key] ?? '')
                // A flag suffix (`VAR/p`) makes an entry unequal to the bare
                // name, so entries are compared on the name alone.
                if (!existing.split(':').some(x => x.split('/')[0] === TABBY_SESSION_ENV)) {
                    env[key] = existing ? `${existing}:${TABBY_SESSION_ENV}` : TABBY_SESSION_ENV
                }
            }

            if (this.hostApp.platform === Platform.macOS && !process.env.LC_ALL) {
                const locale = process.env.LC_CTYPE ?? 'en_US.UTF-8'
                Object.assign(env, {
                    LANG: locale,
                    LC_ALL: locale,
                    LC_MESSAGES: locale,
                    LC_NUMERIC: locale,
                    LC_COLLATE: locale,
                    LC_MONETARY: locale,
                })
            }

            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            let cwd = options.cwd || process.env.HOME

            if (!fsSync.existsSync(cwd!)) {
                console.warn('Ignoring non-existent CWD:', cwd)
                cwd = undefined
            }

            pty = await this.ptyInterface.spawn(options.command, options.args, {
                name: 'xterm-256color',
                cols: options.width ?? 80,
                rows: options.height ?? 30,
                encoding: null,
                cwd,
                env: env,
                // `1` instead of `true` forces ConPTY even if unstable
                useConpty: isWindowsBuild(WIN_BUILD_CONPTY_SUPPORTED) && this.config.store.terminal.useConPTY ? 1 : false,
            })

            this.guessedCWD = cwd ?? null
        }

        this.pty = pty

        pty.getTruePID().then(async () => {
            this.initialCWD = await this.getWorkingDirectory()
        })

        this.open = true

        this.pty.subscribe('data', (array: Uint8Array) => {
            this.pty!.ackData(array.length)
            const data = Buffer.from(array)
            this.emitOutput(data)
            if (this.hostApp.platform === Platform.Windows) {
                this.guessWindowsCWD(data.toString())
            }
        })

        this.pty.subscribe('exit', () => {
            if (this.pauseAfterExit) {
                return
            } else if (this.open) {
                this.destroy()
            }
        })

        this.pty.subscribe('close', () => {
            this.ptyClosed = true
            if (this.pauseAfterExit) {
                this.emitOutput(Buffer.from('\r\nPress any key to close\r\n'))
            } else if (this.open) {
                this.destroy()
            }
        })

        this.pauseAfterExit = options.pauseAfterExit

        this.destroyed$.subscribe(() => this.pty!.unsubscribeAll())
    }

    getID (): string|null {
        return this.pty?.getID() ?? null
    }

    resize (columns: number, rows: number): void {
        this.pty?.resize(columns, rows)
    }

    write (data: Buffer): void {
        if (this.ptyClosed) {
            this.destroy()
        }
        if (this.open) {
            this.pty?.write(data)
        }
    }

    kill (signal?: string): void {
        this.pty?.kill(signal)
    }

    async getChildProcesses (): Promise<ChildProcess[]> {
        return this.pty?.getChildProcesses() ?? []
    }

    /**
     * The PTY's own process — the pane's shell, and never what it launched.
     *
     * Deliberately not `getTruePID()`, which walks down single-child chains: on
     * a pane running exactly one program that returns the *program*, which is
     * the wrong root for asking what the shell started.
     */
    async getShellPID (): Promise<number|null> {
        try {
            return await this.pty?.getPID() ?? null
        } catch {
            return null
        }
    }

    async gracefullyKillProcess (): Promise<void> {
        if (this.hostApp.platform === Platform.Windows) {
            this.kill()
        } else {
            await new Promise<void>((resolve) => {
                this.kill('SIGTERM')
                setTimeout(async () => {
                    try {
                        process.kill(await this.pty!.getPID(), 0)
                        // still alive
                        this.kill('SIGKILL')
                        resolve()
                    } catch {
                        resolve()
                    }
                }, 500)
            })
        }
    }

    supportsWorkingDirectory (): boolean {
        return !!(this.initialCWD ?? this.reportedCWD ?? this.guessedCWD)
    }

    async getWorkingDirectory (): Promise<string|null> {
        if (this.reportedCWD) {
            return this.reportedCWD
        }
        let cwd: string|null = null
        try {
            cwd = await this.pty?.getWorkingDirectory() ?? null
        } catch (exc) {
            console.info('Could not read working directory:', exc)
        }

        try {
            cwd = await fs.realpath(cwd)
        } catch {}

        if (this.hostApp.platform === Platform.Windows && (cwd === this.initialCWD || cwd === process.env.WINDIR)) {
            // shell doesn't truly change its process' CWD
            cwd = null
        }

        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
        cwd = cwd || this.guessedCWD

        try {
            await fs.access(cwd)
        } catch {
            return null
        }
        return cwd
    }

    private guessWindowsCWD (data: string) {
        const match = windowsDirectoryRegex.exec(data)
        if (match) {
            this.guessedCWD = match[0]
        }
    }
}
