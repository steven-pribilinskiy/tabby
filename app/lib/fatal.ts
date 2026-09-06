import { app, dialog } from 'electron'
import * as path from 'path'

import { flushDiagnostics, recordFailure, report } from './diagnostics'
import { logMainError } from './errors'
import { armNoWindowWatchdog, hasSomethingToLose, standDown, watchdogArmed } from './watchdog'

/**
 * Startup failed. Write it down, tell whoever is there, and get out of the way.
 *
 * This is the third way a Tabby process can hold every later launch hostage,
 * after the two `./watchdog` covers — and the one that made the watchdog
 * powerless. A startup error was shown with `dialog.showErrorBox`, which is
 * **modal and synchronous**: the main loop stops inside it until someone
 * clicks OK. Measured here on 2026-09-06: a process sitting on one ran not a
 * single timer callback in fourteen seconds. So it stayed alive, holding the
 * single-instance lock, with no window and no way to make one, while every
 * later launch was handed to it and silently disappeared — and the watchdog
 * that exists for exactly that was on a timer that could never fire, because
 * the loop it lives on was the loop that had stopped.
 *
 * Worse on an unattended launch. A startup item or a Start-menu shortcut has
 * nobody in front of it, so the box that was supposed to be the report was
 * never read by anyone, and the only evidence of the failure was a Tabby that
 * would not come up.
 *
 * Four things fix it, in this order:
 *
 * 1. **Record before anything else.** A box on a screen nobody is looking at
 *    is not a record. `diagnostics.log` and `main-process-errors.log` are, and
 *    they are written and flushed synchronously here, before anything that
 *    could block or exit — `app.exit()` runs no timers, so the batching flush
 *    would otherwise drop the one record that explains the exit.
 * 2. **Release the lock before saying a word.** Whatever happens to the dialog
 *    afterwards — dismissed, ignored, never seen — the next launch gets a
 *    fresh process from this point on. That is the whole hostage property, and
 *    it is closed by one call rather than by everything below going right.
 * 3. **Never block the loop.** `dialog.showMessageBox` runs its dialog on its
 *    own thread and answers with a promise, so timers keep running, the
 *    watchdog stays live, and this process can still put itself down on a cap
 *    if nobody ever clicks. (Verified against the blocking one: with the async
 *    box up, a 500ms interval kept ticking and an 8s timer fired.)
 * 4. **Don't decide the exit here.** Whether there is anything in this process
 *    worth keeping is the watchdog's question, already answered there on a
 *    predicate that is careful about it, so quitting is handed back to it
 *    rather than answered a second time.
 */

/**
 * How long a box nobody dismisses may keep this process alive.
 *
 * Longer than anyone stares at an error they just triggered, and short enough
 * that a launch nobody was watching does not leave a process sitting on the
 * desktop until the machine is rebooted.
 */
const DEFAULT_DIALOG_MS = 120000

const dialogMs = (() => {
    const raw = Number(process.env.TABBY_FATAL_DIALOG_MS)
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DIALOG_MS
})()

/** Only the first fatal error is worth reporting; the rest are its wake. */
let handled = false

/**
 * Why nobody will see a dialog, or null when someone might.
 *
 * Nothing on Windows separates a double-click from a startup item, so this
 * only answers where the answer is certain rather than guessing. `--hidden` is
 * the certain case: the flag exists so that a launch puts *nothing* on screen,
 * which makes it the one launch where a modal is definitely unwanted. Nobody
 * loses the error that way — a hidden Tabby that failed to start is a Tabby
 * the user will launch again the ordinary way, and that launch is not hidden,
 * with both logs already written by this one.
 *
 * Everything else is assumed to have someone in front of it, and the cap above
 * bounds the cost of being wrong.
 */
function nobodyIsWatching (): string | null {
    if (process.argv.includes('--hidden')) {
        return 'launched --hidden'
    }
    if (process.env.TABBY_FATAL_DIALOG === '0') {
        return 'TABBY_FATAL_DIALOG=0'
    }
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
        return 'no display'
    }
    return null
}

function describe (err: unknown): string {
    return err instanceof Error ? err.stack ?? err.message : String(err)
}

/**
 * Hand the app identity back, so the next launch is not handed to a process
 * that has already failed.
 */
function releaseLock (): void {
    try {
        app.releaseSingleInstanceLock()
    } catch (err) {
        // Never requested (this can fail before that point), or already gone.
        // Either way there is nothing held and nothing to do about it.
        recordFailure('release-lock-failed', err)
    }
}

function quit (reason: string): void {
    // Through the watchdog rather than around it. It re-checks whether a window
    // turned up after all, on the same predicate that governs every other way a
    // start can fail, and it is usually already armed by `newWindow()` — that
    // arm is precisely the one the modal used to stop from ever firing.
    armNoWindowWatchdog(reason)
    if (watchdogArmed()) {
        return
    }
    // Nothing will end this process: the watchdog is switched off, or this
    // failed before there was an `Application` to count windows. Something that
    // cannot start must not outlive the error it just wrote.
    flushDiagnostics()
    app.exit(1)
}

/**
 * Put the error in front of whoever is there.
 *
 * `quitAfter` is false only when a window in this process is already up, in
 * which case this is a report and not an obituary.
 */
function tell (title: string, detail: string, quitAfter: boolean): void {
    const where = process.env.TABBY_CONFIG_DIRECTORY
    const body = where
        ? `${detail}\n\nThis was also written to ${path.join(where, 'diagnostics.log')}.`
        : detail

    const finish = (): void => {
        if (!quitAfter) {
            return
        }
        flushDiagnostics()
        app.exit(1)
    }

    if (quitAfter) {
        setTimeout(finish, dialogMs)
    }

    // A dialog that will not open must not become a hang of its own: the
    // watchdog has stood down by now, so nothing else would end this process.
    try {
        if (!app.isReady()) {
            // `showMessageBox` needs a ready app, and a config file that will
            // not parse fails before that. `showErrorBox` is the only dialog
            // available this early and it is the blocking one — which is
            // tolerable here only because the single-instance lock is not
            // requested until later, so a process this young is holding
            // nothing hostage while it waits.
            dialog.showErrorBox(title, body)
            finish()
            return
        }

        dialog.showMessageBox({
            type: 'error',
            title,
            message: title,
            detail: body,
            buttons: [quitAfter ? 'Quit' : 'OK'],
            noLink: true,
        }).then(finish, finish)
    } catch (err) {
        recordFailure('startup-dialog-failed', err)
        finish()
    }
}

/**
 * Report a startup failure and, unless there is a working window, quit.
 *
 * Never returns when it is called before `app.ready` — nothing is armed that
 * early, so there would be nothing left to end the process, and the caller has
 * no useful state to carry on with anyway.
 */
export function fatalStartupError (kind: string, title: string, err: unknown): void {
    if (handled) {
        return
    }
    handled = true

    recordFailure(kind, err)
    logMainError(title, err)

    const silent = nobodyIsWatching()
    // Asked, not answered again: a failure at the tail of startup — `focus()`
    // on a window the user closed while it was still booting — must not take a
    // booted window and its live sessions down with it.
    const quitting = !hasSomethingToLose()
    // `failure`, not `kind`: `report` puts its own kind on the record, and a
    // detail field of that name would overwrite it.
    report('startup-failed', {
        failure: kind,
        summary: `${title}: ${err instanceof Error ? err.message : String(err)}`,
        dialog: silent ? 'skipped' : 'shown',
        why: silent ?? undefined,
        quitting,
    })
    flushDiagnostics()

    if (quitting) {
        releaseLock()
    }

    if (silent) {
        if (quitting) {
            quit(kind)
        }
        return
    }

    if (quitting) {
        // The box has to outlive the watchdog's few seconds of grace, so from
        // here this process's exit is the dialog's business — capped, because a
        // launch nobody was watching must not leave a process behind.
        standDown(`showing "${title}"`)
    }
    tell(title, describe(err), quitting)
}
