import { Component } from '@angular/core'
import { AppService, BaseComponent, ConfigService, PlatformService } from 'tabby-core'

import { ClaudeBookmarkLink, ClaudeSession, ClaudeUsage, ClaudeUsageWindow, StithHealth } from '../api'
import { formatTokens, permissionBadge, relativeTime, sessionKind, sessionTitle, statusLabel } from '../format'
import { ClaudeActionsService } from '../services/claudeActions.service'
import { ClaudeSessionsService } from '../services/claudeSessions.service'
import { StithService } from '../services/stith.service'

/** How often relative timestamps re-render when nothing else changes. */
const RELATIVE_TIME_REFRESH_MS = 20000

/**
 * The docked Claude panel: what the statusline shows, for the session attached
 * to the current tab, plus everything the statusline has no room for — the
 * other running sessions, which of them are blocked on you, and plan usage.
 */
@Component({
    selector: 'claude-panel',
    templateUrl: './claudePanel.component.pug',
    styleUrls: ['./claudePanel.component.scss'],
})
export class ClaudePanelComponent extends BaseComponent {
    sessions: ClaudeSession[] = []
    usage: ClaudeUsage[] = []
    health: StithHealth = 'never-tried'
    /** Session shown in the header block — follows the active tab. */
    activeSession: ClaudeSession | null = null

    /**
     * Reference instant for every relative timestamp on screen. Held as a field
     * so it cannot change between Angular's check and verify passes; advanced
     * on a slow timer so "2 minutes ago" still ages while nothing else happens.
     */
    now = Date.now()

    // Exposed for the template; pug cannot import.
    formatTokens = formatTokens
    relativeTime = relativeTime
    sessionKind = sessionKind
    sessionTitle = sessionTitle
    statusLabel = statusLabel
    permissionBadge = permissionBadge

    private watchHandle: { close: () => void } | null = null
    private clock: ReturnType<typeof setInterval> | null = null

    constructor (
        public config: ConfigService,
        private claude: ClaudeSessionsService,
        private stith: StithService,
        private actions: ClaudeActionsService,
        private app: AppService,
        private platform: PlatformService,
    ) {
        super()
    }

    ngOnInit (): void {
        this.watchHandle = this.claude.watch()
        this.subscribeUntilDestroyed(this.claude.sessions$, sessions => {
            this.sessions = sessions
            this.activeSession = this.claude.focusedSession
            this.now = Date.now()
        })
        this.clock = setInterval(() => {
            this.now = Date.now()
        }, RELATIVE_TIME_REFRESH_MS)
        this.subscribeUntilDestroyed(this.stith.usage$, usage => {
            this.usage = usage
        })
        this.subscribeUntilDestroyed(this.stith.health$, health => {
            this.health = health
        })
        // The panel follows the active tab, which changes independently of the
        // poll — without this it would keep showing the previous tab's session
        // until the next refresh landed.
        this.subscribeUntilDestroyed(this.app.activeTabChange$, () => {
            this.activeSession = this.claude.focusedSession
        })
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        this.watchHandle?.close()
        if (this.clock) {
            clearInterval(this.clock)
        }
    }

    /** Bound in the template so every relative label shares one instant. */
    ago (timestamp: number | null | undefined): string {
        return relativeTime(timestamp, this.now)
    }

    get options (): any {
        return this.config.store.claude.panel
    }

    // The three lists partition the sessions rather than overlapping: a session
    // blocked on you was otherwise listed twice, once under "Waiting on you"
    // and again under "Other sessions", which both padded the counts and made
    // the panel look like there was more running than there was.

    get waitingSessions (): ClaudeSession[] {
        const active = this.activeSession
        return this.sessions.filter(x =>
            x.sessionId !== active?.sessionId && (x.waitingOnPermission || x.awaitingInput))
    }

    get otherSessions (): ClaudeSession[] {
        const active = this.activeSession
        return this.sessions
            .filter(x => x.sessionId !== active?.sessionId && !x.waitingOnPermission && !x.awaitingInput)
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    }

    /**
     * Usage windows worth drawing. stith reports a window per account, but an
     * account that has never been used in the period comes back with no `pct`
     * at all — rendering those produced bars labelled "5h %" with an empty
     * value and a full-width "ok" fill.
     */
    usageWindows (account: ClaudeUsage): { label: string, window: ClaudeUsageWindow }[] {
        const out: { label: string, window: ClaudeUsageWindow }[] = []
        if (typeof account.session?.pct === 'number') {
            out.push({ label: '5h', window: account.session })
        }
        if (typeof account.weekly?.pct === 'number') {
            out.push({ label: 'Weekly', window: account.weekly })
        }
        return out
    }

    /** Accounts with nothing to show are dropped entirely, header and all. */
    get usableUsage (): ClaudeUsage[] {
        return this.usage.filter(x => this.usageWindows(x).length > 0)
    }

    get stithBaseURL (): string {
        return this.stith.baseURL
    }

    // Flat accessors rather than deep optional chains in the template: with
    // strictTemplates on, `session.metrics.x` behind an `*ngIf` is not narrowed,
    // and threading `as` aliases through every block obscures the markup.

    hasContext (session: ClaudeSession): boolean {
        return session.metrics?.contextFraction !== undefined
    }

    contextLabel (session: ClaudeSession): string {
        return `${formatTokens(session.metrics?.contextTokens)} / ${formatTokens(session.metrics?.contextLimit)}`
    }

    /** Percentage width for a context bar, as a string for the template. */
    contextWidth (session: ClaudeSession): string {
        return `${Math.round((session.metrics?.contextFraction ?? 0) * 100)}%`
    }

    contextPercent (session: ClaudeSession): string {
        const fraction = session.metrics?.contextFraction
        return fraction === undefined ? '—' : `${Math.round(fraction * 100)}%`
    }

    lastPrompt (session: ClaudeSession): string {
        return session.metrics?.lastPrompt ?? ''
    }

    queuedPrompts (session: ClaudeSession): string[] {
        return session.metrics?.queuedPrompts ?? []
    }

    waitingMessage (session: ClaudeSession): string {
        return session.waitingMessage ?? ''
    }

    bookmarkDescription (session: ClaudeSession): string {
        return session.bookmark?.description ?? ''
    }

    /**
     * Only `link` targets are openable — `file` and `branch` targets are paths
     * inside whichever machine the session runs on, so they are shown as
     * context rather than pretending they are clickable from here.
     */
    bookmarkLinks (session: ClaudeSession): ClaudeBookmarkLink[] {
        return session.bookmark?.links ?? []
    }

    isOpenableLink (link: ClaudeBookmarkLink): boolean {
        return link.kind === 'link' && /^https?:\/\//.test(link.target)
    }

    linkLabel (link: ClaudeBookmarkLink): string {
        if (link.label) {
            return link.label
        }
        // Fall back to the last meaningful path/URL segment rather than a full
        // 80-character path that would blow the panel out.
        const trimmed = link.target.replace(/\/+$/, '')
        const segment = trimmed.split(/[/\\]/).pop()
        // A target that is all separators leaves an empty segment; fall back to
        // the raw target rather than rendering a blank row.
        return segment ? segment : link.target
    }

    openLink (link: ClaudeBookmarkLink): void {
        if (this.isOpenableLink(link)) {
            this.platform.openExternal(link.target)
        }
    }

    /** Bars go amber then red as a window fills, matching the statusline. */
    contextSeverity (session: ClaudeSession): string {
        const fraction = session.metrics?.contextFraction ?? 0
        if (fraction >= 0.9) {
            return 'critical'
        }
        if (fraction >= 0.75) {
            return 'warning'
        }
        return 'ok'
    }

    usageSeverity (pct: number): string {
        if (pct >= 90) {
            return 'critical'
        }
        if (pct >= 75) {
            return 'warning'
        }
        return 'ok'
    }

    /** Runs whichever action the user nominated as the click default. */
    selectSession (session: ClaudeSession): void {
        this.actions.runDefault(session, () => this.toggleDetails(session))
    }

    openMenu (session: ClaudeSession, event: MouseEvent): void {
        // Stop the row's own click handler from also firing its default action.
        event.stopPropagation()
        event.preventDefault()
        this.actions.popupMenu(session, () => this.toggleDetails(session), event)
    }

    openInStith (session: ClaudeSession): void {
        void this.platform.openExternal(`${this.stith.baseURL}/s/${session.sessionId}`)
    }

    // ── Details ──────────────────────────────────────────────────────

    /** sessionId whose full record is expanded, or null. */
    detailsFor: string | null = null
    /** The freshest record for that session, fetched on expand. */
    details: ClaudeSession | null = null
    detailsLoading = false

    isExpanded (session: ClaudeSession): boolean {
        return this.detailsFor === session.sessionId
    }

    toggleDetails (session: ClaudeSession): void {
        if (this.detailsFor === session.sessionId) {
            this.detailsFor = null
            this.details = null
            return
        }
        this.detailsFor = session.sessionId
        // Show the polled copy immediately, then replace it with the full
        // record — an expand should never look like it did nothing.
        this.details = session
        this.detailsLoading = true
        void this.stith.getSession(session.sessionId).then(full => {
            if (this.detailsFor === session.sessionId) {
                this.details = full ?? session
                this.detailsLoading = false
            }
        })
    }

    /** Flattened key/value rows for the details view. */
    detailRows (session: ClaudeSession): { key: string, value: string }[] {
        const rows: { key: string, value: string }[] = [
            { key: 'Session', value: session.sessionId },
            { key: 'Project', value: session.projectName },
            { key: 'Launch directory', value: this.claude.launchDirectory(session) },
            { key: 'Current directory', value: session.cwd },
            { key: 'Environment', value: session.envLabel },
            { key: 'Machine', value: session.machine + (session.isRemote ? ' (remote)' : '') },
            { key: 'Status', value: statusLabel(session) },
            { key: 'Model', value: session.model ?? '—' },
            { key: 'Effort', value: session.effort ?? '—' },
            { key: 'Permission mode', value: session.metrics?.permissionMode ?? '—' },
            { key: 'Mode', value: session.metrics?.mode ?? '—' },
            { key: 'Git branch', value: session.gitBranch ?? '—' },
            { key: 'CLI version', value: session.cliVersion ?? '—' },
            { key: 'Context', value: this.hasContext(session) ? `${this.contextLabel(session)} (${this.contextPercent(session)})` : '—' },
            { key: 'Turns', value: `${session.turns} (${session.assistantTurns} assistant)` },
            { key: 'Tool calls', value: String(session.toolCalls) },
            { key: 'Compactions', value: String(session.compactions) },
            { key: 'Subagents', value: String(session.subagentCount) },
            { key: 'Transcript', value: session.transcriptPath },
            { key: 'Transcript size', value: this.formatBytes(session.transcriptBytes) },
            { key: 'Started', value: this.ago(session.startedAt) },
            { key: 'Last activity', value: this.ago(session.lastActivityAt) },
        ]
        if (session.lastError) {
            rows.push({ key: 'Last error', value: session.lastError })
        }
        return rows
    }

    private formatBytes (bytes: number): string {
        if (!bytes) {
            return '—'
        }
        if (bytes < 1024 * 1024) {
            return `${Math.round(bytes / 1024)} KB`
        }
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    copyDetail (value: string): void {
        this.platform.setClipboard({ text: value })
    }

    retry (): void {
        this.stith.refreshNow()
    }
}
