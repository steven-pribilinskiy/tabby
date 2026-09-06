import { Injectable, Inject, Injector } from '@angular/core'
import {
    BaseTabComponent,
    BOOTSTRAP_DATA,
    BootstrapData,
    NewTabParameters,
    RecoveryToken,
    TabRecoveryAugmentor,
} from 'tabby-core'

import { resumesAgentSession } from './recognize'
import { RESUME_COMMAND_INPUT, SessionResumeService } from './services/sessionResume.service'

/**
 * Puts what a pane is running into the layout Tabby already persists, and
 * takes it back out again on the way in.
 *
 * An augmentor rather than a recovery provider: `tabby-local` owns the
 * `app:local-tab` type and rebuilding the shell from it, and this has no
 * business replacing that. It only adds one field to whatever token that
 * provider produced, so a pane still comes back on its own profile, in its own
 * directory and inside its own split — and a tab type this fork has never
 * heard of goes through untouched.
 */
@Injectable()
export class ResumeRecoveryAugmentor extends TabRecoveryAugmentor {
    /**
     * The leaf tokens of the tab this window was opened to adopt, if it was.
     *
     * "Open in new window" hands the token to a fresh window, which then
     * *reuses the running PTY* — the pane's agent never stopped, so typing a
     * resume command at it would start a second one on top of the first, and
     * clearing its scrollback would blank a pane that nothing is going to
     * redraw. Every other route through `recoverTab` — the persisted layout,
     * reopening a closed tab — ends in a fresh shell, which is exactly what
     * this feature is for.
     */
    private readonly adopted = new Set<any>()
    private service: SessionResumeService | null = null

    constructor (
        private injector: Injector,
        @Inject(BOOTSTRAP_DATA) bootstrapData: BootstrapData,
    ) {
        super()
        this.collectLeaves(bootstrapData.initialTab)
    }

    /**
     * The service, resolved on first use rather than injected.
     *
     * Injecting it would deadlock the whole app before a window ever drew:
     * `AppService` builds `TabRecoveryService`, which now asks for every
     * augmentor, and the service this one needs asks for `AppService` — a
     * cycle Angular reports as `NG0200: Circular dependency in DI detected for
     * AppService`, after which bootstrap fails, safe mode fails the same way,
     * and the window sits on the splash screen. Resolving late breaks it,
     * because by the time a token is saved or recovered every one of those
     * exists.
     */
    private get resume (): SessionResumeService {
        this.service ??= this.injector.get(SessionResumeService)
        return this.service
    }

    async augment (tab: BaseTabComponent, token: RecoveryToken, options?: { includeState?: boolean }): Promise<void> {
        if (!options?.includeState) {
            // A duplicate, which deliberately starts clean: duplicating a pane
            // running an agent should give you a shell in the same directory,
            // not a second window onto the same conversation.
            return
        }
        // Never awaited: this runs on every save, and a save must not wait for
        // a process tree to be walked or a distro to answer. The refresh is
        // throttled and updates a cache the next save reads.
        void this.resume.refresh()
        const command = this.resume.commandFor(tab)
        if (command) {
            token.resumeCommand = command
        } else {
            delete token.resumeCommand
        }
    }

    async restore (token: RecoveryToken, params: NewTabParameters<BaseTabComponent>): Promise<void> {
        const command = String(token.resumeCommand ?? '')
        if (!command || !this.resume.enabled || this.adopted.has(token)) {
            return
        }
        params.inputs = params.inputs ?? {}
        params.inputs[RESUME_COMMAND_INPUT] = command
        if (resumesAgentSession(command)) {
            // A pane reopening an agent conversation must not also repaint the
            // scrollback saved from it: the agent redraws its own history on
            // startup, and both would leave the pane showing the same
            // transcript twice.
            params.inputs.savedState = null
        }
        this.resume.expectRestore()
    }

    /**
     * Every leaf token inside one adopted token, since a split tab's children
     * are recovered individually and each arrives here on its own.
     */
    private collectLeaves (token: any): void {
        if (!token || typeof token !== 'object') {
            return
        }
        if (Array.isArray(token.children)) {
            token.children.forEach((child: any) => this.collectLeaves(child))
            return
        }
        this.adopted.add(token)
    }
}
