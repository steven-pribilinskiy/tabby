import { Injectable } from '@angular/core'
import { CommandService, ConfigService, NotificationsService, PlatformService, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

import { LinkTooltipAction } from '../api'
import { schemeOf } from './linkRules.service'

/** Schemes `PlatformService.openExternal` already opens without asking. */
const ALWAYS_SAFE = ['http', 'https', 'ftp', 'mailto']

@Injectable({ providedIn: 'root' })
export class LinkActionsService {
    constructor (
        private platform: PlatformService,
        private config: ConfigService,
        private commands: CommandService,
        private notifications: NotificationsService,
        private translate: TranslateService,
    ) { }

    /** Extra schemes the user marked as safe on the Link Tooltip page. */
    safeSchemes (): string[] {
        const configured: string[] = this.config.store.linkTooltip?.safeSchemes ?? []
        return [...ALWAYS_SAFE, ...configured.map(x => x.trim().toLowerCase()).filter(x => x)]
    }

    isSafeScheme (uri: string): boolean {
        return this.safeSchemes().includes(schemeOf(uri))
    }

    async open (uri: string, filePath: string): Promise<void> {
        try {
            if (filePath) {
                // Not `openExternal('file://' + p)`: on Windows that yields
                // `file://C:\foo\bar`, which is not a valid URI and silently
                // does nothing. `openPath` takes a real path.
                this.platform.openPath(filePath)
                return
            }
            await this.platform.openExternal(uri)
        } catch (err) {
            this.notifications.error(`${err}`)
        }
    }

    copy (text: string): void {
        this.platform.setClipboard({ text })
        this.notifications.notice(this.translate.instant('Copied'))
    }

    reveal (filePath: string): void {
        this.platform.showItemInFolder(filePath)
    }

    /**
     * A custom tooltip button. `%u` is replaced with the hovered URI, matching
     * the substitution the Windows Terminal fork applies to its own actions —
     * an action with no `%u` in it simply runs unmodified.
     */
    async runCustom (action: LinkTooltipAction, uri: string, tab: BaseTerminalTabComponent<any> | null): Promise<void> {
        const value = action.value.split('%u').join(uri)
        try {
            switch (action.type) {
                case 'openUrl':
                    await this.platform.openExternal(value)
                    break
                case 'sendInput':
                    tab?.sendInput(value)
                    break
                case 'command':
                    await this.commands.run(value, { tab: tab ?? undefined } as any)
                    break
                default:
                    this.notifications.error(`Unknown link action type "${action.type}"`)
            }
        } catch (err) {
            this.notifications.error(`${err}`)
        }
    }
}
