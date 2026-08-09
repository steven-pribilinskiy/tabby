import { Component, Inject, Optional, ViewChild, ViewContainerRef, ComponentFactoryResolver, ComponentRef, HostBinding, HostListener, NgZone } from '@angular/core'

import { SidePanelProvider } from '../api/sidePanelProvider'
import { ConfigService } from '../services/config.service'
import { BaseComponent } from './base.component'

export type SidePanelSide = 'left' | 'right' | 'top' | 'bottom'

const MIN_SIZE = 160
const MAX_SIZE = 900

/**
 * Hosts whichever [[SidePanelProvider]] is selected, and owns the chrome around
 * it: the header, the edge picker and the resize handle.
 *
 * The host places itself via a CSS grid area on the app root rather than by
 * being reordered in the DOM, so switching edges never re-creates the panel
 * component — a panel that is polling or holding scroll state keeps it.
 */
@Component({
    selector: 'side-panel-host',
    templateUrl: './sidePanelHost.component.pug',
    styleUrls: ['./sidePanelHost.component.scss'],
})
export class SidePanelHostComponent extends BaseComponent {
    providers: SidePanelProvider[] = []
    activeProvider: SidePanelProvider | null = null

    /** Live size while dragging; null when not dragging. */
    dragSize: number | null = null

    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder?: ViewContainerRef

    private component: ComponentRef<any> | null = null
    private renderedProviderId: string | null = null
    private resizeStart: { pointer: number, size: number } | null = null

    constructor (
        public config: ConfigService,
        private componentFactoryResolver: ComponentFactoryResolver,
        private zone: NgZone,
        @Optional() @Inject(SidePanelProvider) providers: SidePanelProvider[]|null,
    ) {
        super()
        this.providers = (providers ?? []).sort((a, b) => a.weight - b.weight)
    }

    ngOnInit (): void {
        this.subscribeUntilDestroyed(this.config.changed$, () => this.syncActiveProvider())
        this.syncActiveProvider()
    }

    ngAfterViewInit (): void {
        setImmediate(() => this.render())
    }

    get side (): SidePanelSide {
        return this.config.store.sidePanel.side
    }

    get isVertical (): boolean {
        return this.side === 'top' || this.side === 'bottom'
    }

    get size (): number {
        return this.dragSize ?? this.config.store.sidePanel.size
    }

    @HostBinding('class.dragging') get dragging (): boolean {
        return this.resizeStart !== null
    }

    // The app root lays panels out with `auto`-sized grid tracks, so the host
    // sizing itself is what sizes the track. That keeps the drag entirely
    // inside this component instead of writing a CSS variable onto a parent.
    @HostBinding('style.width.px') get hostWidth (): number|null {
        return this.isVertical ? null : this.size
    }

    @HostBinding('style.height.px') get hostHeight (): number|null {
        return this.isVertical ? this.size : null
    }

    // Drives which edge the resize handle attaches to.
    @HostBinding('class.side-left') get sideLeft (): boolean { return this.side === 'left' }
    @HostBinding('class.side-right') get sideRight (): boolean { return this.side === 'right' }
    @HostBinding('class.side-top') get sideTop (): boolean { return this.side === 'top' }
    @HostBinding('class.side-bottom') get sideBottom (): boolean { return this.side === 'bottom' }

    get availableProviders (): SidePanelProvider[] {
        return this.providers.filter(x => x.isAvailable())
    }

    setSide (side: SidePanelSide): void {
        this.config.store.sidePanel.side = side
        this.config.save()
    }

    selectProvider (provider: SidePanelProvider): void {
        this.config.store.sidePanel.activePanel = provider.id
        this.config.save()
        this.syncActiveProvider()
        this.render()
    }

    close (): void {
        this.config.store.sidePanel.enabled = false
        this.config.save()
    }

    // ── Resizing ──────────────────────────────────────────────────────
    // Mirrors the profile tree's handle: capture on mousedown, follow on
    // document mousemove so the pointer may leave the 4px strip mid-drag.

    onHandleMouseDown (event: MouseEvent): void {
        this.resizeStart = {
            pointer: this.isVertical ? event.clientY : event.clientX,
            size: this.size,
        }
        this.dragSize = this.size
        document.body.classList.add(this.isVertical ? 'side-panel-resizing-v' : 'side-panel-resizing-h')
        event.preventDefault()
    }

    @HostListener('document:mousemove', ['$event'])
    onMouseMove (event: MouseEvent): void {
        if (!this.resizeStart) {
            return
        }
        const pointer = this.isVertical ? event.clientY : event.clientX
        // A panel docked at the far edge grows as the pointer moves *towards*
        // the centre, so the delta is inverted for right/bottom.
        const towardsCentre = this.side === 'right' || this.side === 'bottom' ? -1 : 1
        const delta = (pointer - this.resizeStart.pointer) * towardsCentre
        this.dragSize = Math.min(MAX_SIZE, Math.max(MIN_SIZE, this.resizeStart.size + delta))
    }

    @HostListener('document:mouseup')
    onMouseUp (): void {
        if (!this.resizeStart) {
            return
        }
        this.resizeStart = null
        document.body.classList.remove('side-panel-resizing-v', 'side-panel-resizing-h')
        if (this.dragSize !== null) {
            this.config.store.sidePanel.size = Math.round(this.dragSize)
            this.config.save()
        }
        this.dragSize = null
    }

    onHandleDoubleClick (): void {
        this.config.store.sidePanel.size = this.config.getDefaults().sidePanel.size
        this.config.save()
    }

    private syncActiveProvider (): void {
        const available = this.availableProviders
        const wanted = this.config.store.sidePanel.activePanel
        // Falls back to the first available panel so a config naming a panel
        // that is gone (uninstalled, or turned off) still shows something.
        const next: SidePanelProvider|null =
            available.find(x => x.id === wanted) ?? (available.length ? available[0] : null)
        if (next !== this.activeProvider) {
            this.activeProvider = next
            // Defer: config.changed$ can fire mid-change-detection, and
            // creating a component synchronously from there would mutate the
            // view being checked.
            this.zone.run(() => setImmediate(() => this.render()))
        }
    }

    private render (): void {
        if (!this.placeholder) {
            return
        }
        if (this.activeProvider && this.renderedProviderId === this.activeProvider.id) {
            return
        }
        this.component?.destroy()
        this.component = null
        this.renderedProviderId = null
        this.placeholder.clear()
        if (!this.activeProvider) {
            return
        }
        this.component = this.placeholder.createComponent(
            this.componentFactoryResolver.resolveComponentFactory(
                this.activeProvider.getComponentType(),
            ),
        )
        this.renderedProviderId = this.activeProvider.id
    }

    ngOnDestroy (): void {
        super.ngOnDestroy()
        this.component?.destroy()
    }
}
