import { Component, Input, ViewChild, ViewContainerRef, ComponentFactoryResolver, ComponentRef } from '@angular/core'

import { TabHoverProvider } from '../api/tabHoverProvider'
import { BaseTabComponent } from './baseTab.component'

/**
 * Renders a [[TabHoverProvider]]'s component inside a tab header's hover card.
 *
 * Angular 15's `ngComponentOutlet` cannot bind inputs, so the component is
 * created imperatively and given its `tab` — the same approach
 * `settings-tab-body` uses for settings pages.
 */
@Component({
    selector: 'tab-hover-host',
    template: '<ng-template #placeholder></ng-template>',
})
export class TabHoverHostComponent {
    @Input() tab: BaseTabComponent
    // Optional in the type because the popover's context is bound from a
    // getter that can be null between a hover starting and the card opening.
    @Input() provider?: TabHoverProvider

    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder?: ViewContainerRef

    private component: ComponentRef<any> | null = null

    constructor (private componentFactoryResolver: ComponentFactoryResolver) { }

    ngAfterViewInit (): void {
        setImmediate(() => {
            if (!this.placeholder || !this.provider) {
                return
            }
            this.component = this.placeholder.createComponent(
                this.componentFactoryResolver.resolveComponentFactory(
                    this.provider.getComponentType(),
                ),
            )
            this.component.instance.tab = this.tab
            this.component.changeDetectorRef.markForCheck()
        })
    }

    ngOnDestroy (): void {
        this.component?.destroy()
    }
}
