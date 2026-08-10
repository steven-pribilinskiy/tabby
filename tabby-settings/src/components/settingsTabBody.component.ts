import { Component, HostBinding, Input, ViewContainerRef, ViewChild, ComponentFactoryResolver, ComponentRef } from '@angular/core'
import { SettingsTabProvider } from '../api'

/** @hidden */
@Component({
    selector: 'settings-tab-body',
    template: '<ng-template #placeholder></ng-template>',
    styles: [`
        :host {
            display: block;
            padding-bottom: 20px;
            max-width: 600px;
        }

        :host(.wide) {
            max-width: none;
        }
    `],
})
export class SettingsTabBodyComponent {
    @Input() provider: SettingsTabProvider
    @ViewChild('placeholder', { read: ViewContainerRef }) placeholder: ViewContainerRef
    component: ComponentRef<unknown>

    /** Tabs that show data rather than a form opt out of the reading-width cap. */
    @HostBinding('class.wide') get wide (): boolean {
        return this.provider.wide
    }

    constructor (private componentFactoryResolver: ComponentFactoryResolver) { }

    ngAfterViewInit (): void {
        // run after the change detection finishes
        setImmediate(() => {
            this.component = this.placeholder.createComponent(
                this.componentFactoryResolver.resolveComponentFactory(
                    this.provider.getComponentType(),
                ),
            )
        })
    }
}
