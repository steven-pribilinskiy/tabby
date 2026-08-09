import { Injectable, NgZone } from '@angular/core'
import { Observable, BehaviorSubject } from 'rxjs'
import { ConfigService, LogService, Logger } from 'tabby-core'

import { ClaudeSession, ClaudeUsage, StithHealth } from '../api'

/**
 * Read-only client for the stith session registry.
 *
 * stith already aggregates every Claude Code session on this machine — Windows,
 * WSL and remote — into one registry, so Tabby consumes it rather than
 * re-deriving session discovery from process trees. Everything here is a GET;
 * this service never mutates stith state.
 *
 * Polling is deliberately adaptive. The panel is a permanently-visible piece of
 * chrome, so a fixed fast interval would mean thousands of requests over a work
 * day for a window the user is not looking at. Instead the interval backs off
 * when the panel is hidden or the window is unfocused, and requests are
 * single-flighted so a slow response can never stack up a queue behind it.
 */
@Injectable({ providedIn: 'root' })
export class StithService {
    get sessions$ (): Observable<ClaudeSession[]> { return this.sessions }
    get usage$ (): Observable<ClaudeUsage[]> { return this.usage }
    get health$ (): Observable<StithHealth> { return this.health }

    /** Last successfully fetched sessions, for synchronous reads on hover. */
    get currentSessions (): ClaudeSession[] { return this.sessions.value }
    get currentHealth (): StithHealth { return this.health.value }

    private sessions = new BehaviorSubject<ClaudeSession[]>([])
    private usage = new BehaviorSubject<ClaudeUsage[]>([])
    private health = new BehaviorSubject<StithHealth>('never-tried')

    private timer: ReturnType<typeof setTimeout> | null = null
    private inFlight = false
    private usageFetchedAt = 0
    private subscribers = 0
    private logger: Logger

    /**
     * Consecutive failures. Used to back off rather than hammering a service
     * that is down — stith lives in WSL, which may simply not be running.
     */
    private failures = 0

    constructor (
        private config: ConfigService,
        private zone: NgZone,
        log: LogService,
    ) {
        this.logger = log.create('claude-stith')
    }

    /**
     * Ref-counted start. Every surface that needs live data calls this and
     * disposes the returned handle; polling stops entirely once nothing is
     * watching, so a user who hides the panel pays nothing.
     */
    watch (): { close: () => void } {
        this.subscribers++
        if (this.subscribers === 1) {
            this.schedule(0)
        }
        let closed = false
        return {
            close: () => {
                if (closed) {
                    return
                }
                closed = true
                this.subscribers--
                if (this.subscribers === 0 && this.timer) {
                    clearTimeout(this.timer)
                    this.timer = null
                }
            },
        }
    }

    /**
     * The full record for one session, fetched on demand.
     *
     * The list endpoint is what the panel polls; this is for the details view,
     * where it is worth paying for a round trip to show the freshest values
     * and any fields the list omits. Returns null when stith is unreachable so
     * the caller can fall back to the polled copy.
     */
    async getSession (sessionId: string): Promise<ClaudeSession | null> {
        try {
            const raw = await this.get<any>(`/api/agents/${encodeURIComponent(sessionId)}`)
            return raw ? this.toSession(raw) : null
        } catch {
            return null
        }
    }

    /** Force an immediate refresh, e.g. after the user clicks Retry. */
    refreshNow (): void {
        this.failures = 0
        this.schedule(0)
    }

    get baseURL (): string {
        const configured = this.config.store.claude?.stithURL
        return String(configured || 'https://stith.lvh.me').replace(/\/+$/, '')
    }

    private schedule (delay: number): void {
        if (this.timer) {
            clearTimeout(this.timer)
        }
        // Outside Angular: a background poll must not schedule a change
        // detection pass on every tick. Only the health and usage subjects
        // re-enter the zone here; sessions are published outside it and the
        // consumer decides when a render is warranted.
        this.zone.runOutsideAngular(() => {
            this.timer = setTimeout(() => void this.tick(), delay)
        })
    }

    private get pollInterval (): number {
        const cfg = this.config.store.claude ?? {}
        if (this.failures > 0) {
            // Exponential backoff, capped — a down service should cost ~nothing.
            return Math.min(60000, 2000 * 2 ** Math.min(this.failures, 5))
        }
        if (typeof document !== 'undefined' && document.hidden) {
            return Math.max(cfg.pollIntervalMs ?? 2000, 15000)
        }
        if (typeof document !== 'undefined' && !document.hasFocus()) {
            return Math.max(cfg.pollIntervalMs ?? 2000, 6000)
        }
        return cfg.pollIntervalMs ?? 2000
    }

    private async tick (): Promise<void> {
        if (this.inFlight || this.subscribers === 0) {
            return
        }
        this.inFlight = true
        try {
            const agents = await this.get<{ agents?: any[] }>('/api/agents')
            const sessions = (agents?.agents ?? []).map(x => this.toSession(x))
            this.publish(sessions)

            // Usage moves on a multi-minute scale; polling it at the session
            // rate would be pure waste.
            if (Date.now() - this.usageFetchedAt > (this.config.store.claude?.usageIntervalMs ?? 60000)) {
                // `accounts` is optional in the type on purpose: stith is a
                // separate service that can be upgraded independently, so a
                // response missing the field must degrade, not throw.
                const usage = await this.get<{ accounts?: any[] }>('/api/usage')
                if (usage) {
                    this.usageFetchedAt = Date.now()
                    this.zone.run(() => this.usage.next(this.toUsage(usage.accounts ?? [])))
                }
            }

            this.failures = 0
            if (this.health.value !== 'ok') {
                this.zone.run(() => this.health.next('ok'))
            }
        } catch (err) {
            this.failures++
            if (this.health.value !== 'unreachable') {
                this.logger.info('stith unreachable:', String(err))
                this.zone.run(() => this.health.next('unreachable'))
            }
        } finally {
            this.inFlight = false
            if (this.subscribers > 0) {
                this.schedule(this.pollInterval)
            }
        }
    }

    /**
     * Emits outside the Angular zone on purpose. Deciding whether a poll is
     * worth a change-detection pass needs the locally-derived metrics too, so
     * that call belongs to whoever merges them — see ClaudeSessionsService.
     * Waking Angular here as well would run the pass twice.
     */
    private publish (sessions: ClaudeSession[]): void {
        this.sessions.next(sessions)
    }

    private async get<T> (path: string): Promise<T | null> {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.config.store.claude?.requestTimeoutMs ?? 3000)
        try {
            const response = await fetch(this.baseURL + path, {
                signal: controller.signal,
                headers: { accept: 'application/json' },
            })
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`)
            }
            const type = response.headers.get('content-type') ?? ''
            if (!type.includes('json')) {
                // stith serves its SPA as a catch-all, so a wrong path comes
                // back as 200 text/html. Treating that as data would silently
                // produce an empty session list forever.
                throw new Error(`expected JSON, got ${type || 'nothing'}`)
            }
            return await response.json() as T
        } finally {
            clearTimeout(timeout)
        }
    }

    private toSession (a: any): ClaudeSession {
        return {
            sessionId: String(a.sessionId ?? ''),
            cwd: String(a.cwd ?? ''),
            projectName: String(a.projectName ?? ''),
            name: a.name ?? null,
            transcriptPath: String(a.transcriptPath ?? ''),
            wslDistro: a.wslDistro ?? null,
            envLabel: String(a.envLabel ?? a.env ?? ''),
            machine: String(a.machine ?? ''),
            isRemote: !!a.isRemote,
            status: String(a.status ?? 'unknown'),
            currentTool: a.currentTool ?? null,
            waitingOnPermission: !!a.waitingOnPermission,
            awaitingInput: !!a.awaitingInput,
            waitingMessage: a.waitingMessage ?? null,
            waitingSince: a.waitingSince ?? null,
            compacting: !!a.compacting,
            subagentCount: a.subagentCount ?? 0,
            lastError: a.lastError ?? null,
            startedAt: a.startedAt ?? 0,
            lastActivityAt: a.lastActivityAt ?? 0,
            model: a.model ?? null,
            effort: a.effort ?? null,
            cliVersion: a.cliVersion ?? null,
            gitBranch: a.gitBranch ?? null,
            turns: a.turns ?? 0,
            assistantTurns: a.assistantTurns ?? 0,
            toolCalls: a.toolCalls ?? 0,
            compactions: a.compactions ?? 0,
            transcriptBytes: a.transcriptBytes ?? 0,
            bookmark: a.bookmark ?? null,
        }
    }

    private toUsage (accounts: any[]): ClaudeUsage[] {
        return accounts
            .filter(a => !a.inactive && !a.disabled)
            .map(a => ({
                account: String(a.account ?? a.email ?? ''),
                plan: String(a.plan ?? ''),
                session: a.session ?? undefined,
                weekly: a.weekly ?? undefined,
            }))
    }
}
