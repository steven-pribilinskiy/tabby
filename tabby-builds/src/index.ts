import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { BuildsSettingsTabComponent } from './components/buildsSettingsTab.component'
import { BuildsConfigProvider } from './config'
import { BuildsSettingsTabProvider } from './providers'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCoreModule,
    ],
    declarations: [
        BuildsSettingsTabComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: BuildsConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: BuildsSettingsTabProvider, multi: true },
    ],
})
export default class BuildsModule { } // eslint-disable-line @typescript-eslint/no-extraneous-class

export * from './api'
export { BuildActionsService } from './services/buildActions.service'
export { BuildProcessesService } from './services/buildProcesses.service'
export { BuildScannerService } from './services/buildScanner.service'
export { BuildSizeService } from './services/buildSize.service'
