import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider, SidePanelProvider, TabHoverProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { ClaudeHoverCardComponent } from './components/claudeHoverCard.component'
import { ClaudePanelComponent } from './components/claudePanel.component'
import { ClaudeSettingsTabComponent } from './components/claudeSettingsTab.component'
import { ClaudeConfigProvider } from './config'
import { ClaudeSettingsTabProvider, ClaudeSidePanelProvider, ClaudeTabHoverProvider } from './providers'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCoreModule,
    ],
    declarations: [
        ClaudePanelComponent,
        ClaudeHoverCardComponent,
        ClaudeSettingsTabComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: ClaudeConfigProvider, multi: true },
        { provide: SidePanelProvider, useClass: ClaudeSidePanelProvider, multi: true },
        { provide: TabHoverProvider, useClass: ClaudeTabHoverProvider, multi: true },
        { provide: SettingsTabProvider, useClass: ClaudeSettingsTabProvider, multi: true },
    ],
})
export default class ClaudeModule { } // eslint-disable-line @typescript-eslint/no-extraneous-class

export * from './api'
export { ClaudeSessionsService } from './services/claudeSessions.service'
export { StithService } from './services/stith.service'
export { TranscriptMetricsService } from './services/transcriptMetrics.service'
