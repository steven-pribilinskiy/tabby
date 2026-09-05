import { Injectable } from '@angular/core'
import { BaseTabComponent, ConfigService, HostAppService, MenuItemOptions, NotificationsService, Platform, PlatformService, TabContextMenuItemProvider, TranslateService } from 'tabby-core'
import { BaseTerminalTabComponent } from './api/baseTerminalTab.component'

/**
 * Where the selection goes in `terminal.webSearchQueryURL`.
 *
 * `{{name}}` rather than Windows Terminal's `%s`, because that is already this
 * repo's template syntax everywhere a URL is built from matched text - see the
 * integration manifests in `tabby-links`.
 */
export const WEB_SEARCH_TOKEN = '{{query}}'

/**
 * Longest selection turned into a query. A search engine truncates far below
 * this anyway, and it keeps the URL well inside every limit a shell, a browser
 * and `ShellExecute` impose - a terminal selection can be megabytes.
 */
export const MAX_QUERY_LENGTH = 512

/** How much of the selection the menu item quotes back. */
export const MAX_LABEL_LENGTH = 40

/**
 * A stand-in for the selection, used to parse the template on its own. It only
 * has to be inert in every URL component, so it is bare ASCII letters.
 */
const PROBE = 'tabbywebsearchprobe'

/**
 * The selection as a query: whitespace runs collapsed to single spaces, so a
 * multi-line selection searches as ordinary terms and the menu label stays one
 * line. Same normalisation Windows Terminal's `searchWeb` does.
 */
export function normalizeQuery (selection: string): string {
    return selection.replace(/\s+/g, ' ').trim().substring(0, MAX_QUERY_LENGTH)
}

/**
 * The URL to open, or null if this template must not be opened.
 *
 * The selection is text a remote host printed, so it is percent-encoded and the
 * result is then re-parsed: the URL that opens has to have the same scheme and
 * origin as the template alone does, which is what stops a crafted selection
 * becoming a different host, a second parameter or another scheme. A template
 * that does not parse, carries no `{{query}}`, or is not http(s) yields null
 * rather than something unexpected.
 */
export function buildSearchURL (template: unknown, selection: string): string | null {
    const query = normalizeQuery(selection)
    if (!query || typeof template !== 'string' || !template.includes(WEB_SEARCH_TOKEN)) {
        return null
    }
    const substitute = (value: string) => template.split(WEB_SEARCH_TOKEN).join(value)
    try {
        const probe = new URL(substitute(PROBE))
        const candidate = new URL(substitute(encodeURIComponent(query)))
        if (probe.protocol !== 'http:' && probe.protocol !== 'https:') {
            return null
        }
        if (candidate.protocol !== probe.protocol || candidate.origin !== probe.origin) {
            return null
        }
        return candidate.href
    } catch {
        return null
    }
}

/**
 * The selection as the menu item shows it: cut to something recognisable, and
 * with `&` doubled where the platform's menus read it as a mnemonic - a label
 * of `foo & bar` otherwise loses the ampersand and underlines the space.
 */
export function menuLabelQuery (query: string, escapeMnemonics: boolean): string {
    const text = query.length > MAX_LABEL_LENGTH
        ? `${query.substring(0, MAX_LABEL_LENGTH - 1)}…`
        : query
    return escapeMnemonics ? text.replace(/&/g, '&&') : text
}

/** @hidden */
@Injectable()
export class WebSearchContextMenu extends TabContextMenuItemProvider {
    weight = -9

    constructor (
        private config: ConfigService,
        private hostApp: HostAppService,
        private notifications: NotificationsService,
        private platform: PlatformService,
        private translate: TranslateService,
    ) {
        super()
    }

    async getItems (tab: BaseTabComponent, tabHeader?: boolean): Promise<MenuItemOptions[]> {
        if (tabHeader) {
            return []
        }
        if (!(tab instanceof BaseTerminalTabComponent)) {
            return []
        }
        // getItems() runs when the menu pops up, so this is the live selection.
        const query = normalizeQuery(tab.frontend?.getSelection() ?? '')
        if (!query) {
            return []
        }
        return [
            {
                label: this.translate.instant('Search the web for "{query}"', {
                    query: menuLabelQuery(query, this.hostApp.platform !== Platform.macOS),
                }),
                click: () => this.search(query),
            },
        ]
    }

    private async search (query: string): Promise<void> {
        const url = buildSearchURL(this.config.store.terminal.webSearchQueryURL, query)
        if (!url) {
            this.notifications.error(this.translate.instant(
                'The web search URL must be an http(s) URL containing {token}',
                { token: WEB_SEARCH_TOKEN },
            ))
            return
        }
        await this.platform.openExternal(url)
    }
}
