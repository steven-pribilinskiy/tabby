/**
 * A Claude Code session as Tabby sees it.
 *
 * Two sources are merged into this shape:
 *
 *  - **stith** (`https://stith.lvh.me/api/agents`) is authoritative for session
 *    identity and liveness. It already tracks Windows, WSL and remote machines
 *    in one registry, which is the hard half of the problem — a terminal
 *    running Claude inside WSL reports Linux PIDs that can never be matched
 *    against Tabby's Windows conpty PIDs.
 *  - **The transcript JSONL** supplies what stith does not compute: context
 *    window consumption, the current mode / permission mode, the AI-assigned
 *    title, and queued prompts. It is read locally, so these survive stith
 *    being unreachable.
 */
export interface ClaudeSession {
    sessionId: string

    // ── Identity (stith) ─────────────────────────────────────────────
    cwd: string
    projectName: string
    /** User-assigned name, if any. Falls back to `aiTitle` then `projectName`. */
    name: string | null
    transcriptPath: string
    /** 'Ubuntu' for a WSL session, null for a native Windows one. */
    wslDistro: string | null
    /** Human-readable environment, e.g. 'Windows' or 'WSL: Ubuntu'. */
    envLabel: string
    machine: string
    isRemote: boolean

    // ── Liveness (stith) ─────────────────────────────────────────────
    status: string
    /** Tool currently executing, if the session is mid-turn. */
    currentTool: string | null
    waitingOnPermission: boolean
    awaitingInput: boolean
    /** The question being asked, when waiting. */
    waitingMessage: string | null
    waitingSince: number | null
    compacting: boolean
    subagentCount: number
    lastError: string | null
    startedAt: number
    lastActivityAt: number

    // ── Cumulative counters (stith) ──────────────────────────────────
    model: string | null
    effort: string | null
    cliVersion: string | null
    gitBranch: string | null
    turns: number
    assistantTurns: number
    toolCalls: number
    compactions: number
    transcriptBytes: number

    /** Saved notes and links, when the session has been bookmarked in stith. */
    bookmark?: ClaudeBookmark | null

    // ── Local transcript enrichment ──────────────────────────────────
    metrics?: TranscriptMetrics
}

/** A reference attached to a bookmark. Only `link` targets are openable. */
export interface ClaudeBookmarkLink {
    kind: 'link' | 'file' | 'branch' | string
    label?: string
    target: string
}

export interface ClaudeBookmark {
    description?: string
    tags?: string[]
    links?: ClaudeBookmarkLink[]
    bookmarkCount?: number
    resumeCount?: number
    savedAt?: string
    updatedAt?: string
}

/**
 * Everything derived from reading the tail of a session's transcript. All
 * fields are optional: a transcript on an unreachable machine, or one that has
 * not produced an assistant turn yet, yields an empty object rather than an
 * error.
 */
export interface TranscriptMetrics {
    /** Tokens occupying the context window as of the last assistant turn. */
    contextTokens?: number
    /** Detected window size — 200k, or 1M once we observe more than 200k in use. */
    contextLimit?: number
    /** `contextTokens / contextLimit`, 0..1. */
    contextFraction?: number
    /** Output tokens produced by the last assistant turn. */
    lastOutputTokens?: number
    /** Title Claude assigned to the session. */
    aiTitle?: string
    /** 'normal' | 'plan' | … as reported by the CLI. */
    mode?: string
    /** 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | … */
    permissionMode?: string
    /** Most recent user prompt (the CLI truncates this itself). */
    lastPrompt?: string
    /** Prompts typed while Claude was busy and not yet consumed. */
    queuedPrompts?: string[]
    /** Tokens dropped by the most recent compaction, when there was one. */
    lastCompactionDropped?: number
    /** mtime of the transcript when these were computed. */
    readAt?: number
}

/**
 * A plan usage window as stith reports it. stith already renders the
 * human-facing strings (`resetsIn`, `resetsLocal`) in the user's locale and
 * timezone, so they are passed straight through rather than recomputed here.
 */
export interface ClaudeUsageWindow {
    /** Percent of the window consumed, 0-100. */
    pct: number
    /** Pre-formatted relative reset, e.g. 'in 1h 15m'. */
    resetsIn?: string
    /** Pre-formatted absolute reset in local time. */
    resetsLocal?: string
    /** Whether this window is the one currently being drawn down. */
    active?: boolean
}

export interface ClaudeUsage {
    account: string
    plan: string
    /** The rolling 5-hour window. */
    session?: ClaudeUsageWindow
    weekly?: ClaudeUsageWindow
}

/** Reachability of the stith backend, surfaced so the panel can say so. */
export type StithHealth = 'ok' | 'unreachable' | 'never-tried'
