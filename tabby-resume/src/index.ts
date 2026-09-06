import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider, TabRecoveryAugmentor } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { ResumeSettingsTabComponent } from './components/resumeSettingsTab.component'
import { ResumeConfigProvider } from './config'
import { ResumeSettingsTabProvider } from './providers'
import { ResumeRecoveryAugmentor } from './recoveryAugmentor'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCoreModule,
    ],
    declarations: [
        ResumeSettingsTabComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: ResumeConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: ResumeSettingsTabProvider, multi: true },
        { provide: TabRecoveryAugmentor, useClass: ResumeRecoveryAugmentor, multi: true },
    ],
})
export default class ResumeModule { } // eslint-disable-line @typescript-eslint/no-extraneous-class

export * from './recognize'
export * from './select'
export { ResumeRecoveryAugmentor } from './recoveryAugmentor'
export { PaneCaptureService, PaneProbe, CaptureResult, WSL_PROBE_SCRIPT } from './services/paneCapture.service'
export { SessionResumeService, RESUME_COMMAND_INPUT } from './services/sessionResume.service'
