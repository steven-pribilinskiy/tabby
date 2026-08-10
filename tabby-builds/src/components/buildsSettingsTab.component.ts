import { Component } from '@angular/core'
import { BaseComponent, ConfigService, PlatformService } from 'tabby-core'

import { BuildKind, BuildsView, HealthFinding, TabbyBuild } from '../api'
import { absoluteTime, humanAgo, humanBytes, humanDuration, shortPath } from '../format'
import { BuildActionsService } from '../services/buildActions.service'
import { BuildDoctorService } from '../services/buildDoctor.service'
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
    /** Column the table sorts by; null keeps the scanner's natural order. */
    sortKey: string | null = null
    sortDescending = false
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
        private doctor: BuildDoctorService,
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
    async rescan (quiet = false, force = false): Promise<void> {
        // `scanning` drives the spinner and so is only set for a visible scan;
        // `busy` is what actually stops two scans overlapping.
        if (this.busy) {
            return
        }
        // `force` is for refreshes that follow something the user just did.
        // Those must never be swallowed by the unfocused pause — and a native
        // confirm dialog leaves the window briefly unfocused, which is exactly
        // when a post-action refresh runs.
        if (quiet && !force && this.paused) {
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
            // After the poll, so the live checks see the processes.
            if (this.config.store.builds.autoDiagnose) {
                await this.diagnoseAll()
            }
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

    /**
     * Click a column to sort by it, click again to reverse, a third time to go
     * back to the natural order — current build first, then by kind, then
     * newest. That default carries real meaning, so it has to be reachable.
     */
    setSort (key: string): void {
        if (this.sortKey !== key) {
            this.sortKey = key
            this.sortDescending = key === 'built' || key === 'size' || key === 'files'
                || key === 'procs' || key === 'memory'
        } else if (!this.sortDescending) {
            this.sortKey = null
        } else {
            this.sortDescending = false
        }
        this.applyFilter()
    }

    sortIcon (key: string): string {
        if (this.sortKey !== key) {
            return ''
        }
        return this.sortDescending ? 'fa-arrow-down-wide-short' : 'fa-arrow-up-short-wide'
    }

    /**
     * Sorting happens here rather than on every poll: process counts change
     * every few seconds, and re-ordering rows under someone reading them is
     * worse than a stale position.
     */
    private applyFilter (): void {
        const rows = this.filter === 'all'
            ? [...this.builds]
            : this.builds.filter(x => x.kind === this.filter)
        if (this.sortKey) {
            const key = this.sortKey
            rows.sort((a, b) => {
                const left = this.sortValue(a, key)
                const right = this.sortValue(b, key)
                const order = left < right ? -1 : left > right ? 1 : 0
                return this.sortDescending ? -order : order
            })
        }
        this.visible = rows
    }

    private sortValue (build: TabbyBuild, key: string): string | number {
        switch (key) {
            case 'kind': return KINDS.indexOf(build.kind)
            case 'name': return build.name.toLowerCase()
            case 'version': return (build.version ?? '').toLowerCase()
            case 'procs': return build.processes.length
            case 'memory': return this.memoryOf(build)
            // Unmeasured sorts below anything measured rather than as zero.
            case 'size': return build.size ? build.size.bytes : -1
            case 'files': return build.size ? build.size.files : -1
            case 'built': return build.builtAt ?? 0
            case 'arch': return (build.arch ?? '').toLowerCase()
            case 'branch': return (build.git?.branch ?? '').toLowerCase()
            case 'path': return build.root.toLowerCase()
            default: return 0
        }
    }

    trackGroup (_index: number, group: BuildGroup): string {
        return group.id
    }

    // ── Health ───────────────────────────────────────────────────────────

    /** Cheap enough to run for every build on every scan — all `access` calls. */
    async diagnoseAll (): Promise<void> {
        for (const build of this.builds.filter(x => this.doctor.isCheckable(x))) {
            build.health = await this.doctor.examine(build)
        }
        this.now = Date.now()
    }

    canDiagnose (build: TabbyBuild): boolean {
        return this.doctor.isCheckable(build)
    }

    async diagnose (build: TabbyBuild): Promise<void> {
        build.health = await this.doctor.examine(build)
        this.now = Date.now()
    }

    get brokenCount (): number {
        return this.builds.filter(x => x.health?.verdict === 'broken').length
    }

    /** Act on a finding. Each fix is the one correct action for that cause. */
    applyFix (build: TabbyBuild, finding: HealthFinding): void {
        switch (finding.fix) {
            case 'restart':
                void this.actions.restart(build, () => void this.rescan(true, true))
                break
            case 'reinstall':
                void this.doctor.findRepairInstaller(build, this.builds)
                    .then(installer => this.actions.repair(build, installer))
                break
            case 'revealUserPlugins':
                this.actions.revealUserPlugins(build)
                break
            default:
                break
        }
    }

    fixLabel (finding: HealthFinding): string {
        switch (finding.fix) {
            case 'restart': return 'Restart'
            case 'reinstall': return 'Reinstall'
            case 'revealUserPlugins': return 'Open the folder'
            default: return ''
        }
    }

    restart (build: TabbyBuild): void {
        void this.actions.restart(build, () => void this.rescan(true, true))
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
        void this.actions.setActive(build, () => void this.rescan(true, true))
    }

    get taskbarSupported (): boolean {
        return this.taskbar.isSupported()
    }

    get taskbarShortcutPath (): string {
        return this.taskbar.pinDirectory()
    }

    reveal (build: TabbyBuild): void {
        this.actions.reveal(build)
    }

    copyPath (build: TabbyBuild): void {
        this.platform.setClipboard({ text: build.root })
    }

    menu (build: TabbyBuild, event: MouseEvent): void {
        event.stopPropagation()
        this.actions.popupMenu(build, () => void this.rescan(true, true), event)
    }

    quit (build: TabbyBuild): void {
        void this.actions.quit(build, () => void this.poll(true))
    }

    delete (build: TabbyBuild): void {
        void this.actions.delete(build, () => {
            // Drop it here rather than waiting for the scan to notice: the
            // build is gone the moment the delete returns, and leaving its card
            // on screen until the next poll reads as "that did not work".
            this.builds = this.builds.filter(x => x.exists)
            this.regroup()
            void this.rescan(true, true)
        })
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
