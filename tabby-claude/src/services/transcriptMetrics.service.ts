import * as fs from 'fs'
import { Injectable } from '@angular/core'

import { ClaudeSession, TranscriptMetrics } from '../api'

/** How much of the transcript tail to read. */
const TAIL_BYTES = 256 * 1024

/** Floor on how often a given transcript is re-stat'd. */
const STAT_INTERVAL_MS = 4000

/**
 * Context window sizes. Claude Code does not record the window size in the
 * transcript, so it is inferred: anything that has fitted more than the small
 * window must be running the large one.
 */
const SMALL_CONTEXT = 200_000
const LARGE_CONTEXT = 1_000_000

/**
 * Derives per-session numbers from the tail of a Claude Code transcript.
 *
 * This covers what stith does not compute — above all the context-window
 * percentage, which is the headline number on the statusline. Reading happens
 * locally, so these keep working when stith is unreachable.
 *
 * Transcripts reach tens of megabytes (16MB for a single long session), so the
 * file is never read whole: a bounded window off the end is enough, because
 * every field of interest is a "latest wins" observation. Results are cached
 * against size+mtime so an idle session costs one `stat` per refresh.
 */
@Injectable({ providedIn: 'root' })
export class TranscriptMetricsService {
    private cache = new Map<string, { key: string, value: TranscriptMetrics, checkedAt: number }>()

    /**
     * Translate a transcript path into something this Windows process can open.
     * A WSL session reports a Linux path, which is reachable over the
     * `\\wsl.localhost\<distro>` share without shelling out to `wsl.exe`.
     * Returns null when the session lives on another machine entirely.
     */
    resolvePath (session: ClaudeSession): string | null {
        const raw = session.transcriptPath
        if (!raw) {
            return null
        }
        if (session.isRemote) {
            // Another machine's filesystem — stith is the only view we have.
            return null
        }
        if (/^[a-zA-Z]:[\\/]/.test(raw)) {
            return raw
        }
        if (raw.startsWith('/')) {
            const distro = session.wslDistro ?? this.distroFromEnvLabel(session.envLabel)
            if (!distro) {
                return null
            }
            return `\\\\wsl.localhost\\${distro}${raw.replace(/\//g, '\\')}`
        }
        return raw
    }

    /** `WSL: Ubuntu` → `Ubuntu`. */
    private distroFromEnvLabel (label: string): string | null {
        const match = /^WSL:\s*(.+)$/.exec(label)
        return match ? match[1].trim() : null
    }

    /**
     * Read metrics for a session. Never throws: an unreadable transcript
     * (permissions, a stopped distro, a deleted file) yields an empty object,
     * because a missing context percentage must not blank out the rest of the
     * panel.
     */
    async read (session: ClaudeSession): Promise<TranscriptMetrics> {
        const path = this.resolvePath(session)
        if (!path) {
            return {}
        }

        const cached = this.cache.get(path)
        // A WSL transcript is stat'd across the `\\wsl.localhost` share, which
        // is far from free. The session list refreshes every couple of seconds
        // and context usage moves on the scale of a turn, so re-checking that
        // often buys nothing — serve the cache until the floor has passed.
        const now = Date.now()
        if (cached && now - cached.checkedAt < STAT_INTERVAL_MS) {
            return cached.value
        }

        let stat: fs.Stats | null = null
        try {
            stat = await fs.promises.stat(path)
        } catch {
            return {}
        }

        const key = `${stat.size}:${stat.mtimeMs}`
        if (cached?.key === key) {
            cached.checkedAt = now
            return cached.value
        }

        let buffer = ''
        try {
            buffer = await this.readTail(path, stat.size)
        } catch {
            return {}
        }

        const value = this.parse(buffer)
        value.readAt = stat.mtimeMs
        this.cache.set(path, { key, value, checkedAt: now })
        return value
    }

    private async readTail (path: string, size: number): Promise<string> {
        if (size <= TAIL_BYTES) {
            return fs.promises.readFile(path, 'utf-8')
        }
        const handle = await fs.promises.open(path, 'r')
        try {
            const chunk = Buffer.alloc(TAIL_BYTES)
            const { bytesRead } = await handle.read(chunk, 0, TAIL_BYTES, size - TAIL_BYTES)
            const slice = chunk.subarray(0, bytesRead)
            // Cut at the first newline at the *byte* level. Decoding a window
            // that starts mid-way through a multi-byte character would prepend
            // a replacement char and corrupt that line; dropping the partial
            // first line avoids both problems at once.
            const newline = slice.indexOf(0x0a)
            return slice.subarray(newline >= 0 ? newline + 1 : 0).toString('utf-8')
        } finally {
            await handle.close()
        }
    }

    /**
     * Walk the tail newest-first, taking the first occurrence of each field.
     * Queued prompts are the exception: they are an event log, so they are
     * replayed oldest-first instead.
     */
    private parse (buffer: string): TranscriptMetrics {
        const lines = buffer.split('\n')
        const out: TranscriptMetrics = {}
        const queued: string[] = []

        // Oldest-first pass, only for the queue. A `remove` always follows its
        // `add`, so an unmatched `remove` simply refers to an entry that was
        // added before this window — dropping it is correct.
        for (const line of lines) {
            if (!line.includes('"queue-operation"')) {
                continue
            }
            try {
                const entry = JSON.parse(line)
                if (entry.type !== 'queue-operation' || typeof entry.content !== 'string') {
                    continue
                }
                if (entry.operation === 'add') {
                    queued.push(entry.content)
                } else if (entry.operation === 'remove') {
                    const at = queued.indexOf(entry.content)
                    if (at !== -1) {
                        queued.splice(at, 1)
                    }
                }
            } catch {
                // Truncated or malformed line — keep going.
            }
        }
        if (queued.length) {
            out.queuedPrompts = queued
        }

        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i]
            if (!line) {
                continue
            }
            let entry: any = null
            try {
                entry = JSON.parse(line)
            } catch {
                continue
            }

            switch (entry.type) {
                case 'assistant':
                    if (out.contextTokens === undefined) {
                        const usage = entry.message?.usage
                        if (usage) {
                            const context =
                                (usage.input_tokens ?? 0) +
                                (usage.cache_read_input_tokens ?? 0) +
                                (usage.cache_creation_input_tokens ?? 0) +
                                (usage.output_tokens ?? 0)
                            if (context > 0) {
                                out.contextTokens = context
                                out.lastOutputTokens = usage.output_tokens ?? 0
                            }
                        }
                    }
                    break
                case 'ai-title':
                    out.aiTitle ??= entry.aiTitle
                    break
                case 'mode':
                    out.mode ??= entry.mode
                    break
                case 'permission-mode':
                    out.permissionMode ??= entry.permissionMode
                    break
                case 'last-prompt':
                    out.lastPrompt ??= entry.lastPrompt
                    break
                case 'system':
                    if (entry.subtype === 'compact_boundary' && out.lastCompactionDropped === undefined) {
                        out.lastCompactionDropped = entry.compactMetadata?.cumulativeDroppedTokens
                        // A compaction that started from more than the small
                        // window proves the large one is in play, even if the
                        // current context has since dropped below it.
                        const pre = entry.compactMetadata?.preTokens ?? 0
                        if (pre > SMALL_CONTEXT) {
                            out.contextLimit = LARGE_CONTEXT
                        }
                    }
                    break
            }
        }

        if (out.contextTokens !== undefined) {
            out.contextLimit ??= out.contextTokens > SMALL_CONTEXT ? LARGE_CONTEXT : SMALL_CONTEXT
            out.contextFraction = Math.min(1, out.contextTokens / out.contextLimit)
        }

        return out
    }
}
