import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent, TabsService } from 'tabby-core'

import { LinkPreviewRequest, LinkPreviewTabComponent } from '../components/linkPreviewTab.component'

/**
 * Opens preview panes and knows how many are open.
 *
 * The second half is why this is a service and not a call in the decorator:
 * "suppress tooltips while a pane is open" is a question every terminal in
 * every window asks on every hover, and only something outside them all can
 * answer it.
 */
@Injectable({ providedIn: 'root' })
export class LinkPanesService {
    private open = new Set<LinkPreviewTabComponent>()
    /**
     * The pane already showing a preview for a given terminal, so pressing
     * "Show in pane" twice re-uses it instead of splitting the tab again.
     */
    private bySource = new Map<BaseTabComponent, LinkPreviewTabComponent>()

    constructor (
        private app: AppService,
        private config: ConfigService,
        private tabs: TabsService,
    ) { }

    get openCount (): number {
        return this.open.size
    }

    /**
     * Whether hover cards should stay away.
     *
     * Both halves are required: the setting on its own would silence the card
     * for ever, and a pane on its own is no reason to — plenty of people will
     * want both. Closing the last pane restores hovers without touching the
     * setting, which is what makes the switch safe to leave on.
     */
    tooltipsSuppressed (): boolean {
        return this.open.size > 0 && this.config.store.linkTooltip?.hideTooltipsWithPane === true
    }

    /**
     * Show `request` in a pane beside `source`.
     *
     * Beside, not instead: the terminal the link is in stays visible, which is
     * the whole difference between this and opening a tab.
     */
    async show (request: LinkPreviewRequest, source: BaseTabComponent | null): Promise<LinkPreviewTabComponent> {
        const existing = source ? this.bySource.get(source) : undefined
        if (existing) {
            existing.request = request
            existing.setTitle(request.text || 'Preview')
            await existing.load()
            this.focus(existing)
            return existing
        }

        const pane = this.tabs.create({
            type: LinkPreviewTabComponent,
            inputs: { request },
        })
        // A terminal is normally already inside a SplitTabComponent, which is
        // what makes this a pane. When it is not — a tab added raw — there is
        // nothing to split, so the preview becomes its own tab rather than
        // rearranging someone's window to make room for it.
        const parent = source ? this.app.getParentTab(source) : null
        if (parent instanceof SplitTabComponent && source) {
            await parent.addTab(pane, source, 'r')
        } else {
            this.app.addTabRaw(pane)
            this.app.selectTab(pane)
        }

        this.open.add(pane)
        if (source) {
            this.bySource.set(source, pane)
        }
        pane.destroyed$.subscribe(() => {
            this.open.delete(pane)
            if (source && this.bySource.get(source) === pane) {
                this.bySource.delete(source)
            }
        })
        return pane
    }

    private focus (pane: LinkPreviewTabComponent): void {
        const parent = this.app.getParentTab(pane)
        if (parent instanceof SplitTabComponent) {
            this.app.selectTab(parent)
            parent.focus(pane)
        } else {
            this.app.selectTab(pane)
        }
    }
}
