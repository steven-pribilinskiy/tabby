import { Component } from '@angular/core'
import { AppService, BaseComponent, ConfigService, PlatformService } from 'tabby-core'

import { ClaudeBookmarkLink, ClaudeSession, ClaudeUsage, StithHealth } from '../api'
import { formatTokens, permissionBadge, relativeTime, sessionKind, sessionTitle, statusLabel } from '../format'
import { ClaudeSessionsService } from '../services/claudeSessions.service'
import { StithService } from '../services/stith.service'

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

    // Exposed for the template; pug cannot import.
    formatTokens = formatTokens
    relativeTime = relativeTime
    sessionKind = sessionKind
    sessionTitle = sessionTitle
    statusLabel = statusLabel
    permissionBadge = permissionBadge

    private watchHandle: { close: () => void } | null = null

    constructor (
        public config: ConfigService,
        private claude: ClaudeSessionsService,
        private stith: StithService,
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
        })
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
    }

    get options (): any {
        return this.config.store.claude.panel
    }

    get waitingSessions (): ClaudeSession[] {
        return this.sessions.filter(x => x.waitingOnPermission || x.awaitingInput)
    }

    get otherSessions (): ClaudeSession[] {
        const active = this.activeSession
        return [...this.sessions]
            .filter(x => x.sessionId !== active?.sessionId)
            .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
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

    /** Click a session to jump to its tab; falls back to opening it in stith. */
    selectSession (session: ClaudeSession): void {
        if (!this.claude.revealTab(session)) {
            this.openInStith(session)
        }
    }

    openInStith (session: ClaudeSession): void {
        this.platform.openExternal(`${this.stith.baseURL}/s/${session.sessionId}`)
    }

    retry (): void {
        this.stith.refreshNow()
    }
}
