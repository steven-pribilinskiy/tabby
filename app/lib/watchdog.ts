import { app } from 'electron'

import { flushDiagnostics, note, report } from './diagnostics'
import { logMainError } from './errors'

/**
 * Quit rather than sit there useless, holding every later launch hostage.
 *
 * Tabby takes the single-instance lock (`app/lib/index.ts`), so exactly one
 * process answers for the app: every later launch is handed to it through
 * `second-instance` and then exits. That is right while this process works. It
 * is a trap when it does not — a process that cannot show a window still owns
 * the identity, so relaunching does nothing at all, forever, with no window, no
 * error and no crash to point at. Measured here on 2026-09-05: six hours of a
 * renderer sitting at 94 MB and 0% CPU on the splash screen, and every attempt
 * to restart Tabby quietly handed to it.
 *
 * Two ways to end up there, and they need different tests:
 *
 * 1. **No window at all.** A window creation that threw, or a handoff that
 *    produced nothing. Nobody up the stack treats that as fatal — `activate`,
 *    the `app:new-window` IPC and `handleSecondInstance` all call `newWindow()`
 *    without a catch — so the process carries on with nothing to show. This is
 *    the case the Windows Terminal fork's `_armNoWindowWatchdog` covers, and it
 *    is a real hole here too.
 *
 * 2. **A window that never booted.** The one that actually bit. `newWindow()`
 *    pushes the window onto the list *before* awaiting `window.ready`, so the
 *    window exists, the renderer is alive, and a zero-window test sees nothing
 *    wrong. What never arrives is `app:ready`.
 *
 * The safety rule for both, and the only one that matters: **this must never
 * quit a process that has produced a usable window.** `app:ready` is the line.
 * It is sent from `appRoot.ngOnInit` once `config.ready$` resolves, which means
 * an Angular root exists in that renderer — and everything that can open a tab
 * or spawn a PTY lives at or after that point. So a process in which no window
 * has *ever* emitted it has never run a session, and there is nothing in it to
 * lose. The first `app:ready` disarms the lot, permanently, for the life of the
 * process.
 *
 * There is a third way to hold the lock uselessly, and it is the one that made
 * all of the above unreachable: sitting inside a modal error box, which stops
 * the loop these timers live on. That is closed in `./fatal`, which hands the
 * quitting back here rather than deciding it itself.
 *
 * `TABBY_WATCHDOG=0` turns it off entirely; `TABBY_WATCHDOG_BOOT_MS` and
 * `TABBY_WATCHDOG_NO_WINDOW_MS` retune it without a rebuild.
 */

/** A creation that failed, or a handoff that produced nothing, gets this long
 *  for anything still in flight to put a window up. Matches the reference. */
const DEFAULT_NO_WINDOW_MS = 5000

/**
 * How long a boot may take before it counts as one that is never going to
 * finish. Generously above anything measured on this machine — a cold main
 * process has been seen blocked 17.4s in `main-start` alone — because the cost
 * of firing early (a relaunch) is small but a Tabby that keeps quitting on
 * itself would be worse than a slow one.
 */
const DEFAULT_BOOT_MS = 60000

/** The boot budget is spent in ticks, not wall clock: see `armBootWatchdog`. */
const TICK_MS = 1000

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

const enabled = envFlag('TABBY_WATCHDOG', true)
const noWindowMs = envNumber('TABBY_WATCHDOG_NO_WINDOW_MS', DEFAULT_NO_WINDOW_MS)
const bootMs = envNumber('TABBY_WATCHDOG_BOOT_MS', DEFAULT_BOOT_MS)

/** Has any window in this process ever reached `app:ready`? Never goes back. */
let anyWindowReady = false
/** Set by `Application`. Until it is, the answer is "yes, there are windows",
 *  which is the answer that makes the watchdog do nothing. */
let countWindows: () => number = () => 1
/** Whether that probe is the real one yet. Before `Application` is constructed
 *  no window can exist, and the fallback above deliberately says otherwise. */
let counting = false
let noWindowTimer: ReturnType<typeof setTimeout> | null = null
let bootTimer: ReturnType<typeof setInterval> | null = null
/** An exit is decided: this process is on its way out, or something else has
 *  taken responsibility for ending it. Nothing re-arms afterwards. */
let quitting = false
const startedAt = Date.now()

/** Tell the watchdog how to count live windows. Called once, from `Application`. */
export function watchWindows (probe: () => number): void {
    countWindows = probe
    counting = true
}

/**
 * Is there anything in this process worth keeping alive?
 *
 * The watchdogs' own question, exported so that anything else deciding whether
 * to quit asks it here instead of inventing a second answer. A window that has
 * reached `app:ready` may be holding live sessions; one that exists but has not
 * is still a boot in progress, and `armBootWatchdog` is already timing it.
 */
export function hasSomethingToLose (): boolean {
    return anyWindowReady || counting && countWindows() > 0
}

/** Is a timer running that will end this process if no window turns up? */
export function watchdogArmed (): boolean {
    return !!noWindowTimer || !!bootTimer
}

function disarm (): void {
    if (noWindowTimer) {
        clearTimeout(noWindowTimer)
        noWindowTimer = null
    }
    if (bootTimer) {
        clearInterval(bootTimer)
        bootTimer = null
    }
}

/**
 * Something else has taken responsibility for ending this process.
 *
 * Used while a startup error is being shown to someone: the box has to outlive
 * the few seconds of grace below, and `./fatal` has already scheduled the exit
 * behind it. Nothing re-arms afterwards, so this cannot leave a timer to fire
 * out from under a dialog somebody is still reading.
 */
export function standDown (reason: string): void {
    if (quitting) {
        return
    }
    quitting = true
    disarm()
    note('watchdog-stand-down', { reason })
}

/**
 * A window reached `app:ready`.
 *
 * The single disarm signal. From here on this process has shown the user
 * something and may be holding live sessions, so nothing below may ever quit
 * it — not a later window that fails, not a handoff that produces nothing.
 */
export function noteWindowReady (): void {
    if (anyWindowReady) {
        return
    }
    anyWindowReady = true
    disarm()
    const afterMs = Date.now() - startedAt
    // A record rather than a breadcrumb: how long this build took to put a
    // usable window up is a finding on its own, and it is the only externally
    // visible proof that a boot finished — the boot phase marks are breadcrumbs,
    // which are invisible unless something stalls.
    report('window-ready', { afterMs, summary: `first window reached app:ready after ${(afterMs / 1000).toFixed(1)}s` })
}

function giveUp (reason: string, summary: string, detail: Record<string, unknown>): void {
    if (quitting) {
        return
    }
    quitting = true
    disarm()

    report('watchdog-quit', { reason, summary, ...detail, uptimeMs: Date.now() - startedAt })
    // Both logs, deliberately. Someone asking "why did Tabby quit on me?" looks
    // in main-process-errors.log; diagnostics.log carries the boot phase and the
    // stall history that say what it was stuck on.
    logMainError('watchdog', summary)
    // Records are batched behind a one-second timer, and `app.exit()` runs no
    // timers. Without this the one record that explains the exit is the one
    // record guaranteed to be lost, and a watchdog that quits silently just
    // moves the mystery somewhere harder to find.
    flushDiagnostics()

    // Not `app.quit()`: `Window`'s own `close` handler calls `preventDefault()`
    // and asks the renderer to confirm, and a renderer that never booted never
    // answers — so quitting politely would hang in exactly the place we are
    // trying to escape. Nothing here is worth saving anyway: no window in this
    // process ever reached `app:ready`.
    app.exit(1)
}

/**
 * The zero-window backstop.
 *
 * Armed where a window was supposed to appear and may not have: a creation that
 * threw, or a launch handed to us by the single-instance lock. Returns without
 * doing anything whenever a window exists, so an unrelated failure while a
 * session is open can never put it at risk.
 */
export function armNoWindowWatchdog (reason: string): void {
    if (!enabled || quitting || anyWindowReady || noWindowTimer) {
        return
    }
    if (countWindows() > 0) {
        return
    }
    note('watchdog-armed', { reason, budgetMs: noWindowMs })
    noWindowTimer = setTimeout(() => {
        noWindowTimer = null
        // Re-checked, not assumed: a window may well have arrived while we waited.
        if (anyWindowReady || countWindows() > 0) {
            return
        }
        giveUp(reason, `no window ${(noWindowMs / 1000).toFixed(0)}s after ${reason} — quitting so the next launch gets a fresh process`, {
            windows: 0,
            budgetMs: noWindowMs,
        })
    }, noWindowMs)
    // A diagnostic must never be the reason a process stays alive.
    noWindowTimer.unref()
}

/**
 * The never-booted backstop, armed once at `app-ready`.
 *
 * This is the half that catches what a zero-window test cannot see: a window
 * that exists, whose renderer is alive, and which never finishes starting. It
 * fires on one condition only — no window in this process has ever emitted
 * `app:ready` — and that condition is exactly "nothing here has ever run".
 *
 * The budget is counted in ticks of a live event loop rather than in wall
 * clock. A main process that was itself blocked for thirty seconds has not
 * given the renderer thirty seconds to boot, and burning the budget on that
 * would quit a build that was merely slow to start.
 */
export function armBootWatchdog (): void {
    if (!enabled || quitting || anyWindowReady || bootTimer) {
        return
    }
    let ticks = 0
    const budget = Math.ceil(bootMs / TICK_MS)
    note('watchdog-armed', { reason: 'boot', budgetMs: bootMs })
    bootTimer = setInterval(() => {
        if (anyWindowReady) {
            disarm()
            return
        }
        if (++ticks < budget) {
            return
        }
        giveUp('boot', `no window reached app:ready in ${(bootMs / 1000).toFixed(0)}s — quitting so the next launch gets a fresh process`, {
            windows: countWindows(),
            budgetMs: bootMs,
        })
    }, TICK_MS)
    bootTimer.unref()
}
