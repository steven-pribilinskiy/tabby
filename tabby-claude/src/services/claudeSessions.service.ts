import { Injectable, NgZone } from '@angular/core'
import { Observable, BehaviorSubject } from 'rxjs'
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent } from 'tabby-core'

import { ClaudeSession } from '../api'
import { StithService } from './stith.service'
import { TranscriptMetricsService } from './transcriptMetrics.service'

/** How often the tab↔session mapping is rebuilt when nothing forces it. */
const TAB_MAP_INTERVAL_MS = 5000

/**
 * Joins the stith session registry to Tabby's tabs, and enriches each session
 * with locally-computed transcript metrics.
 *
 * The join key is the working directory. PIDs cannot be used: a Claude session
 * running inside WSL reports Linux PIDs, which can never match the Windows
 * conpty PIDs Tabby knows about. The shell's directory, by contrast, is
 * reported over OSC 7 by both, and is stable for the lifetime of a session
 * because Claude runs as a child of the shell and never changes the shell's
 * own directory.
 *
 * Where a directory maps to more than one tab or more than one session, no link
 * is made at all rather than guessing — a hover card on the wrong tab is worse
 * than no hover card.
 */
@Injectable({ providedIn: 'root' })
export class ClaudeSessionsService {
    get sessions$ (): Observable<ClaudeSession[]> { return this.sessions }

    private sessions = new BehaviorSubject<ClaudeSession[]>([])
    private byTab = new Map<BaseTabComponent, ClaudeSession>()
    private watchHandle: { close: () => void } | null = null
    private watchers = 0
    private lastSignature = ''
    private tabMapBuiltAt = 0
    private tabMapDirty = true

    constructor (
        private stith: StithService,
        private metrics: TranscriptMetricsService,
        private app: AppService,
        private config: ConfigService,
        private zone: NgZone,
    ) {
        this.stith.sessions$.subscribe(sessions => {
            void this.onSessions(sessions)
        })
        // A tab opening, closing or being split invalidates the mapping
        // immediately; otherwise it would be up to a whole interval out of date
        // and a brand-new tab would show no hover card.
        this.app.tabsChanged$.subscribe(() => {
            this.tabMapDirty = true
        })
    }

    /** Ref-counted; polling only runs while a surface is watching. */
    watch (): { close: () => void } {
        this.watchers++
        if (this.watchers === 1) {
            this.watchHandle = this.stith.watch()
        }
        let closed = false
        return {
            close: () => {
                if (closed) {
                    return
                }
                closed = true
                this.watchers--
                if (this.watchers === 0) {
                    this.watchHandle?.close()
                    this.watchHandle = null
                }
            },
        }
    }

    get currentSessions (): ClaudeSession[] {
        return this.sessions.value
    }

    /**
     * The Claude session running in a tab, if we could match one. Cheap enough
     * to call from a hover handler — it is a map lookup.
     */
    forTab (tab: BaseTabComponent): ClaudeSession | null {
        const found = this.byTab.get(tab)
        if (found) {
            return found
        }
        // A split tab is a container; report a session if exactly one of its
        // panes has one, so hovering the header of a split still says something.
        if (tab instanceof SplitTabComponent) {
            const matches = tab.getAllTabs()
                .map(x => this.byTab.get(x))
                .filter((x): x is ClaudeSession => !!x)
            const unique = new Map(matches.map(x => [x.sessionId, x]))
            if (unique.size === 1) {
                return [...unique.values()][0]
            }
        }
        return null
    }

    /**
     * What the panel should show: the session belonging to the focused tab,
     * falling back to the most recently active session so the panel is never
     * empty just because the user is looking at a plain shell.
     */
    get focusedSession (): ClaudeSession | null {
        const active = this.app.activeTab
        if (active) {
            const forActive = this.forTab(active)
            if (forActive) {
                return forActive
            }
        }
        const all = this.sessions.value
        if (!all.length) {
            return null
        }
        return [...all].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0]
    }

    /** Focus the Tabby tab running a session, if it is in this window. */
    revealTab (session: ClaudeSession): boolean {
        for (const [tab, candidate] of this.byTab) {
            if (candidate.sessionId === session.sessionId) {
                const parent = tab.parent
                this.app.selectTab(parent instanceof SplitTabComponent ? parent : tab)
                if (parent instanceof SplitTabComponent) {
                    parent.focus(tab)
                }
                return true
            }
        }
        return false
    }

    private async onSessions (sessions: ClaudeSession[]): Promise<void> {
        if (this.config.store.claude.readTranscripts) {
            // Enrich in parallel; each read is a throttled stat plus at most a
            // 256KB bounded read, and unreadable transcripts resolve to {}.
            await Promise.all(sessions.map(async session => {
                session.metrics = await this.metrics.read(session)
            }))
        }
        await this.rebuildTabMap(sessions)

        // Only wake Angular when something a surface actually renders has
        // changed. Without this the panel would force a change-detection pass
        // every poll — twice a second, forever, for a window nobody is looking
        // at — which is exactly the kind of ambient cost that shows up later as
        // "Tabby feels slow".
        const signature = this.renderSignature(sessions)
        if (signature === this.lastSignature) {
            this.sessions.next(sessions)
            return
        }
        this.lastSignature = signature
        this.zone.run(() => this.sessions.next(sessions))
    }

    /**
     * Everything the panel and hover card draw, and nothing else. Notably
     * excludes `lastActivityAt`, which ticks on every poll for a live session
     * and would make the check always fail — the relative timestamps it feeds
     * are re-rendered by the next genuine change anyway.
     */
    private renderSignature (sessions: ClaudeSession[]): string {
        return sessions.map(x => [
            x.sessionId,
            x.status,
            x.currentTool,
            x.waitingOnPermission,
            x.awaitingInput,
            x.waitingMessage,
            x.compacting,
            x.subagentCount,
            x.turns,
            x.toolCalls,
            x.compactions,
            x.model,
            x.effort,
            x.gitBranch,
            x.lastError,
            x.metrics?.contextTokens,
            x.metrics?.mode,
            x.metrics?.permissionMode,
            x.metrics?.aiTitle,
            x.metrics?.lastPrompt,
            x.metrics?.queuedPrompts?.length,
        ].join('')).join('')
    }

    private async rebuildTabMap (sessions: ClaudeSession[]): Promise<void> {
        // Resolving a tab's directory can cost a native call per tab, so it is
        // not redone on every poll. Tab membership changing forces it; short of
        // that a launch directory does not move, so a slow refresh is enough.
        const now = Date.now()
        if (!this.tabMapDirty && now - this.tabMapBuiltAt < TAB_MAP_INTERVAL_MS) {
            return
        }
        this.tabMapDirty = false
        this.tabMapBuiltAt = now

        const tabs = this.collectTerminalTabs()

        // Resolve every tab's directory once. getWorkingDirectory() is async
        // and may shell out for a Windows shell that reports nothing, so it is
        // never called from a render path.
        const tabCwds = new Map<BaseTabComponent, string>()
        await Promise.all(tabs.map(async tab => {
            try {
                const cwd = await (tab as any).session?.getWorkingDirectory?.()
                if (cwd) {
                    tabCwds.set(tab, this.normalize(cwd))
                }
            } catch {
                // A closing tab, or a session that cannot report — skip it.
            }
        }))

        const sessionsByCwd = new Map<string, ClaudeSession[]>()
        for (const session of sessions) {
            const key = this.normalize(session.cwd)
            if (!key) {
                continue
            }
            const list = sessionsByCwd.get(key) ?? []
            list.push(session)
            sessionsByCwd.set(key, list)
        }

        const tabsByCwd = new Map<string, BaseTabComponent[]>()
        for (const [tab, cwd] of tabCwds) {
            const list = tabsByCwd.get(cwd) ?? []
            list.push(tab)
            tabsByCwd.set(cwd, list)
        }

        const next = new Map<BaseTabComponent, ClaudeSession>()
        for (const [cwd, candidates] of sessionsByCwd) {
            const tabsHere = tabsByCwd.get(cwd)
            // Only an unambiguous 1:1 pairing is trusted.
            if (tabsHere?.length === 1 && candidates.length === 1) {
                next.set(tabsHere[0], candidates[0])
            }
        }
        this.byTab = next
    }

    private collectTerminalTabs (): BaseTabComponent[] {
        const out: BaseTabComponent[] = []
        for (const tab of this.app.tabs) {
            if (tab instanceof SplitTabComponent) {
                out.push(...tab.getAllTabs())
            } else {
                out.push(tab)
            }
        }
        return out.filter(tab => !!(tab as any).session)
    }

    /**
     * Case-fold and unify separators so a Windows shell reporting
     * `C:\Users\steve\projects` matches stith's `C:\\Users\\steve\\projects`,
     * and a trailing separator never splits a pair.
     */
    private normalize (path: string): string {
        if (!path) {
            return ''
        }
        return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }
}
