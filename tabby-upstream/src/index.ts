import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { UpstreamSettingsTabComponent } from './components/upstreamSettingsTab.component'
import { UpstreamConfigProvider } from './config'
import { UpstreamSettingsTabProvider } from './providers'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCoreModule,
    ],
    declarations: [
        UpstreamSettingsTabComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: UpstreamConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: UpstreamSettingsTabProvider, multi: true },
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class UpstreamModule { }
