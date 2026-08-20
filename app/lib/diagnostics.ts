import * as fs from 'fs'
import * as path from 'path'

/**
 * The live module objects, for patching.
 *
 * `import * as fs from 'fs'` compiles to `__importStar(require('fs'))`, which
 * builds a *copy* of the namespace — assigning to it instruments this file and
 * nobody else, silently, with the reports still arriving and their attribution
 * always empty. The wrapper has to go onto the object every other caller
 * actually holds.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const liveFs: any = require('fs')

/**
 * Records what blocks an event loop, and what the process was doing when it did.
 *
 * A frozen Tabby window leaves no trace anywhere. The process keeps pumping
 * messages, so Windows reports it as responding; nothing is thrown, so the
 * crash log stays empty; the app log carries no timestamps, so even the events
 * that *were* recorded cannot be lined up against the freeze. The only account
 * of a hang is the user saying it hung.
 *
 * Two halves fix that:
 *
 * 1. A drift detector. A timer that should fire every `TICK_MS` and fires late
 *    by more than the threshold proves the loop was blocked for that long,
 *    and by how much.
 *
 * 2. Attribution. Knowing the loop stalled is half an answer — the useful half
 *    is *which code*. Every synchronous `fs` and `child_process` call is
 *    wrapped and tallied, so a stall report carries the exact call mix that
 *    ran during it. This is deliberately a tally rather than a slow-call log:
 *    the failure mode that actually freezes this app is tens of thousands of
 *    individually-fast calls (draining a spool directory, walking a build),
 *    where no single call would ever trip a "slow call" threshold but the sum
 *    blocks the UI for minutes.
 *
 * Both halves are installed before anything else so they cover plugin load and
 * Angular bootstrap. `require('fs')` returns the one shared builtin, so
 * wrapping it here covers every plugin in the renderer too, without their
 * cooperation and without knowing they exist.
 *
 * Overhead is two `performance.now()` calls and a map lookup per synchronous
 * call — around 200ns, i.e. ~12ms across the 60,000-call burst that this was
 * written to catch. Set `TABBY_DIAG=0` to disable the lot.
 */

/** Timer handles taken before zone.js patches them: a diagnostic must not
 *  schedule an Angular change detection pass on every tick, and must keep
 *  working if the zone itself is what is wedged. */
const nativeSetInterval = setInterval
const nativeSetTimeout = setTimeout

type Role = 'main' | 'renderer'

interface SyncTally {
    n: number
    ms: number
}

interface Breadcrumb {
    at: string
    kind: string
    detail?: unknown
}

const TICK_MS = 100
/** Ignore drift below this — normal scheduling jitter and GC pauses. */
const DEFAULT_STALL_MS = 250
/** A single call slower than this is worth naming on its own. */
const DEFAULT_SLOW_IO_MS = 15
/** Report a named operation that took longer than this. Set below the point
 *  where a delay stops feeling instant. */
const DEFAULT_SPAN_MS = 150
/** Capture a stack every N synchronous calls, to attribute a burst of fast
 *  ones without paying for a stack capture on each. */
const STACK_SAMPLE_EVERY = 500
const MAX_BREADCRUMBS = 24
const MAX_SAMPLES = 6
const MAX_SLOW_CALLS = 8
const MAX_LONGTASKS = 8
/** Keep a record comfortably inside the size where an O_APPEND write from
 *  several processes at once still lands atomically. */
const MAX_RECORD_BYTES = 3000
const MAX_LOG_BYTES = 8 * 1024 * 1024

const SYNC_FS_METHODS = [
    'accessSync', 'appendFileSync', 'closeSync', 'copyFileSync', 'existsSync',
    'fstatSync', 'lstatSync', 'mkdirSync', 'openSync', 'readFileSync',
    'readSync', 'readdirSync', 'readlinkSync', 'realpathSync', 'renameSync',
    'rmSync', 'rmdirSync', 'statSync', 'unlinkSync', 'writeFileSync',
    'writeSync',
]
const SYNC_CHILD_PROCESS_METHODS = ['execSync', 'execFileSync', 'spawnSync']

let installed = false
let role: Role = 'renderer'
let logFile: string | null = null
let startedAt = Date.now()

const tally = new Map<string, SyncTally>()
let slowCalls: { call: string, target: string, ms: number, stack: string }[] = []
let stackSamples: { call: string, target: string, stack: string, hits: number }[] = []
let longtasks: { ms: number, at: string }[] = []
const breadcrumbs: Breadcrumb[] = []
let syncCallsSeen = 0
let lastPhase = 'start'

/** Never reset, unlike the windowed tally. A span outlives many ticks, so it
 *  needs a counter that is still monotonic when it ends. */
let cumulativeSyncMs = 0
let cumulativeSyncCalls = 0

let pending: string[] = []
let flushScheduled = false

function envFlag (name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (raw === undefined || raw === '') {
        return fallback
    }
    return raw !== '0' && raw.toLowerCase() !== 'false'
}

function envNumber (name: string, fallback: number): number {
    const raw = Number(process.env[name])
    return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

const stallThresholdMs = envNumber('TABBY_DIAG_STALL_MS', DEFAULT_STALL_MS)
const slowIOThresholdMs = envNumber('TABBY_DIAG_SLOW_IO_MS', DEFAULT_SLOW_IO_MS)
const spanThresholdMs = envNumber('TABBY_DIAG_SPAN_MS', DEFAULT_SPAN_MS)

/** `performance` exists in both the main process and the renderer, but only as
 *  a global — not worth an import, and a missing one must not break boot. */
function now (): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// ── Output ──────────────────────────────────────────────────────────────────

/**
 * Serialise one record, shrinking it by dropping whole fields rather than by
 * cutting the string. A JSONL log whose long lines do not parse is worse than
 * one that admits it left something out — and the detail fields are ordered
 * here least-useful first, so what survives is always the summary.
 */
function serialise (record: Record<string, unknown>): string {
    let line = JSON.stringify(record)
    if (line.length <= MAX_RECORD_BYTES) {
        return line
    }
    for (const field of ['breadcrumbs', 'samples', 'slowest', 'longtasks']) {
        if (!(field in record)) {
            continue
        }
        delete record[field]
        record.truncated = true
        line = JSON.stringify(record)
        if (line.length <= MAX_RECORD_BYTES) {
            return line
        }
    }
    return JSON.stringify({
        at: record.at,
        role: record.role,
        pid: record.pid,
        kind: record.kind,
        ms: record.ms,
        summary: record.summary,
        truncated: true,
    })
}

/**
 * Append a record. Buffered and written asynchronously on purpose: an
 * instrumentation that blocks the loop to report that the loop was blocked
 * would be measuring itself. Nothing runs during a stall anyway, so buffering
 * costs no fidelity — the records are written the moment the loop frees up.
 */
function emit (record: Record<string, unknown>): void {
    pending.push(serialise({
        at: new Date().toISOString(),
        role,
        pid: process.pid,
        ...record,
    }))
    if (!logFile || flushScheduled) {
        return
    }
    flushScheduled = true
    nativeSetTimeout(() => {
        flushScheduled = false
        const batch = pending
        pending = []
        if (!logFile || !batch.length) {
            return
        }
        fs.appendFile(logFile, `${batch.join('\n')}\n`, () => { /* diagnostics must never throw */ })
    }, 1000)
}

/** Roll the log if it has grown past the cap. Runs once, at install. */
function rotate (file: string): void {
    fs.stat(file, (err, stat) => {
        if (err || stat.size < MAX_LOG_BYTES) {
            return
        }
        fs.rename(file, `${file}.1`, () => { /* a failed roll is not worth reporting */ })
    })
}

function resolveLogFile (): string | null {
    const dir = process.env.TABBY_CONFIG_DIRECTORY
    if (!dir) {
        // The renderer inherits this from the main process, which sets it
        // before any window exists. Without it there is nowhere agreed to
        // write, so fall back to the console rather than guessing a path.
        return null
    }
    return path.join(dir, 'diagnostics.log')
}

// ── Breadcrumbs ─────────────────────────────────────────────────────────────

/** Note a boot phase or notable moment, so a stall says what was in progress. */
export function mark (phase: string, detail?: unknown): void {
    lastPhase = phase
    note(phase, detail)
}

/** Record something worth seeing next to a stall, without making it a phase. */
export function note (kind: string, detail?: unknown): void {
    breadcrumbs.push({ at: new Date().toISOString(), kind, detail })
    if (breadcrumbs.length > MAX_BREADCRUMBS) {
        breadcrumbs.shift()
    }
}

// ── Spans ───────────────────────────────────────────────────────────────────

export interface Span {
    /** Close the span. Returns its duration in ms. */
    end (extra?: unknown): number
}

const NULL_SPAN: Span = { end: () => 0 }

/**
 * Time one named operation, however long it takes and whatever it awaits.
 *
 * The stall detector only sees work that *blocks* the loop, which makes it
 * blind to exactly the delays users complain about most: an operation that
 * spends a second inside `await` leaves the loop free the whole time and is
 * never reported, even though the window sat there doing nothing visible.
 *
 * A span records the wall-clock cost of an operation and how much of it was
 * synchronous I/O, which is usually enough to say whether to look at the
 * awaited call or at what ran around it. Only spans over the threshold are
 * written, so instrumenting a hot path costs two timestamps.
 */
export function span (label: string, detail?: unknown): Span {
    if (!installed) {
        return NULL_SPAN
    }
    const started = now()
    const syncMsAtStart = cumulativeSyncMs
    const syncCallsAtStart = cumulativeSyncCalls
    let ended = false
    return {
        end (extra?: unknown): number {
            if (ended) {
                return 0
            }
            ended = true
            const ms = now() - started
            if (ms >= spanThresholdMs) {
                const syncMs = cumulativeSyncMs - syncMsAtStart
                emit({
                    kind: 'span',
                    label,
                    ms: Math.round(ms),
                    syncMs: Math.round(syncMs),
                    syncCalls: cumulativeSyncCalls - syncCallsAtStart,
                    detail,
                    extra,
                    summary: `${label} took ${ms.toFixed(0)}ms (${Math.round(syncMs)}ms synchronous I/O)`,
                })
                note(`slow:${label}`, Math.round(ms))
            }
            return ms
        },
    }
}

// ── Synchronous I/O attribution ─────────────────────────────────────────────

function describeTarget (args: unknown[]): string {
    const first = args[0]
    if (typeof first === 'string') {
        return first.length > 160 ? `${first.slice(0, 160)}…` : first
    }
    if (Array.isArray(first)) {
        return first.slice(0, 3).join(' ')
    }
    return typeof first
}

/** The caller, minus this module's own frames and the noise around them. */
function callerStack (): string {
    const raw = new Error().stack ?? ''
    const frames = raw.split('\n')
        .slice(3, 9)
        .map(x => x.trim().replace(/^at /, ''))
        // Module machinery says nothing about which feature was running.
        .filter(x => !x.startsWith('Module.') && !x.includes('node:internal/modules'))
        .slice(0, 4)
    const joined = frames.join(' ← ')
    return joined.length > 400 ? `${joined.slice(0, 400)}…` : joined
}

function recordSyncCall (call: string, ms: number, args: unknown[]): void {
    cumulativeSyncMs += ms
    cumulativeSyncCalls++

    const entry = tally.get(call)
    if (entry) {
        entry.n++
        entry.ms += ms
    } else {
        tally.set(call, { n: 1, ms })
    }

    if (ms >= slowIOThresholdMs && slowCalls.length < MAX_SLOW_CALLS * 4) {
        slowCalls.push({ call, target: describeTarget(args), ms: Math.round(ms), stack: callerStack() })
    }

    // A burst of individually-fast calls is the case that matters, and it is
    // invisible to any per-call threshold. Sampling gives it a stack for the
    // cost of one capture per few hundred calls.
    syncCallsSeen++
    if (syncCallsSeen % STACK_SAMPLE_EVERY === 0) {
        const stack = callerStack()
        // One loop sampled repeatedly produces the same stack every time;
        // recording it six times crowds out the second-worst offender.
        const seen = stackSamples.find(x => x.stack === stack)
        if (seen) {
            seen.hits++
        } else {
            stackSamples.push({ call, target: describeTarget(args), stack, hits: 1 })
            if (stackSamples.length > MAX_SAMPLES) {
                stackSamples.shift()
            }
        }
    }
}

function instrument (module: any, moduleName: string, methods: string[]): void {
    for (const method of methods) {
        const original = module[method]
        if (typeof original !== 'function') {
            continue
        }
        const call = `${moduleName}.${method}`
        function wrapper (this: unknown, ...args: unknown[]) {
            const started = now()
            try {
                return original.apply(this, args)
            } finally {
                recordSyncCall(call, now() - started, args)
            }
        }
        try {
            // Carry across attached properties — `fs.realpathSync.native` is
            // one, and losing it breaks callers that never asked to be
            // instrumented. `name` and `length` are not enumerable, so they
            // need doing by hand; a rest-args wrapper otherwise reports an
            // arity of zero to anything that inspects it.
            Object.assign(wrapper, original)
            Object.defineProperty(wrapper, 'name', { value: method })
            Object.defineProperty(wrapper, 'length', { value: original.length })
            module[method] = wrapper
        } catch {
            // A frozen or read-only binding — leave it alone, an
            // un-instrumented call is far better than a broken one.
        }
    }
}

// ── Stall detection ─────────────────────────────────────────────────────────

function resetWindow (): void {
    tally.clear()
    slowCalls = []
    stackSamples = []
    longtasks = []
    syncCallsSeen = 0
}

function topSyncIO (): Record<string, SyncTally> {
    const out: Record<string, SyncTally> = {}
    for (const [call, entry] of [...tally.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6)) {
        out[call] = { n: entry.n, ms: Math.round(entry.ms) }
    }
    return out
}

function totalSyncMs (): number {
    let total = 0
    for (const entry of tally.values()) {
        total += entry.ms
    }
    return total
}

function summarise (blockedMs: number): string {
    const syncMs = totalSyncMs()
    const parts = Object.entries(topSyncIO())
        .slice(0, 3)
        .map(([call, entry]) => `${call} ×${entry.n} (${(entry.ms / 1000).toFixed(1)}s)`)
    // The split between the two matters more than either number. Synchronous
    // I/O that accounts for most of the stall is a blocking-call problem and
    // names its own fix; a stall with almost none of it is script or GC, and
    // no amount of I/O detail would have helped.
    // Against the whole blocked window, not just the overshoot: the tally
    // covers everything since the previous tick, so dividing by the lateness
    // alone reports more than 100% for a stall that is pure I/O.
    const share = Math.min(1, syncMs / (blockedMs + TICK_MS))
    const attribution = parts.length && share >= 0.2
        ? `${(share * 100).toFixed(0)}% synchronous I/O: ${parts.join(', ')}`
        : parts.length
            ? `mostly script or GC (${(share * 100).toFixed(0)}% synchronous I/O: ${parts.join(', ')})`
            : 'no synchronous I/O — script or GC'
    return `${role} event loop blocked ${(blockedMs / 1000).toFixed(1)}s during "${lastPhase}" — ${attribution}`
}

function reportStall (blockedMs: number): void {
    const summary = summarise(blockedMs)
    emit({
        kind: 'stall',
        ms: Math.round(blockedMs),
        phase: lastPhase,
        uptimeMs: Date.now() - startedAt,
        summary,
        syncMs: Math.round(totalSyncMs()),
        syncCalls: syncCallsSeen,
        syncIO: topSyncIO(),
        slowest: slowCalls.sort((a, b) => b.ms - a.ms).slice(0, MAX_SLOW_CALLS),
        samples: stackSamples,
        longtasks,
        breadcrumbs: breadcrumbs.slice(-10),
    })
    console.warn(`[diagnostics] ${summary}`)
    resetWindow()
}

function startStallDetector (): void {
    let last = now()
    nativeSetInterval(() => {
        const current = now()
        const lateBy = current - last - TICK_MS
        last = current
        if (lateBy >= stallThresholdMs) {
            reportStall(lateBy)
        } else {
            // Only the window immediately before a stall is interesting, so
            // clear the tally on every healthy tick. Otherwise a report would
            // be dominated by whatever the app did all session.
            resetWindow()
        }
    }, TICK_MS)
}

/**
 * Chromium's own long-task reporting, where it exists. It attributes tasks the
 * renderer itself considers long (>50ms), which catches layout, paint and
 * script the drift detector only sees in aggregate.
 */
function startLongTaskObserver (): void {
    if (typeof PerformanceObserver === 'undefined') {
        return
    }
    try {
        const observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                longtasks.push({ ms: Math.round(entry.duration), at: new Date().toISOString() })
                if (longtasks.length > MAX_LONGTASKS) {
                    longtasks.shift()
                }
            }
        })
        observer.observe({ entryTypes: ['longtask'] })
    } catch {
        // Not supported in this build — the drift detector still covers it.
    }
}

// ── Install ─────────────────────────────────────────────────────────────────

/**
 * Start recording. Safe to call more than once; only the first call does
 * anything, so a second window cannot double-wrap `fs`.
 */
export function installDiagnostics (which: Role): void {
    if (installed || !envFlag('TABBY_DIAG', true)) {
        return
    }
    installed = true
    role = which
    startedAt = Date.now()

    logFile = resolveLogFile()
    if (logFile) {
        rotate(logFile)
    }

    if (envFlag('TABBY_DIAG_INSTRUMENT_IO', true)) {
        // Anything that destructured a method off `fs` before this ran keeps
        // the original and stays invisible. Installing first — ahead of
        // zone.js, the plugin loader and Angular — keeps that set to almost
        // nothing.
        instrument(liveFs, 'fs', SYNC_FS_METHODS)
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            instrument(require('child_process'), 'child_process', SYNC_CHILD_PROCESS_METHODS)
        } catch {
            // Not available — nothing to instrument.
        }
    }

    startStallDetector()
    startLongTaskObserver()

    if (which === 'renderer' && typeof window !== 'undefined') {
        // A plugin that throws during load is swallowed by the loader's own
        // catch; these two are the last place it can still be seen.
        window.addEventListener('error', event => recordFailure('renderer-error', event.error ?? event.message))
        window.addEventListener('unhandledrejection', event => recordFailure('unhandledrejection', event.reason))
    }

    // Published on the global rather than imported: `tabby-core` and the
    // plugins are separate bundles that cannot reach into the app bundle, and
    // making them depend on it would be the wrong direction anyway. Anything
    // that wants to time itself looks this up and degrades to a no-op when it
    // is absent — which is the honest state under tabby-web, where none of
    // this exists.
    ;(globalThis as any).__tabbyDiagnostics = { span, mark, note, recordFailure }

    emit({
        kind: 'session-start',
        stallThresholdMs,
        slowIOThresholdMs,
        instrumentingIO: envFlag('TABBY_DIAG_INSTRUMENT_IO', true),
        argv: process.argv.slice(1, 6),
        execPath: process.execPath,
    })
    mark(`${which}-start`)
}

/** Record an unexpected failure alongside the stall history. */
export function recordFailure (kind: string, detail: unknown): void {
    const described = detail instanceof Error ? detail.stack ?? detail.message : String(detail)
    note(kind, described)
    emit({ kind, detail: described, phase: lastPhase })
}
