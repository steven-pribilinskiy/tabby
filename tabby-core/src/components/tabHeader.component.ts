/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Component, Input, Optional, Inject, HostBinding, HostListener, NgZone, ViewChild, ElementRef } from '@angular/core'
import { auditTime } from 'rxjs'
import { TabContextMenuItemProvider } from '../api/tabContextMenuProvider'
import { TabHoverProvider } from '../api/tabHoverProvider'
import { BaseTabComponent } from './baseTab.component'
import { SplitTabComponent } from './splitTab.component'
import { HotkeysService } from '../services/hotkeys.service'
import { AppService } from '../services/app.service'
import { HostAppService, Platform } from '../api/hostApp'
import { ConfigService } from '../services/config.service'
import { BaseComponent } from './base.component'
import { MenuItemOptions } from '../api/menu'
import { PlatformService } from '../api/platform'

/** @hidden */
@Component({
    selector: 'tab-header',
    templateUrl: './tabHeader.component.pug',
    styleUrls: ['./tabHeader.component.scss'],
})
export class TabHeaderComponent extends BaseComponent {
    @Input() index: number
    @Input() @HostBinding('class.active') active: boolean
    @Input() tab: BaseTabComponent
    @Input() progress: number|null
    Platform = Platform

    /**
     * Whether the title is actually clipped. The tab tooltip just repeated a
     * fully-visible title otherwise, which is noise. Measured on hover rather
     * than per change-detection cycle so reading scrollWidth cannot thrash
     * layout — the global 250ms tooltip openDelay means this always lands
     * before the tooltip is shown.
     */
    titleTruncated = false

    /**
     * The provider supplying this tab's hover card, if any. Resolved on
     * mouseenter rather than during change detection so `isApplicable` is
     * called once per hover instead of once per tab per cycle; the hover card's
     * open delay is far longer than the gap between this and the popover
     * opening.
     */
    hoverProvider: TabHoverProvider|null = null

    @ViewChild('nameEl') private nameEl?: ElementRef<HTMLElement>

    @HostListener('mouseenter')
    onMouseEnter (): void {
        this.updateTitleTruncation()
        this.hoverProvider = this.hoverProviders?.find(provider => {
            try {
                return provider.isApplicable(this.tab)
            } catch {
                // A broken provider must not take the tab bar down with it.
                return false
            }
        }) ?? null
    }

    /**
     * Where the hover card opens: off the edge opposite the tab bar, so it
     * never covers the bar itself, falling back to `auto` when there is no
     * room there.
     */
    get hoverPlacement (): string {
        switch (this.config.store.appearance.tabsLocation) {
            case 'left': return 'right auto'
            case 'right': return 'left auto'
            case 'bottom': return 'top auto'
            default: return 'bottom auto'
        }
    }

    updateTitleTruncation (): void {
        const el = this.nameEl?.nativeElement
        // 1px of tolerance: sub-pixel text metrics can leave scrollWidth a
        // fraction above clientWidth on a title that is not visibly clipped.
        this.titleTruncated = !!el && el.scrollWidth > el.clientWidth + 1
    }

    constructor (
        public app: AppService,
        public config: ConfigService,
        public hostApp: HostAppService,
        private hotkeys: HotkeysService,
        private platform: PlatformService,
        private zone: NgZone,
        @Optional() @Inject(TabContextMenuItemProvider) protected contextMenuProviders: TabContextMenuItemProvider[],
        @Optional() @Inject(TabHoverProvider) private hoverProviders: TabHoverProvider[]|null,
    ) {
        super()
        this.hoverProviders?.sort((a, b) => a.weight - b.weight)
        this.subscribeUntilDestroyed(this.hotkeys.hotkey$, (hotkey) => {
            if (this.app.activeTab === this.tab) {
                if (hotkey === 'rename-tab') {
                    this.app.renameTab(this.tab)
                }
            }
        })
        this.contextMenuProviders.sort((a, b) => a.weight - b.weight)
    }

    ngOnInit () {
        this.subscribeUntilDestroyed(this.tab.progress$.pipe(
            auditTime(300),
        ), progress => {
            this.zone.run(() => {
                this.progress = progress
            })
        })
    }

    async buildContextMenu (): Promise<MenuItemOptions[]> {
        let items: MenuItemOptions[] = []
        // Top-level tab menu
        for (const section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(this.tab, true)))) {
            items.push({ type: 'separator' })
            items = items.concat(section)
        }
        if (this.tab instanceof SplitTabComponent) {
            const tab = this.tab.getFocusedTab()
            if (tab) {
                for (let section of await Promise.all(this.contextMenuProviders.map(x => x.getItems(tab, true)))) {
                    // eslint-disable-next-line @typescript-eslint/no-loop-func
                    section = section.filter(item => !items.some(ex => ex.label === item.label))
                    if (section.length) {
                        items.push({ type: 'separator' })
                        items = items.concat(section)
                    }
                }
            }
        }
        return items.slice(1)
    }

    onTabDragStart (tab: BaseTabComponent) {
        this.app.emitTabDragStarted(tab)
    }

    onTabDragEnd () {
        setTimeout(() => {
            this.app.emitTabDragEnded()
            this.app.emitTabsChanged()
        })
    }

    @HostBinding('class.flex-width') get isFlexWidthEnabled (): boolean {
        return this.config.store.appearance.flexTabs
    }

    @HostListener('dblclick', ['$event']) onDoubleClick ($event: MouseEvent): void {
        this.app.renameTab(this.tab)
        $event.stopPropagation()
    }

    @HostListener('mousedown', ['$event']) async onMouseDown ($event: MouseEvent) {
        if ($event.which === 2) {
            $event.preventDefault()
        }
    }

    @HostListener('mouseup', ['$event']) async onMouseUp ($event: MouseEvent) {
        if ($event.which === 2) {
            this.app.closeTab(this.tab, true)
        }
    }

    @HostListener('contextmenu', ['$event']) async onContextMenu ($event: MouseEvent) {
        $event.preventDefault()
        this.platform.popupContextMenu(await this.buildContextMenu(), $event)
    }
}
