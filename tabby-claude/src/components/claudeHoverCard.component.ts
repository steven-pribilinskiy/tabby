import { Component, Input } from '@angular/core'
import { BaseTabComponent, ConfigService } from 'tabby-core'

import { ClaudeSession } from '../api'
import { formatTokens, permissionBadge, relativeTime, sessionKind, sessionTitle, statusLabel } from '../format'
import { ClaudeSessionsService } from '../services/claudeSessions.service'

/**
 * The card shown when a tab header running a Claude session is hovered.
 *
 * Deliberately a summary, not a second panel: what the session is, what it is
 * doing right now, and how full its context is. It reads from the already-
 * polled registry rather than fetching, so opening it costs nothing.
 */
@Component({
    selector: 'claude-hover-card',
    templateUrl: './claudeHoverCard.component.pug',
    styleUrls: ['./claudeHoverCard.component.scss'],
})
export class ClaudeHoverCardComponent {
    @Input() tab: BaseTabComponent

    session: ClaudeSession | null = null

    /**
     * Fixed when the card opens. A card lives for as long as a hover, so it
     * never needs to tick — and a value read from the clock during change
     * detection would differ between Angular's check and verify passes.
     */
    now = Date.now()

    formatTokens = formatTokens
    relativeTime = relativeTime
    sessionKind = sessionKind
    sessionTitle = sessionTitle
    statusLabel = statusLabel
    permissionBadge = permissionBadge

    constructor (
        public config: ConfigService,
        private claude: ClaudeSessionsService,
    ) { }

    ngOnInit (): void {
        this.session = this.claude.forTab(this.tab)
        this.now = Date.now()
    }

    ago (timestamp: number | null | undefined): string {
        return relativeTime(timestamp, this.now)
    }

    get options (): any {
        return this.config.store.claude.hover
    }

    hasContext (session: ClaudeSession): boolean {
        return session.metrics?.contextFraction !== undefined
    }

    contextLabel (session: ClaudeSession): string {
        return `${formatTokens(session.metrics?.contextTokens)} / ${formatTokens(session.metrics?.contextLimit)}`
    }

    contextWidth (session: ClaudeSession): string {
        return `${Math.round((session.metrics?.contextFraction ?? 0) * 100)}%`
    }

    contextPercent (session: ClaudeSession): string {
        const fraction = session.metrics?.contextFraction
        return fraction === undefined ? '—' : `${Math.round(fraction * 100)}%`
    }

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

    lastPrompt (session: ClaudeSession): string {
        return session.metrics?.lastPrompt ?? ''
    }

    waitingMessage (session: ClaudeSession): string {
        return session.waitingMessage ?? ''
    }
}
