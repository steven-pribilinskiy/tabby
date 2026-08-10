import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile, spawn } from 'child_process'
import { Injectable } from '@angular/core'
import { ConfigService, MenuItemOptions, NotificationsService, PlatformService, TranslateService } from 'tabby-core'

import { TabbyBuild } from '../api'
import { humanBytes } from '../format'
import { BuildProcessesService } from './buildProcesses.service'
import { BuildSizeService } from './buildSize.service'
import { TaskbarService } from './taskbar.service'

/** How long a build gets to shut down cleanly before it is killed outright. */
const QUIT_GRACE_MS = 12000

/** Everything needed to start a build, wherever it is being started from. */
export interface LaunchSpec {
    target: string
    args: string[]
    cwd: string
    env: Record<string, string>
}

function sleep (ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function run (command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => {
            if (err) {
                reject(err)
                return
            }
            resolve(stdout.toString())
        })
    })
}

/**
 * Everything you can do to a build.
 *
 * Deliberately not in the component: the row buttons, the kebab menu and the
 * table all have to run identical code, and every destructive path has to go
 * through the same confirmation.
 */
@Injectable({ providedIn: 'root' })
export class BuildActionsService {
    constructor (
        private config: ConfigService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private processes: BuildProcessesService,
        private sizes: BuildSizeService,
        private taskbar: TaskbarService,
        private translate: TranslateService,
    ) { }

    buildMenu (build: TabbyBuild, onChanged: () => void): MenuItemOptions[] {
        const items: MenuItemOptions[] = [
            {
                label: this.translate.instant('Launch'),
                enabled: !!build.executable,
                click: () => void this.launch(build),
            },
            {
                label: this.taskbar.isSupported()
                    ? this.translate.instant('Make active and pin to the taskbar')
                    : this.translate.instant('Make active'),
                enabled: !!build.executable && !build.isActive,
                click: () => void this.setActive(build, onChanged),
            },
            {
                label: this.translate.instant('Reveal in file manager'),
                click: () => this.reveal(build),
            },
            { type: 'separator' },
            {
                label: this.translate.instant('Copy path'),
                click: () => this.platform.setClipboard({ text: build.root }),
            },
            {
                label: this.translate.instant('Recalculate size'),
                click: () => {
                    this.sizes.invalidate(build)
                    onChanged()
                },
            },
        ]
        if (build.repoPath) {
            items.push({
                label: this.translate.instant('Reveal the checkout'),
                click: () => this.platform.showItemInFolder(build.repoPath!),
            })
        }
        items.push({ type: 'separator' })
        if (build.processes.length && !build.isCurrent) {
            items.push({
                label: this.translate.instant('Quit'),
                click: () => void this.quit(build, onChanged),
            })
        }
        if (build.uninstaller) {
            items.push({
                label: this.translate.instant('Run the uninstaller'),
                click: () => void this.runUninstaller(build),
            })
        }
        items.push({
            label: this.deleteLabel(build),
            enabled: !build.isCurrent,
            click: () => void this.delete(build, onChanged),
        })
        return items
    }

    popupMenu (build: TabbyBuild, onChanged: () => void, event?: MouseEvent): void {
        this.platform.popupContextMenu(this.buildMenu(build, onChanged), event)
    }

    /**
     * "Delete" normally; "Quit and delete" while it is still running — except
     * for the current build, where the action is refused anyway and promising
     * to quit it would be a lie.
     */
    deleteLabel (build: TabbyBuild): string {
        return build.processes.length && !build.isCurrent
            ? this.translate.instant('Quit and delete')
            : this.translate.instant('Delete')
    }

    /** Why the delete button is disabled, or null when it is not. */
    deleteBlockedReason (build: TabbyBuild): string | null {
        if (build.isCurrent) {
            return this.translate.instant('This is the build this window is running from')
        }
        if (build.isActive) {
            return this.translate.instant('This is the active build — make another one active first')
        }
        return null
    }

    // ── Launching ────────────────────────────────────────────────────────

    /**
     * How to start a build: the same answer for the Launch button and for the
     * taskbar shortcut, so a pinned build starts exactly the way this page
     * starts it.
     *
     * A source build needs an isolated profile — Electron's single-instance
     * lock is keyed on the user data directory, so sharing one with the
     * installed app means the second launch silently exits. `--dev` stands in
     * for TABBY_DEV, which a shortcut cannot carry. NODE_PATH is scrubbed only
     * for the in-process launch: a shell started *inside* Tabby exports one
     * pointing at the installed app's plugins, and inheriting it loads those
     * against this checkout's tabby-core.
     */
    launchSpec (build: TabbyBuild): LaunchSpec | null {
        if (!build.executable) {
            return null
        }
        if (build.kind !== 'source' || !build.repoPath) {
            return {
                target: build.executable,
                args: [],
                cwd: path.dirname(build.executable),
                env: {},
            }
        }
        const profile = this.devProfileDirectory(build.repoPath)
        return {
            target: build.executable,
            args: ['--dev', `--user-data-dir=${profile}`, 'app'],
            cwd: build.repoPath,
            env: {
                NODE_PATH: path.join(build.repoPath, 'app', 'node_modules'),
                TABBY_PLUGINS: '',
                TABBY_DEV: '1',
                TABBY_CONFIG_DIRECTORY: profile,
            },
        }
    }

    async launch (build: TabbyBuild): Promise<void> {
        const spec = this.launchSpec(build)
        if (!spec) {
            return
        }
        try {
            spawn(spec.target, spec.args, {
                cwd: spec.cwd,
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, ...spec.env },
            }).unref()
            this.notifications.info(this.translate.instant('Launching {name}', { name: build.name }))
        } catch (err) {
            this.notifications.error(String(err))
        }
    }

    // ── The active build ─────────────────────────────────────────────────

    /**
     * Make a build the one you use: the taskbar pin starts launching it, and it
     * becomes undeletable, so switching away from a build is the only way to be
     * allowed to remove it.
     */
    async setActive (build: TabbyBuild, onChanged: () => void): Promise<void> {
        const spec = this.launchSpec(build)
        if (!spec) {
            this.notifications.error(this.translate.instant('{name} cannot be launched, so it cannot be the active build', { name: build.name }))
            return
        }
        this.config.store.builds.activeExecutable = build.executable
        this.config.save()

        if (this.config.store.builds.pinToTaskbar && this.taskbar.isSupported()) {
            try {
                await this.taskbar.repoint({
                    target: spec.target,
                    args: spec.args,
                    cwd: spec.cwd,
                    icon: await this.pinIcon(build, spec.target),
                    description: build.name === 'Tabby' ? 'Tabby' : `Tabby — ${build.name}`,
                })
                this.notifications.info(this.translate.instant('{name} is now the active build, and the taskbar pin points at it', { name: build.name }))
            } catch (err) {
                // The config change stands: the pin is a convenience, and
                // failing to move it must not leave the page disagreeing with
                // itself about which build is active.
                this.notifications.error(String(err))
            }
        } else {
            this.notifications.info(this.translate.instant('{name} is now the active build', { name: build.name }))
        }
        onChanged()
    }

    /**
     * Where the pinned shortcut takes its icon from. A source build runs
     * through `electron.exe`, whose icon is Electron's — the checkout ships the
     * real one, so use that and keep the taskbar recognisable.
     */
    private async pinIcon (build: TabbyBuild, target: string): Promise<string> {
        if (build.kind === 'source' && build.repoPath) {
            const icon = path.join(build.repoPath, 'build', 'windows', 'icon.ico')
            try {
                await fs.access(icon)
                return icon
            } catch {
                // Not in this checkout; fall through to the binary.
            }
        }
        return target
    }

    /** Per-checkout so two source builds never share a profile — or a lock. */
    devProfileDirectory (repo: string): string {
        const configured: string = this.config.store.builds.devProfileDirectory ?? ''
        if (configured.trim()) {
            return configured.trim().startsWith('~')
                ? path.join(os.homedir(), configured.trim().slice(1))
                : configured.trim()
        }
        const hash = crypto.createHash('sha1').update(repo.toLowerCase()).digest('hex').slice(0, 8)
        return path.join(os.tmpdir(), `tabby-dev-profile-${hash}`)
    }

    reveal (build: TabbyBuild): void {
        this.platform.showItemInFolder(build.executable ?? build.root)
    }

    // ── Stopping ─────────────────────────────────────────────────────────

    /**
     * Close a build's processes, politely first. Returns true once none are
     * left. Never touches the current build: quitting ourselves from here would
     * take the page down mid-action.
     */
    async quit (build: TabbyBuild, onChanged: () => void, skipConfirm = false): Promise<boolean> {
        if (build.isCurrent || !build.processes.length) {
            return !build.processes.length
        }
        if (!skipConfirm && !await this.confirmQuit(build)) {
            return false
        }
        // Oldest process first: that is the main process, and closing it takes
        // the renderers and helpers with it.
        const pids = [...build.processes].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)).map(x => x.pid)
        await this.signal(pids, false)

        const deadline = Date.now() + QUIT_GRACE_MS
        while (Date.now() < deadline) {
            await sleep(500)
            await this.processes.list()
            if (!this.processes.forExecutable(build.executable).length) {
                build.processes = []
                onChanged()
                return true
            }
        }

        const remaining = this.processes.forExecutable(build.executable).map(x => x.pid)
        if (remaining.length) {
            await this.signal(remaining, true)
            await sleep(1000)
            await this.processes.list()
        }
        build.processes = this.processes.forExecutable(build.executable)
        onChanged()
        return !build.processes.length
    }

    private async signal (pids: number[], force: boolean): Promise<void> {
        if (process.platform === 'win32') {
            // /T so the whole tree goes, not just the main process. Without /F
            // this is a WM_CLOSE, which lets the app save state and exit.
            for (const pid of pids) {
                await run('taskkill', force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T'])
                    .catch(() => null)
            }
            return
        }
        for (const pid of pids) {
            try {
                process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
            } catch {
                // Already gone.
            }
        }
    }

    private async confirmQuit (build: TabbyBuild): Promise<boolean> {
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('Quit {name}?', { name: build.name }),
            detail: this.translate.instant(
                '{count} running process(es) will be closed. Anything running in that window — terminals, SSH sessions, agents — is lost.',
                { count: build.processes.length },
            ),
            buttons: [this.translate.instant('Cancel'), this.translate.instant('Quit')],
            defaultId: 0,
            cancelId: 0,
        })
        return result.response === 1
    }

    // ── Deleting ─────────────────────────────────────────────────────────

    /**
     * Remove a build from disk. A running build is closed first — the user
     * asked for the build to be gone, and refusing to act on the common case
     * (an old build still holding a window open) would make the button useless.
     */
    async delete (build: TabbyBuild, onChanged: () => void): Promise<void> {
        const blocked = this.deleteBlockedReason(build)
        if (blocked) {
            this.notifications.error(blocked)
            return
        }

        const targets = [build.root, ...build.extraPaths]
        const size = build.size ? humanBytes(build.size.bytes) : this.translate.instant('unknown size')
        const running = build.processes.length
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: running
                ? this.translate.instant('Quit and delete {name}?', { name: build.name })
                : this.translate.instant('Delete {name}?', { name: build.name }),
            detail: [
                running
                    ? this.translate.instant('{count} running process(es) will be closed first. Anything running in that window is lost.', { count: running })
                    : null,
                this.translate.instant('This permanently removes {size} from disk:', { size }),
                // A source build has a directory per plugin; listing all twenty
                // would push the buttons off the dialog.
                ...targets.slice(0, 6),
                targets.length > 6
                    ? this.translate.instant('…and {count} more', { count: targets.length - 6 })
                    : null,
            ].filter(x => !!x).join('\n'),
            buttons: [this.translate.instant('Cancel'), this.translate.instant('Delete')],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response !== 1) {
            return
        }

        if (running && !await this.quit(build, onChanged, true)) {
            this.notifications.error(this.translate.instant('{name} is still running; nothing was deleted', { name: build.name }))
            return
        }

        try {
            for (const target of targets) {
                await fs.rm(target, { recursive: true, force: true })
            }
            build.exists = false
            this.sizes.invalidate(build)
            this.notifications.info(this.translate.instant('Deleted {name}', { name: build.name }))
        } catch (err) {
            this.notifications.error(`${this.translate.instant('Could not delete')}: ${err}`)
        }
        onChanged()
    }

    /**
     * The installer's own uninstaller, when there is one — it also cleans up
     * registry entries and shortcuts, which deleting the directory does not.
     */
    private async runUninstaller (build: TabbyBuild): Promise<void> {
        if (!build.uninstaller) {
            return
        }
        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('Run the uninstaller for {name}?', { name: build.name }),
            detail: build.uninstaller,
            buttons: [this.translate.instant('Cancel'), this.translate.instant('Run')],
            defaultId: 0,
            cancelId: 0,
        })
        if (result.response !== 1) {
            return
        }
        spawn(build.uninstaller, [], { detached: true, stdio: 'ignore' }).unref()
    }
}
