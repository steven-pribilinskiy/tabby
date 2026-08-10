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

/** How long a build gets to shut down cleanly before it is killed outright. */
const QUIT_GRACE_MS = 12000

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
        return null
    }

    // ── Launching ────────────────────────────────────────────────────────

    async launch (build: TabbyBuild): Promise<void> {
        if (!build.executable) {
            return
        }
        try {
            if (build.kind === 'source' && build.repoPath) {
                this.launchSource(build.repoPath, build.executable)
            } else {
                spawn(build.executable, [], {
                    detached: true,
                    stdio: 'ignore',
                    windowsHide: false,
                }).unref()
            }
            this.notifications.info(this.translate.instant('Launching {name}', { name: build.name }))
        } catch (err) {
            this.notifications.error(String(err))
        }
    }

    /**
     * A source build has to be started with an isolated profile and a scrubbed
     * environment, or it will not start at all: Electron's single-instance lock
     * is keyed on the user data directory, so it would collide with the
     * installed app, and an inherited NODE_PATH makes it load the *installed*
     * app's plugins against this checkout's tabby-core.
     */
    private launchSource (repo: string, electron: string): void {
        const profile = this.devProfileDirectory(repo)
        spawn(electron, [`--user-data-dir=${profile}`, 'app'], {
            cwd: repo,
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                NODE_PATH: path.join(repo, 'app', 'node_modules'),
                TABBY_PLUGINS: '',
                TABBY_DEV: '1',
                TABBY_CONFIG_DIRECTORY: profile,
            },
        }).unref()
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
