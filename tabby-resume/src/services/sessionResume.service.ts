import { Injectable, NgZone } from '@angular/core'
import {
    AppService,
    BaseTabComponent,
    ConfigService,
    HostAppService,
    LogService,
    Logger,
    NotificationsService,
    Platform,
    PlatformService,
    SplitTabComponent,
    TranslateService,
} from 'tabby-core'
import { ClaudeActionsService, ClaudeSessionsService } from 'tabby-claude'

import { CapturedPane, QuotingStyle, ResumePolicy, ResumePlan, buildPlan, optionsOnly, programAllowed, programName, quoteArg, stripSessionSelectors } from '../recognize'
import { PaneCaptureService, PaneProbe } from './paneCapture.service'

/**
 * The property a restored pane arrives carrying, written onto it by
 * [[ResumeRecoveryAugmentor]] through `NewTabParameters.inputs`.
 *
 * An input rather than a registration made at restore time, because a pane
 * inside a restored split is never handed to anyone: `SplitTabComponent`
 * recovers its children straight into its own view, emitting no event for
 * them, so there is nothing to subscribe to. The tab itself is the only thing
 * that reliably arrives.
 */
export const RESUME_COMMAND_INPUT = 'resumeCommand'

/** What a restored pane is waiting to be given. */
interface PendingResume {
    tab: BaseTabComponent
    command: string
}

/** How long a restored pane has to appear before we stop looking for it. */
const CLAIM_TIMEOUT_MS = 20000
const CLAIM_INTERVAL_MS = 200
/** How long the sweep goes on finding nothing before it calls the batch done. */
const CLAIM_SETTLE_MS = 600

/**
 * Works out what every pane is running, keeps the answer, and hands it back to
 * the pane when the layout is restored.
 *
 * The capture is deliberately *not* on the save path. Tabby persists its tabs
 * on a debounce and a 30-second timer, and `AppService.closeWindow` disables
 * saving before its own final `saveTabs`, so there is no flush-before-quit
 * seam to hang a shutdown probe on — and hanging one there would delay the
 * quit for no gain, since the record it wrote would never be persisted.
 * Instead the save pass *triggers* a refresh and reads whatever the last
 * completed one cached, which costs the save nothing and makes a recorded
 * command at most one interval stale. That is the same guarantee Tabby already
 * gives for the scrollback it saves beside it.
 */
@Injectable({ providedIn: 'root' })
export class SessionResumeService {
    private logger: Logger
    private commands = new Map<BaseTabComponent, string>()
    private refreshing = false
    private lastRefresh = 0
    private pending: PendingResume[] = []
    private claudeWatch: { close: () => void } | null = null
    private sawClaude = false
    private expected = 0
    private claimed = 0
    private claiming = false
    private lastClaimAt = 0

    constructor (
        private app: AppService,
        private capture: PaneCaptureService,
        private claudeActions: ClaudeActionsService,
        private claudeSessions: ClaudeSessionsService,
        private config: ConfigService,
        private hostApp: HostAppService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private translate: TranslateService,
        private zone: NgZone,
        log: LogService,
    ) {
        this.logger = log.create('resume')
        this.app.tabsChanged$.subscribe(() => {
            for (const tab of [...this.commands.keys()]) {
                if (!this.liveTabs().includes(tab)) {
                    this.commands.delete(tab)
                }
            }
        })
        this.config.changed$.subscribe(() => this.applyClaudeWatch(this.sawClaude))
    }

    /**
     * Whether anything is eligible at all. Gates the capture (with everything
     * off, no amount of process walking could produce a result), seeding a
     * restored pane, and running what a saved layout asks for — so turning the
     * feature off stops commands recorded while it was on, rather than leaving
     * them to replay out of a layout written earlier.
     */
    get enabled (): boolean {
        const settings = this.config.store.resume
        if (!settings) {
            return false
        }
        return !!settings.agents || !!settings.multiplexers || (settings.extraPrograms ?? []).length > 0
    }

    get policy (): ResumePolicy {
        const settings = this.config.store.resume ?? {}
        return {
            agents: !!settings.agents,
            multiplexers: !!settings.multiplexers,
            extra: [...settings.extraPrograms ?? []],
            excluded: [...settings.excludedPrograms ?? []],
        }
    }

    /** The command recorded for a tab, for the recovery token. Never blocks. */
    commandFor (tab: BaseTabComponent): string {
        return this.enabled ? this.commands.get(tab) ?? '' : ''
    }

    /**
     * Carry a restored pane's command forward, so it survives being saved again
     * before anything has re-examined what the pane is running.
     *
     * Without this the feature quietly undoes itself: the capture runs on a
     * timer, so the first save after a restore would write the layout back with
     * no command at all and the next restart would restore a bare shell. Every
     * restart would lose it unless a whole capture cycle happened to fit in
     * between. The capture still overrides this, including clearing it when the
     * pane really is running nothing.
     */
    seed (tab: BaseTabComponent, command: string): void {
        if (command) {
            this.commands.set(tab, command)
        }
    }

    /**
     * Ask every pane what it is running. Throttled, and never awaited by a
     * caller on a save or render path.
     */
    async refresh (force = false): Promise<void> {
        if (!this.enabled || this.refreshing) {
            return
        }
        const interval = (this.config.store.resume?.refreshIntervalSec ?? 30) * 1000
        if (!force && Date.now() - this.lastRefresh < interval) {
            return
        }
        this.refreshing = true
        this.lastRefresh = Date.now()
        try {
            const tabs = this.liveTabs().filter(tab => this.sessionOf(tab))
            const probes: PaneProbe[] = []
            const byId = new Map<string, BaseTabComponent>()
            await Promise.all(tabs.map(async (tab, index) => {
                const probe = await this.probeFor(tab, String(index))
                if (probe) {
                    probes.push(probe)
                    byId.set(probe.paneId, tab)
                }
            }))
            if (!probes.length) {
                return
            }
            const result = await this.capture.capture(
                probes,
                this.config.store.resume?.wslProbeTimeoutMs ?? 5000,
            )
            // The registry watch is taken only once a pane is really running
            // claude, and before the plans are built so that this round can
            // already use it if the watch was already open.
            this.applyClaudeWatch(result.panes.some(x => programName(x.argv).name.toLowerCase() === 'claude'))
            const plans = new Map<string, string>()
            for (const captured of result.panes) {
                const plan = this.planFor(captured, byId.get(captured.paneId))
                if (plan) {
                    plans.set(captured.paneId, plan.command)
                }
            }
            // Only panes the probe actually answered about are updated. One
            // that was not measured — a distro that would not answer, a PTY
            // with no pid — keeps whatever was recorded for it, rather than
            // being cleared by a round that never looked at it.
            for (const paneId of result.answered) {
                const tab = byId.get(paneId)
                if (!tab) {
                    continue
                }
                const command = plans.get(paneId)
                if (command) {
                    this.commands.set(tab, command)
                } else {
                    this.commands.delete(tab)
                }
            }
        } catch (error) {
            this.logger.warn('Resume capture failed:', error)
        } finally {
            this.refreshing = false
        }
    }

    /**
     * The command for one captured pane.
     *
     * Claude is the one agent this fork can resolve a live conversation for,
     * and it is asked through `tabby-claude` rather than reimplemented here:
     * that service owns the join from a tab to a session and the recovery of
     * the directory the session was *launched* in, which is the directory a
     * `--resume` has to run from and is not the directory the pane reports.
     */
    private planFor (captured: CapturedPane, tab?: BaseTabComponent): ResumePlan | null {
        const { name, hostLaunched } = programName(captured.argv)
        if (name.toLowerCase() === 'claude' && tab && programAllowed(name, this.policy)) {
            const session = this.claudeSessions.forTab(tab)
            if (session) {
                const args = optionsOnly(stripSessionSelectors(hostLaunched ? captured.argv.slice(1) : captured.argv).slice(1))
                const quoting = captured.quoting ?? 'posix'
                return {
                    command: this.claudeActions.resumeCommand(session, {
                        args,
                        quote: arg => quoteArg(arg, quoting),
                        shell: quoting,
                    }),
                    resumesAgentSession: true,
                }
            }
        }
        return buildPlan(captured, this.policy)
    }

    // ── restore ──────────────────────────────────────────────────────────

    /**
     * One more restored pane is on its way. Called by the augmentor while the
     * layout is still being rebuilt, so the count is complete before the first
     * tab exists — `TabRecoveryService.recoverTabs` resolves every token before
     * any of them is opened.
     *
     * Knowing how many to expect is what lets everything be decided once:
     * "ask first" is one dialog listing every pane, not one prompt per pane.
     */
    expectRestore (): void {
        this.expected++
        if (!this.claiming) {
            this.claiming = true
            this.lastClaimAt = 0
            setTimeout(() => void this.claim(Date.now()), CLAIM_INTERVAL_MS)
        }
    }

    /**
     * Collect the restored panes as they appear, then decide once.
     *
     * A sweep rather than an event: a pane restored inside a split is created
     * by `SplitTabComponent` itself and announced to nobody, so the only
     * reliable signal that it exists is that it is now in the tab tree
     * carrying the input the augmentor put on it. Each sweep is two array
     * walks over the open tabs, every 200ms, and only while a restore is
     * outstanding.
     *
     * It stops when the count is met, but it must also stop when it is not:
     * `recoverTab` produces tab *parameters*, and nothing guarantees every one
     * of them is turned into a tab — one that is not would otherwise hold the
     * whole batch to the deadline and delay every real pane by twenty seconds.
     * Measured, before this: a resume typed 20s after the window opened. So
     * the batch also closes once it has stopped finding anything.
     */
    private async claim (startedAt: number): Promise<void> {
        for (const tab of this.liveTabs()) {
            const carrier = tab as any
            const command = carrier[RESUME_COMMAND_INPUT]
            if (typeof command !== 'string' || !command) {
                continue
            }
            // Claimed exactly once: the sweep runs again before these panes
            // have finished starting their sessions.
            carrier[RESUME_COMMAND_INPUT] = ''
            this.claimed++
            this.lastClaimAt = Date.now()
            this.pending.push({ tab, command })
        }
        const settled = this.lastClaimAt > 0 && Date.now() - this.lastClaimAt >= CLAIM_SETTLE_MS
        if (this.claimed < this.expected && !settled && Date.now() - startedAt < CLAIM_TIMEOUT_MS) {
            setTimeout(() => void this.claim(startedAt), CLAIM_INTERVAL_MS)
            return
        }
        this.claiming = false
        this.expected = 0
        this.claimed = 0
        await this.flush()
    }

    private async flush (): Promise<void> {
        const pending = this.pending
        this.pending = []
        if (!pending.length) {
            return
        }
        const mode = this.config.store.resume?.notification ?? 'toast'
        const listing = pending.map(x => `• ${x.command}`).join('\n')

        if (mode === 'confirm') {
            const result = await this.platform.showMessageBox({
                type: 'warning',
                message: this.translate.instant('Resume what these tabs were running?'),
                detail: listing,
                buttons: [this.translate.instant('Resume'), this.translate.instant('Not now')],
                defaultId: 0,
                cancelId: 1,
            })
            if (result.response !== 0) {
                // Declined. The panes keep the buffers they were restored with
                // and nothing is typed into them.
                return
            }
        }

        for (const item of pending) {
            void this.type(item.tab, item.command)
        }

        if (mode === 'toast') {
            this.zone.run(() => this.notifications.info(
                this.translate.instant('Resumed {n} session(s)', { n: pending.length }),
                listing,
            ))
        }
    }

    /**
     * Type the recorded command into a restored pane once its shell is up.
     *
     * Deliberately typed rather than launched. Putting it in the profile's own
     * command line would make it the pane's ROOT process, so the shell would
     * never run and the pane would close the moment the program exited. Sending
     * it as input runs the profile exactly as configured and then the command
     * inside it — which is where it was when we found it, and leaves a working
     * shell behind when it ends.
     */
    private async type (tab: BaseTabComponent, command: string): Promise<void> {
        const delay = this.config.store.resume?.inputDelayMs ?? 1200
        const session = await this.waitForSession(tab)
        if (!session) {
            return
        }
        // The PTY was adopted rather than started, so whatever was recorded is
        // still running in it and typing the command would start a second copy
        // on top of the first. The augmentor already declines to mark the pane
        // a window was opened to adopt; this covers any other path that ends
        // up reusing a live PTY.
        //
        // Deliberately not `savedStateIsLive`, which looks like exactly this
        // signal and is not: `terminalTab.component.ts` computes it in
        // `onFrontendReady`, before the session it compares against has a PTY,
        // so `getID()` is still null there and a *fresh* pane comes out `null
        // === null` — true. Measured live: every ordinary pane claims its
        // saved state is live. Asking the same question a second later, when
        // the PTY exists, is exact.
        const wanted = String((tab as any).profile?.options?.restoreFromPTYID ?? '')
        if (wanted && wanted === session.getID?.()) {
            this.logger.debug('Not resuming a pane that adopted a live PTY')
            return
        }
        await new Promise(resolve => setTimeout(resolve, delay))
        const terminal = tab as unknown as { sendInput?: (data: string) => void }
        if (!terminal.sendInput) {
            return
        }
        try {
            // The Enter goes as its own write: a lot of TUIs read a single
            // write containing both the text and the newline as a bulk paste
            // and never submit it.
            this.zone.run(() => {
                terminal.sendInput!(command)
                terminal.sendInput!('\r')
            })
        } catch (error) {
            this.logger.warn('Could not type a resume command:', error)
        }
    }

    /**
     * The pane's session, once it has one — for as long as that takes.
     *
     * A restored pane does not start its shell when it is restored; it starts
     * it the first time it is *rendered*, because `TerminalTabComponent` calls
     * `initializeSession()` from `onFrontendReady`. Only the tab that ends up
     * selected is rendered at startup, so restoring five panes gives you one
     * session and four tabs that are, for now, just titles.
     *
     * This is why the wait has no deadline. The first version gave up after
     * ten seconds and every restored pane but the active one silently lost its
     * resume — measured: two restored panes, `hasSession: false` on both,
     * hours later. Waiting instead means the command is typed when the pane
     * opens, which is also the first moment it could have been. The tab being
     * destroyed ends it.
     */
    private waitForSession (tab: BaseTabComponent): Promise<any> {
        const existing = this.sessionOf(tab)
        if (existing) {
            return Promise.resolve(existing)
        }
        return new Promise(resolve => {
            let timer: any = null
            const subscription = tab.destroyed$.subscribe(() => {
                clearInterval(timer)
                resolve(null)
            })
            timer = setInterval(() => {
                const session = this.sessionOf(tab)
                if (session) {
                    clearInterval(timer)
                    subscription.unsubscribe()
                    resolve(session)
                }
            }, 500)
        })
    }

    // ── plumbing ─────────────────────────────────────────────────────────

    /**
     * The Claude registry only polls while something is watching it, and its
     * tab↔session map is what a `claude` pane's conversation id comes from.
     *
     * The watch is therefore held only while a pane is actually running
     * claude, not merely while agent resume is switched on. Holding it on the
     * setting alone would have every user with the default configuration
     * polling the session registry for ever, for a join nothing is asking for
     * — and the setting is on by default. The cost of taking it late is that
     * the first capture after claude starts reports the bare command; the next
     * one, an interval later, reports the conversation.
     */
    private applyClaudeWatch (running: boolean): void {
        this.sawClaude = running
        const wanted = running && this.enabled && !!this.config.store.resume?.agents
        if (wanted && !this.claudeWatch) {
            this.claudeWatch = this.claudeSessions.watch()
        } else if (!wanted && this.claudeWatch) {
            this.claudeWatch.close()
            this.claudeWatch = null
        }
    }

    private liveTabs (): BaseTabComponent[] {
        const out: BaseTabComponent[] = []
        for (const tab of this.app.tabs) {
            if (tab instanceof SplitTabComponent) {
                out.push(...tab.getAllTabs())
            } else {
                out.push(tab)
            }
        }
        return out
    }

    private sessionOf (tab: BaseTabComponent): any {
        const session = (tab as any).session
        return session?.open ? session : null
    }

    /**
     * What we know about a pane before asking what it is running: its shell's
     * pid, the distro if it is a WSL pane, and the identity that pane exports
     * into its own environment.
     */
    private async probeFor (tab: BaseTabComponent, paneId: string): Promise<PaneProbe | null> {
        const session = this.sessionOf(tab)
        if (!session) {
            return null
        }
        const options: any = (tab as any).profile?.options ?? {}
        const distro = this.wslDistro(options)
        const sessionUID = String(session.sessionUID ?? '')
        // A WSL pane with no identity cannot be told apart from any other pane
        // in the same distro, and a wrong answer is worse than none. This is
        // the pane whose PTY was adopted from a previous window rather than
        // spawned, so its environment was set before this object existed.
        if (distro !== null && !sessionUID) {
            return null
        }
        let shellPid = 0
        if (distro === null) {
            shellPid = await session.getShellPID?.() ?? 0
        }
        return {
            paneId,
            shellPid,
            isWSL: distro !== null,
            distro: distro ?? '',
            sessionUID,
            quoting: this.quotingFor(options, distro !== null),
        }
    }

    /**
     * The distro a pane is running, or null when it is not a WSL pane.
     *
     * WSL shells are stored as `wsl.exe` with `['-d', <distro>]`. A profile
     * that names no distro comes back as the empty string rather than as "not
     * WSL": the probe then runs without `-d` too, which puts it in whichever
     * distro is default — by definition the one that pane opened.
     */
    private wslDistro (options: any): string | null {
        if (this.hostApp.platform !== Platform.Windows) {
            return null
        }
        const executable = String(options.command ?? '')
            .trim()
            .replace(/^"+|"+$/g, '')
            .split(/[\\/]/)
            .pop()
            ?.toLowerCase()
        if (executable !== 'wsl.exe') {
            return null
        }
        const args: string[] = options.args ?? []
        const flag = args.findIndex(a => a === '-d' || a === '--distribution')
        return flag !== -1 && args[flag + 1] ? args[flag + 1] : ''
    }

    private quotingFor (options: any, isWSL: boolean): QuotingStyle {
        if (isWSL || this.hostApp.platform !== Platform.Windows) {
            return 'posix'
        }
        switch (options.shellType) {
            case 'powershell': return 'powershell'
            case 'cmd': return 'cmd'
            case 'unix': return 'posix'
        }
        const executable = String(options.command ?? '').toLowerCase()
        if (/(powershell|pwsh)(\.exe)?"?$/.test(executable.trim())) {
            return 'powershell'
        }
        return 'cmd'
    }
}
