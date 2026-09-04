import { Injectable } from '@angular/core'
import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'

import { RenderTiming } from './timing'

/**
 * Attaches the write-path timer to every terminal.
 *
 * A decorator rather than an edit to `xtermFrontend.ts`: this is add-only, so it
 * costs nothing at the next upstream rebase, and it reaches every frontend that
 * exposes an `xterm` without needing to know which.
 */
@Injectable()
export class RenderTimingDecorator extends TerminalDecorator {
    private timing = new RenderTiming()
    private undo = new Map<BaseTerminalTabComponent<any>, () => void>()
    private nextId = 1

    attach (tab: BaseTerminalTabComponent<any>): void {
        const xterm = (tab.frontend as any)?.xterm
        if (!xterm) {
            // A frontend that is not xterm-backed, or not ready yet. Nothing to
            // wrap and nothing to report — silently fine.
            return
        }
        // Numbered, not named after the tab: a title changes as the shell runs
        // and the tally would then be split across several labels.
        this.undo.set(tab, this.timing.instrument(xterm, `term${this.nextId++}`))
    }

    detach (tab: BaseTerminalTabComponent<any>): void {
        // `tab.frontend` is already cleared by the time this runs, so the undo
        // has to have been kept here rather than looked up from the tab.
        this.undo.get(tab)?.()
        this.undo.delete(tab)
        if (!this.undo.size) {
            // Last terminal closed: flush whatever the session accumulated
            // rather than discarding it.
            this.timing.report()
        }
    }
}
