import { ClaudeSession } from './api'

/** Coarse state used to colour a session everywhere it is shown. */
export type SessionKind = 'waiting' | 'working' | 'error' | 'idle'

export function sessionKind (session: ClaudeSession): SessionKind {
    if (session.lastError) {
        return 'error'
    }
    if (session.waitingOnPermission || session.awaitingInput) {
        return 'waiting'
    }
    if (session.compacting || !!session.currentTool || session.status === 'active') {
        return 'working'
    }
    return 'idle'
}

export function statusLabel (session: ClaudeSession): string {
    if (session.lastError) {
        return 'Error'
    }
    if (session.waitingOnPermission) {
        return 'Needs permission'
    }
    if (session.awaitingInput) {
        return 'Waiting for you'
    }
    if (session.compacting) {
        return 'Compacting'
    }
    if (session.currentTool) {
        return session.currentTool
    }
    return session.status === 'active' ? 'Active' : 'Idle'
}

/** `130797` → `131k`; small numbers stay exact. */
export function formatTokens (n: number | undefined): string {
    if (n === undefined) {
        return '—'
    }
    if (n < 1000) {
        return String(n)
    }
    if (n < 1_000_000) {
        return `${Math.round(n / 1000)}k`
    }
    return `${(n / 1_000_000).toFixed(2)}M`
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 1000],
    ['minute', 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
]

/**
 * `1786303175122` → `2 minutes ago`. Uses the platform's own relative-time
 * formatter, so it is localised without pulling in a date library — Tabby has
 * none, and one row of text does not justify adding one.
 */
export function relativeTime (timestamp: number | null | undefined): string {
    if (!timestamp) {
        return '—'
    }
    const delta = timestamp - Date.now()
    const magnitude = Math.abs(delta)
    let unit: Intl.RelativeTimeFormatUnit = 'second'
    let divisor = 1000
    for (const [candidate, size] of RELATIVE_UNITS) {
        if (magnitude >= size) {
            unit = candidate
            divisor = size
        }
    }
    try {
        return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
            .format(Math.round(delta / divisor), unit)
    } catch {
        return ''
    }
}

/**
 * Display name for a session, in decreasing order of specificity. Empty
 * strings are skipped as well as nulls — stith reports an unnamed session as
 * `null`, but a transcript can carry an empty `aiTitle`.
 */
export function sessionTitle (session: ClaudeSession): string {
    const candidates = [session.name, session.metrics?.aiTitle, session.projectName]
    for (const candidate of candidates) {
        if (candidate) {
            return candidate
        }
    }
    return session.sessionId.slice(0, 8)
}

/**
 * Permission modes worth calling out. `default` is the norm and saying so
 * would just be noise, so it is omitted.
 */
export function permissionBadge (session: ClaudeSession): string | null {
    const mode = session.metrics?.permissionMode
    switch (mode) {
        case 'bypassPermissions': return 'bypass'
        case 'acceptEdits': return 'auto-edit'
        case 'plan': return 'plan'
        default: return null
    }
}
