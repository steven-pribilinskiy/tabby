import { spawn } from 'child_process'
import { Injectable } from '@angular/core'
import { Observable, Subject } from 'rxjs'
import { ConfigService, HostWindowService, NotificationsService, PlatformService, TranslateService } from 'tabby-core'

import { TabbyBuild } from '../api'
import { BuildActionsService } from './buildActions.service'
import { normalize } from './buildProcesses.service'
import { BuildScannerService } from './buildScanner.service'

/** Kinds that can replace a running build. An installer is not a build to switch to. */
const SWITCHABLE = new Set(['portable', 'packaged', 'installed'])

/**
 * Notices when a newer build than this one appears on the machine, and offers
 * to move to it.
 *
 * The fork is developed in place, so a fresh slot gets cut while an older one
 * is running with a day's work in its tabs. Nothing announced that, and
 * "which build am I on and is there a newer one?" was a question you had to
 * remember to ask.
 */
@Injectable({ providedIn: 'root' })
export class NewBuildWatcherService {
    /** The newer build, once one has been found. Drives the toolbar button. */
    available: TabbyBuild | null = null
    /** Fires when `available` changes, so the toolbar can ask again. */
    get changed$ (): Observable<void> { return this.changed }
    private changed = new Subject<void>()
    /** The build this window runs from, so a switch knows what it replaces. */
    private current: TabbyBuild | null = null
    /** Ids already offered, so a declined switch is not re-offered every poll. */
    private offered = new Set<string>()
    private timer: ReturnType<typeof setInterval> | null = null

    constructor (
        private actions: BuildActionsService,
        private config: ConfigService,
        private hostWindow: HostWindowService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private scanner: BuildScannerService,
        private translate: TranslateService,
    ) { }

    /** Defensive: config may not have loaded when something asks. */
    private get enabled (): boolean {
        return !!this.config.store?.builds?.watchForNewBuilds
    }

    start (): void {
        if (this.timer ?? !this.enabled) {
            return
        }
        // A first look shortly after boot, then on a slow timer: cutting a
        // build takes minutes, so checking often buys nothing.
        setTimeout(() => void this.check(), 20000)
        this.timer = setInterval(
            () => void this.check(),
            this.config.store?.builds?.watchIntervalMs ?? 300000,
        )
    }

    stop (): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    /** Look for something newer. Silent unless it finds one it has not offered. */
    async check (announce = true): Promise<TabbyBuild | null> {
        if (!this.enabled) {
            return null
        }
        let builds: TabbyBuild[] = []
        try {
            builds = await this.scanner.scan()
        } catch {
            return null
        }
        const current = builds.find(x => x.isCurrent)
        if (!current?.builtAt) {
            // Nothing to compare against — a build we cannot date cannot be
            // called out of date.
            return null
        }
        this.current = current

        const candidates = builds
            .filter(x => SWITCHABLE.has(x.kind) && !!x.executable && !!x.builtAt)
            .filter(x => normalize(x.root) !== normalize(current.root))
            .filter(x => (x.builtAt ?? 0) > (current.builtAt ?? 0))
            .sort((a, b) => (b.builtAt ?? 0) - (a.builtAt ?? 0))
        const newer: TabbyBuild | null = candidates.length ? candidates[0] : null

        const was = this.available?.id ?? null
        this.available = newer
        if ((newer?.id ?? null) !== was) {
            this.changed.next()
        }
        if (announce && newer && !this.offered.has(newer.id)) {
            this.offered.add(newer.id)
            await this.offer(newer)
        }
        return newer
    }

    /**
     * The choice. Deliberately a real dialog rather than a toast: two of the
     * three answers close this window, and one of them deletes a build — not
     * things to put behind something that fades away on its own.
     */
    async offer (build: TabbyBuild | null = this.available): Promise<void> {
        if (!build) {
            return
        }
        const current = this.current
        const canDelete = !!current && !current.isActive
        const buttons = [
            this.translate.instant('Not now'),
            this.translate.instant('Switch'),
        ]
        if (canDelete) {
            buttons.push(this.translate.instant('Switch and delete this build'))
        }

        const result = await this.platform.showMessageBox({
            type: 'warning',
            message: this.translate.instant('A newer build is available: {name}', { name: build.name }),
            detail: [
                this.translate.instant('Running now: {name} ({version})', {
                    name: current?.name ?? '?', version: current?.version ?? '?',
                }),
                this.translate.instant('Available:   {name} ({version})', {
                    name: build.name, version: build.version ?? '?',
                }),
                '',
                this.translate.instant('Switching starts the new build and closes this window. Anything running in it — terminals, SSH sessions, agents — goes with it.'),
                canDelete
                    ? this.translate.instant('Deleting removes this build from disk once this window has exited.')
                    : this.translate.instant('This build is the active one, so it cannot be deleted; make another active first.'),
            ].join('\n'),
            buttons,
            defaultId: 0,
            cancelId: 0,
        })

        if (result.response === 1) {
            await this.switchTo(build, false)
        } else if (result.response === 2) {
            await this.switchTo(build, true)
        }
    }

    /**
     * Start the new build, hand it the taskbar pin, and close this one.
     *
     * A build cannot delete its own directory while it is running, so the
     * removal is handed to a detached watcher that waits for this process to
     * exit first.
     */
    private async switchTo (build: TabbyBuild, deleteCurrent: boolean): Promise<void> {
        const spec = this.actions.launchSpec(build)
        if (!spec) {
            this.notifications.error(this.translate.instant('{name} cannot be launched', { name: build.name }))
            return
        }
        try {
            spawn(spec.target, spec.args, {
                cwd: spec.cwd,
                detached: true,
                stdio: 'ignore',
                env: { ...process.env, ...spec.env },
            }).unref()
        } catch (err) {
            this.notifications.error(String(err))
            return
        }

        // The new build becomes the one the pin launches, or the next start
        // would quietly go back to the build just left behind.
        await this.actions.setActive(build, () => null)

        if (deleteCurrent && this.current) {
            this.scheduleRemoval(this.current.root)
        }
        // The normal close path, so tab-close confirmations still run.
        this.hostWindow.close()
    }

    /**
     * Delete a directory once this process is gone. Detached on purpose: it has
     * to outlive the window that asked for it.
     */
    private scheduleRemoval (root: string): void {
        if (process.platform !== 'win32') {
            const shell = `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; rm -rf '${root.replace(/'/g, '\'\\\'\'')}'`
            spawn('sh', ['-c', shell], { detached: true, stdio: 'ignore' }).unref()
            return
        }
        const script = [
            `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }`,
            'Start-Sleep -Seconds 2',
            `Remove-Item -LiteralPath '${root.replace(/'/g, '\'\'')}' -Recurse -Force -ErrorAction SilentlyContinue`,
        ].join('; ')
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        })
        child.unref()
    }

    /** Never offer this one again, even on a later scan. */
    dismiss (): void {
        if (this.available) {
            this.offered.add(this.available.id)
        }
        this.available = null
    }
}
