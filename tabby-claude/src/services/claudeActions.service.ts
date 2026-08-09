import { Injectable } from '@angular/core'
import { ConfigService, MenuItemOptions, PlatformService, ProfilesService, TranslateService } from 'tabby-core'

import { ClaudeSession } from '../api'
import { sessionTitle } from '../format'
import { ClaudeSessionsService } from './claudeSessions.service'
import { StithService } from './stith.service'

/** Actions offered for a session, by config id. */
export type ClaudeSessionAction = 'focus' | 'details' | 'newTab' | 'resume' | 'stith'

/**
 * Everything you can do to a session from the panel.
 *
 * Kept out of the component so the row click, the kebab menu and the row's
 * context menu all run exactly the same code — the click action is just
 * whichever menu entry the user nominated as the default.
 */
@Injectable({ providedIn: 'root' })
export class ClaudeActionsService {
    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private profiles: ProfilesService,
        private sessions: ClaudeSessionsService,
        private stith: StithService,
        private translate: TranslateService,
    ) { }

    /**
     * Menu for a session. `onDetails` is a callback because expanding the
     * details view is the panel's own state, not something this service owns.
     */
    buildMenu (session: ClaudeSession, onDetails: () => void): MenuItemOptions[] {
        const canFocus = this.sessions.hasTabFor(session)
        return [
            {
                label: this.translate.instant('Focus tab'),
                enabled: canFocus,
                click: () => this.run('focus', session, onDetails),
            },
            {
                label: this.translate.instant('Show details'),
                click: () => this.run('details', session, onDetails),
            },
            { type: 'separator' },
            {
                label: this.translate.instant('Open new tab here'),
                click: () => this.run('newTab', session, onDetails),
            },
            {
                label: this.translate.instant('Resume in new tab'),
                click: () => this.run('resume', session, onDetails),
            },
            { type: 'separator' },
            {
                label: this.translate.instant('Copy session ID'),
                click: () => this.platform.setClipboard({ text: session.sessionId }),
            },
            {
                label: this.translate.instant('Copy resume command'),
                click: () => this.platform.setClipboard({ text: this.resumeCommand(session) }),
            },
            {
                label: this.translate.instant('Open in stith'),
                click: () => this.run('stith', session, onDetails),
            },
        ]
    }

    popupMenu (session: ClaudeSession, onDetails: () => void, event?: MouseEvent): void {
        this.platform.popupContextMenu(this.buildMenu(session, onDetails), event)
    }

    /** The configured default, used for a plain click on a row. */
    runDefault (session: ClaudeSession, onDetails: () => void): void {
        const action = this.config.store.claude.clickAction as ClaudeSessionAction
        this.run(action, session, onDetails)
    }

    run (action: ClaudeSessionAction, session: ClaudeSession, onDetails: () => void): void {
        switch (action) {
            case 'details':
                onDetails()
                break
            case 'newTab':
                void this.openTabFor(session, false)
                break
            case 'resume':
                void this.openTabFor(session, true)
                break
            case 'stith':
                void this.platform.openExternal(`${this.stith.baseURL}/s/${session.sessionId}`)
                break
            case 'focus':
            default:
                // Falling back to stith rather than doing nothing: a session on
                // another machine, or in another Tabby window, has no tab here.
                if (!this.sessions.revealTab(session)) {
                    void this.platform.openExternal(`${this.stith.baseURL}/s/${session.sessionId}`)
                }
                break
        }
    }

    /**
     * The command that reattaches to a session.
     *
     * Runs in the launch directory, not the session's reported one: Claude
     * finds a session by encoding the directory it was started in, so
     * `--resume` from anywhere else fails with "No conversation found".
     */
    resumeCommand (session: ClaudeSession): string {
        const dir = this.sessions.launchDirectory(session)
        const windows = /^[a-zA-Z]:[\\/]/.test(dir)
        const cd = windows ? `cd /d "${dir}"` : `cd "${dir}"`
        return `${cd} && claude --resume ${session.sessionId}`
    }

    /**
     * Open a terminal in the session's directory, optionally resuming into it.
     * The profile is chosen to match the session's environment: a WSL session
     * needs a WSL profile, or the shell would open on the Windows side and the
     * Linux path would not exist.
     */
    private async openTabFor (session: ClaudeSession, resume: boolean): Promise<void> {
        const profile = await this.pickProfile(session)
        if (!profile) {
            return
        }
        // The launch directory rather than the drifted one: it is the project
        // root, and it is where a resume has to run from.
        profile.options = { ...profile.options, cwd: this.sessions.launchDirectory(session) }
        const tab = await this.profiles.openNewTabForProfile(profile)
        if (!resume || !tab) {
            return
        }
        // Wait before typing: a cold WSL distro or a slow shell profile is not
        // accepting input yet, and early keystrokes vanish into the prompt
        // redraw.
        const delay = (this.config.store.claude.resumeInputDelaySec ?? 1.5) * 1000
        setTimeout(() => {
            try {
                // Structurally typed: sendInput belongs to terminal tabs, and a
                // profile could in principle open something else entirely.
                const terminal = tab as unknown as { sendInput?: (data: string) => void }
                terminal.sendInput?.(`claude --resume ${session.sessionId}\n`)
            } catch {
                // Not a terminal tab, or it closed while we waited.
            }
        }, delay)
    }

    private async pickProfile (session: ClaudeSession): Promise<any | null> {
        const all = await this.profiles.getProfiles({ clone: true })
        const local = all.filter(x => x.type === 'local')
        if (!local.length) {
            return null
        }
        const wantsWSL = !!session.wslDistro || session.cwd.startsWith('/')
        const isWSL = (profile: any): boolean => {
            const command = String(profile.options?.command ?? '')
            return /wsl(\.exe)?"?$/i.test(command.trim()) || /wsl\.exe/i.test(command)
        }
        const matching = local.filter(x => isWSL(x) === wantsWSL)
        // A distro-specific profile beats a generic one when we know the distro.
        if (wantsWSL && session.wslDistro) {
            const exact = matching.find(x =>
                (x.options?.args ?? []).some((a: string) => a === session.wslDistro))
            if (exact) {
                return exact
            }
        }
        return matching[0] ?? local[0]
    }

    /** Human-readable label for the configured default, for the settings UI. */
    labelFor (action: ClaudeSessionAction): string {
        switch (action) {
            case 'details': return this.translate.instant('Show details')
            case 'newTab': return this.translate.instant('Open new tab here')
            case 'resume': return this.translate.instant('Resume in new tab')
            case 'stith': return this.translate.instant('Open in stith')
            default: return this.translate.instant('Focus tab')
        }
    }

    /** Title used by the details header. */
    titleFor (session: ClaudeSession): string {
        return sessionTitle(session)
    }
}
