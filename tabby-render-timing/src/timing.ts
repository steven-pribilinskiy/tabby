/**
 * Frame cadence and terminal write latency.
 *
 * `app/lib/diagnostics.ts` records what blocks the event loop. That misses the
 * other way a terminal feels slow: the loop stays free, nothing blocks, and the
 * screen still lags — because the renderer is behind, or because xterm is taking
 * a long time to parse and lay out what was written to it.
 *
 * Nothing here logs an event per write. A busy terminal writes thousands of
 * times a second, and the thing worth knowing is a distribution, not a stream.
 * Everything is tallied and reported as a summary, on the same principle as the
 * stall recorder: the tally is the point, not any single slow call.
 */

/** The diagnostics API the app publishes, when it is there at all. */
interface DiagnosticsApi {
    /** Emits a record of its own. `note` would only leave a breadcrumb, which
     *  is invisible unless a stall happens to be reported afterwards. */
    report: (kind: string, detail: Record<string, unknown>) => void
}

/** The part of an xterm Terminal this needs — anything else is the tab's business. */
export interface WritableTerminal {
    write: (data: string | Uint8Array, callback?: () => void) => void
}

function diagnostics (): DiagnosticsApi | null {
    // Absent under tabby-web, where none of this exists. Looked up rather than
    // imported: plugins are separate bundles and cannot reach the app bundle.
    // `window`, not `globalThis` — this only ever runs in a renderer, and they
    // are the same object there.
    return (window as any).__tabbyDiagnostics ?? null
}

/** A frame longer than this missed a 30fps deadline. */
const SLOW_FRAME_MS = 33
/** And this one is long enough to be seen as a hitch rather than a slow frame. */
const JANK_FRAME_MS = 100
/** A single write taking this long is worth naming on its own. */
const SLOW_WRITE_MS = 50
/** How often a summary may be emitted, when there is anything to say. */
const REPORT_EVERY_MS = 60_000
/** Gaps longer than this are the tab being idle, not a dropped frame. */
const IDLE_GAP_MS = 500

function percentile (sorted: number[], p: number): number {
    if (!sorted.length) {
        return 0
    }
    const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
    return Math.round(sorted[index] * 10) / 10
}

/**
 * Frame cadence for the whole window — one observer, not one per terminal.
 *
 * Runs only while something is actually writing to a terminal. A rAF loop that
 * never stops would keep the compositor awake on an idle window and show up as
 * battery drain, which is a poor trade for a diagnostic.
 */
class FrameMonitor {
    private running = false
    private lastFrame = 0
    private frames: number[] = []
    private slow = 0
    private jank = 0
    private worst = 0
    private stopTimer: any = null

    /** Called whenever a terminal writes; keeps the monitor alive a little longer. */
    poke (): void {
        if (this.stopTimer) {
            clearTimeout(this.stopTimer)
        }
        this.stopTimer = setTimeout(() => this.stop(), 2000)
        if (!this.running) {
            this.start()
        }
    }

    private start (): void {
        this.running = true
        this.lastFrame = 0
        const tick = (now: number) => {
            if (!this.running) {
                return
            }
            if (this.lastFrame) {
                const gap = now - this.lastFrame
                // An idle tab produces one enormous gap; counting it as a
                // dropped frame would make every summary look catastrophic.
                if (gap < IDLE_GAP_MS) {
                    this.frames.push(gap)
                    if (gap > this.worst) {
                        this.worst = gap
                    }
                    if (gap > JANK_FRAME_MS) {
                        this.jank++
                    } else if (gap > SLOW_FRAME_MS) {
                        this.slow++
                    }
                }
            }
            this.lastFrame = now
            requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
    }

    private stop (): void {
        this.running = false
        this.stopTimer = null
    }

    /** The numbers so far, and reset. Null when nothing is worth reporting. */
    take (): Record<string, unknown> | null {
        if (!this.slow && !this.jank) {
            this.frames = []
            this.worst = 0
            return null
        }
        const sorted = [...this.frames].sort((a, b) => a - b)
        const summary = {
            frames: this.frames.length,
            slowFrames: this.slow,
            jankFrames: this.jank,
            worstMs: Math.round(this.worst),
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
        }
        this.frames = []
        this.slow = 0
        this.jank = 0
        this.worst = 0
        return summary
    }

    dispose (): void {
        this.stop()
        if (this.stopTimer) {
            clearTimeout(this.stopTimer)
            this.stopTimer = null
        }
    }
}

/** Write latency for one terminal. */
class WriteTally {
    calls = 0
    bytes = 0
    totalMs = 0
    worstMs = 0
    slow = 0

    add (ms: number, bytes: number): void {
        this.calls++
        this.bytes += bytes
        this.totalMs += ms
        if (ms > this.worstMs) {
            this.worstMs = ms
        }
        if (ms > SLOW_WRITE_MS) {
            this.slow++
        }
    }

    take (): Record<string, unknown> | null {
        if (!this.calls) {
            return null
        }
        const summary = {
            writes: this.calls,
            kib: Math.round(this.bytes / 1024),
            totalMs: Math.round(this.totalMs),
            meanMs: Math.round(this.totalMs / this.calls * 100) / 100,
            worstMs: Math.round(this.worstMs * 10) / 10,
            slowWrites: this.slow,
        }
        this.calls = 0
        this.bytes = 0
        this.totalMs = 0
        this.worstMs = 0
        this.slow = 0
        return summary
    }
}

export class RenderTiming {
    private frameMonitor = new FrameMonitor()
    private tallies = new Map<string, WriteTally>()
    private reportTimer: any = null
    private everReported = false

    /**
     * Wrap a terminal's `write` so the time xterm spends parsing and laying out
     * is attributed.
     *
     * xterm's write callback fires once the chunk has been processed, which is
     * exactly the interval worth measuring — the caller's `await` returns long
     * before the screen reflects it. Returns a function that undoes the wrap.
     */
    instrument (xterm: WritableTerminal | null, label: string): () => void {
        if (!diagnostics() || !xterm || typeof xterm.write !== 'function') {
            return () => { /* nothing was wrapped */ }
        }
        const original = xterm.write.bind(xterm)
        const tally = this.tallies.get(label) ?? new WriteTally()
        this.tallies.set(label, tally)

        xterm.write = (data: string | Uint8Array, callback?: () => void) => {
            const started = performance.now()
            const size = data.length
            this.frameMonitor.poke()
            this.schedule()
            original(data, () => {
                tally.add(performance.now() - started, size)
                callback?.()
            })
        }
        return () => {
            xterm.write = original
            this.tallies.delete(label)
        }
    }

    private schedule (): void {
        if (this.reportTimer) {
            return
        }
        this.reportTimer = setTimeout(() => {
            this.reportTimer = null
            this.report()
        }, REPORT_EVERY_MS)
    }

    /**
     * Emit a summary, but only when there is something to say — a quiet hour of
     * healthy frames is not worth a line in the log.
     */
    report (): void {
        const diag = diagnostics()
        if (!diag) {
            return
        }
        const frames = this.frameMonitor.take()
        const writes: Record<string, unknown> = {}
        let anyWrites = false
        for (const [label, tally] of this.tallies) {
            const summary = tally.take()
            // Only terminals that were actually slow, or the report is mostly
            // noise from tabs that behaved.
            if (summary && ((summary.slowWrites as number) > 0 || (summary.worstMs as number) > SLOW_WRITE_MS)) {
                writes[label] = summary
                anyWrites = true
            }
        }
        if (!frames && !anyWrites) {
            return
        }
        this.everReported = true
        diag.report('render-timing', { frames, writes: anyWrites ? writes : undefined })
    }

    get hasReported (): boolean {
        return this.everReported
    }

    dispose (): void {
        if (this.reportTimer) {
            clearTimeout(this.reportTimer)
            this.reportTimer = null
        }
        this.frameMonitor.dispose()
        this.tallies.clear()
    }
}
