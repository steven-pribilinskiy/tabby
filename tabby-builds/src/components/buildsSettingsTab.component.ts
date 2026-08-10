import { Component } from '@angular/core'
import { BaseComponent, ConfigService, PlatformService } from 'tabby-core'

import { BuildKind, BuildsView, TabbyBuild } from '../api'
import { absoluteTime, humanAgo, humanBytes, humanDuration, shortPath } from '../format'
import { BuildActionsService } from '../services/buildActions.service'
import { BuildProcessesService, normalize } from '../services/buildProcesses.service'
import { BuildScannerService } from '../services/buildScanner.service'
import { BuildSizeService } from '../services/buildSize.service'
import { TaskbarService } from '../services/taskbar.service'

/** How often relative timestamps re-render when nothing else changes. */
const CLOCK_MS = 20000

const KIND_LABELS: Record<BuildKind, string> = {
    installed: 'Installed',
    portable: 'Portable',
    source: 'Source',
    packaged: 'Packaged',
    installer: 'Installer',
}

const KIND_CLASSES: Record<BuildKind, string> = {
    installed: 'primary',
    portable: 'dark',
    source: 'success',
    packaged: 'info',
    installer: 'secondary',
}

const KIND_ICONS: Record<BuildKind, string> = {
    installed: 'hard-drive',
    portable: 'boxes-stacked',
    source: 'code-branch',
    packaged: 'box',
    installer: 'download',
}

/** Filter order, which is also the order builds are grouped in. */
const KINDS: BuildKind[] = ['installed', 'portable', 'source', 'packaged', 'installer']

/** One tab's worth of builds. */
export interface BuildGroup {
    id: BuildKind
    label: string
    icon: string
    builds: TabbyBuild[]
}

/**
 * Every Tabby build on this machine, live.
 *
 * The tab bar already answers "which build is this window?"; this answers the
 * other half — what else is on the disk, what is running, what it costs, and
 * what can go. Process counts are polled; the filesystem scan and the size
 * walks are not, because they are far more expensive and change far less often.
 */
@Component({
    selector: 'builds-settings-tab',
    templateUrl: './buildsSettingsTab.component.pug',
    styleUrls: ['./buildsSettingsTab.component.scss'],
})
export class BuildsSettingsTabComponent extends BaseComponent {
    builds: TabbyBuild[] = []
    /**
     * Builds split by kind, one tab each. Recomputed only when the build list
     * itself changes: the group arrays hold the same objects the poll mutates,
     * so process counts stay live without rebuilding the tabs underneath the
     * user every three seconds.
     */
    groups: BuildGroup[] = []
    /** What the filter buttons currently select: 'all' or a BuildKind. */
    filter = 'all'
    /** `builds` narrowed by `filter` — a field, so *ngFor sees a stable array. */
    visible: TabbyBuild[] = []
    /** 'builds' or 'options'. */
    activeTab = 'builds'
    scanning = false
    /** Set when a scan throws; the page keeps the previous list rather than emptying. */
    error: string | null = null
    lastScan: number | null = null
    lastPoll: number | null = null
    /** What the Windows taskbar pin currently launches; null when not pinned. */
    pinTarget: string | null = null

    /**
     * Reference instant for every relative timestamp on screen, held as a field
     * so it cannot change between Angular's check and verify passes.
     */
    now = Date.now()

    // Exposed for the template; pug cannot import.
    humanBytes = humanBytes
    humanAgo = humanAgo
    humanDuration = humanDuration
    absoluteTime = absoluteTime
    shortPath = shortPath

    private busy = false
    private pollTimer: ReturnType<typeof setInterval> | null = null
    private rescanTimer: ReturnType<typeof setInterval> | null = null
    private clock: ReturnType<typeof setInterval> | null = null

    constructor (
        public config: ConfigService,
        private actions: BuildActionsService,
        private platform: PlatformService,
        private processes: BuildProcessesService,
        private scanner: BuildScannerService,
        private sizes: BuildSizeService,
        private taskbar: TaskbarService,
    ) {
        super()
    }

    ngOnInit (): void {
        void this.rescan()
        this.pollTimer = setInterval(() => void this.poll(), this.config.store.builds.processPollMs)
        this.rescanTimer = setInterval(() => void this.rescan(true), this.config.store.builds.rescanMs)
        this.clock = setInterval(() => {
            this.now = Date.now()
        }, CLOCK_MS)
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        for (const timer of [this.pollTimer, this.rescanTimer, this.clock]) {
            if (timer) {
                clearInterval(timer)
            }
        }
    }

    // ── Data ─────────────────────────────────────────────────────────────

    /**
     * `quiet` is the periodic refresh: it must not flash the spinner or wipe
     * the list, or the page would flicker every minute while being read.
     */
    async rescan (quiet = false): Promise<void> {
        // `scanning` drives the spinner and so is only set for a visible scan;
        // `busy` is what actually stops two scans overlapping.
        if (this.busy) {
            return
        }
        if (quiet && this.paused) {
            return
        }
        this.busy = true
        this.scanning = !quiet
        try {
            const builds = await this.scanner.scan()
            const configPath = this.platform.getConfigPath()
            for (const build of builds) {
                build.size = this.sizes.get(build)
                if (build.isCurrent) {
                    build.configPath = configPath
                }
            }
            await this.resolveActive(builds)
            this.builds = builds
            this.regroup()
            this.error = null
            this.lastScan = Date.now()
            if (this.config.store.builds.autoSize) {
                for (const build of builds) {
                    this.sizes.request(build, () => {
                        this.now = Date.now()
                    })
                }
            }
            await this.poll(true)
        } catch (err) {
            this.error = String(err)
        } finally {
            this.scanning = false
            this.busy = false
        }
    }

    /** Re-attribute processes to builds. The only thing polled at speed. */
    private async poll (force = false): Promise<void> {
        if (!force && this.paused) {
            return
        }
        await this.processes.list()
        for (const build of this.builds) {
            build.processes = this.processes.forExecutable(build.executable)
        }
        this.lastPoll = Date.now()
        this.now = Date.now()
    }

    /** Polling stops while the window is in the background: it costs a subprocess. */
    private get paused (): boolean {
        return this.config.store.builds.pauseWhenUnfocused && !document.hasFocus()
    }

    /**
     * Work out which build is the active one — the build the taskbar pin
     * launches, and the one that may not be deleted.
     *
     * There is always exactly one. If the configured build has been deleted or
     * moved, another is adopted rather than leaving the machine with no
     * nominated Tabby: an installed app first, then the build this window came
     * from, then anything that can be launched at all.
     */
    private async resolveActive (builds: TabbyBuild[]): Promise<void> {
        let wanted: string = this.config.store.builds.activeExecutable ?? ''
        if (!wanted) {
            // First run: adopt whatever the taskbar pin already points at, so
            // the page starts out agreeing with the desktop instead of
            // overruling it.
            wanted = (await this.taskbar.read())?.target ?? ''
        }
        const launchable = builds.filter(x => !!x.executable)
        let active: TabbyBuild | null = null
        if (wanted) {
            active = launchable.find(x => normalize(x.executable!) === normalize(wanted)) ?? null
        }
        if (!active) {
            active = launchable.find(x => x.kind === 'installed')
                ?? launchable.find(x => x.isCurrent)
                ?? null
        }
        if (!active && launchable.length) {
            active = launchable[0]
        }

        for (const build of builds) {
            build.isActive = build === active
        }
        this.pinTarget = (await this.taskbar.read())?.target ?? null

        const resolved = active ? active.executable ?? '' : ''
        if (resolved !== this.config.store.builds.activeExecutable) {
            this.config.store.builds.activeExecutable = resolved
            this.config.save()
        }
    }

    /**
     * A kind with nothing in it gets no filter button. If that kind was the
     * selected filter — the last packaged build was just deleted, say — fall
     * back to All rather than showing an empty list.
     */
    private regroup (): void {
        this.groups = KINDS
            .map(id => ({
                id,
                label: KIND_LABELS[id],
                icon: KIND_ICONS[id],
                builds: this.builds.filter(x => x.kind === id),
            }))
            .filter(group => group.builds.length)
        if (this.filter !== 'all' && !this.groups.some(x => x.id === this.filter)) {
            this.filter = 'all'
        }
        this.applyFilter()
    }

    setFilter (filter: string): void {
        this.filter = filter
        this.applyFilter()
    }

    private applyFilter (): void {
        this.visible = this.filter === 'all'
            ? this.builds
            : this.builds.filter(x => x.kind === this.filter)
    }

    trackGroup (_index: number, group: BuildGroup): string {
        return group.id
    }

    // ── Summary ──────────────────────────────────────────────────────────

    get runningCount (): number {
        return this.builds.filter(x => x.processes.length).length
    }

    get processCount (): number {
        return this.builds.reduce((sum, x) => sum + x.processes.length, 0)
    }

    get memoryTotal (): number {
        return this.builds.reduce(
            (sum, x) => sum + x.processes.reduce((s, p) => s + p.memoryBytes, 0), 0)
    }

    /** Null while any build is still being measured, so no half-total is shown. */
    get sizeTotal (): number | null {
        if (this.builds.some(x => !x.size)) {
            return null
        }
        return this.builds.reduce((sum, x) => sum + (x.size?.bytes ?? 0), 0)
    }

    // ── Per-build display ────────────────────────────────────────────────

    kindLabel (build: TabbyBuild): string {
        return KIND_LABELS[build.kind]
    }

    kindClass (build: TabbyBuild): string {
        return KIND_CLASSES[build.kind]
    }

    memoryOf (build: TabbyBuild): number {
        return build.processes.reduce((sum, p) => sum + p.memoryBytes, 0)
    }

    /** Uptime of the oldest process — that is when the app itself started. */
    uptimeOf (build: TabbyBuild): number | null {
        const started = build.processes
            .map(x => x.startedAt)
            .filter((x): x is number => !!x)
        return started.length ? this.now - Math.min(...started) : null
    }

    /** A source build whose checkout has moved on since it was compiled. */
    isStale (build: TabbyBuild): boolean {
        return !!build.git?.builtFrom && !!build.git.head && build.git.builtFrom !== build.git.head
    }

    pidList (build: TabbyBuild): string {
        return build.processes.map(x => x.pid).join(', ')
    }

    trackBuild (_index: number, build: TabbyBuild): string {
        return build.id
    }

    // ── Actions ──────────────────────────────────────────────────────────

    launch (build: TabbyBuild): void {
        void this.actions.launch(build)
    }

    makeActive (build: TabbyBuild): void {
        void this.actions.setActive(build, () => void this.rescan(true))
    }

    get taskbarSupported (): boolean {
        return this.taskbar.isSupported()
    }

    get taskbarShortcutPath (): string {
        return this.taskbar.shortcutPath()
    }

    reveal (build: TabbyBuild): void {
        this.actions.reveal(build)
    }

    copyPath (build: TabbyBuild): void {
        this.platform.setClipboard({ text: build.root })
    }

    menu (build: TabbyBuild, event: MouseEvent): void {
        event.stopPropagation()
        this.actions.popupMenu(build, () => void this.rescan(true), event)
    }

    quit (build: TabbyBuild): void {
        void this.actions.quit(build, () => void this.poll(true))
    }

    delete (build: TabbyBuild): void {
        void this.actions.delete(build, () => void this.rescan(true))
    }

    deleteLabel (build: TabbyBuild): string {
        return this.actions.deleteLabel(build)
    }

    deleteBlockedReason (build: TabbyBuild): string | null {
        return this.actions.deleteBlockedReason(build)
    }

    devProfileFor (build: TabbyBuild): string | null {
        return build.repoPath ? this.actions.devProfileDirectory(build.repoPath) : null
    }

    // ── Settings ─────────────────────────────────────────────────────────

    get view (): BuildsView {
        return this.config.store.builds.view
    }

    setView (view: BuildsView): void {
        this.config.store.builds.view = view
        this.config.save()
    }

    get searchRootsText (): string {
        return (this.config.store.builds.searchRoots ?? []).join('\n')
    }

    set searchRootsText (value: string) {
        this.config.store.builds.searchRoots = value
            .split('\n')
            .map(x => x.trim())
            .filter(x => !!x)
    }

    saveAndRescan (): void {
        this.config.save()
        void this.rescan()
    }

    saveConfiguration (): void {
        this.config.save()
    }
}
