import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider, ConfigService, PlatformService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'

import { IntegrationsSettingsTabComponent } from './components/integrationsSettingsTab.component'
import { LinkHoverCardComponent } from './components/linkHoverCard.component'
import { LinkTooltipSettingsTabComponent } from './components/linkTooltipSettingsTab.component'
import { LinksConfigProvider } from './config'
import { LinkTooltipDecorator } from './decorator'
import { IntegrationsSettingsTabProvider, LinkTooltipSettingsTabProvider } from './providers'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        NgbModule,
        TabbyCoreModule,
    ],
    declarations: [
        LinkHoverCardComponent,
        LinkTooltipSettingsTabComponent,
        IntegrationsSettingsTabComponent,
    ],
    providers: [
        { provide: ConfigProvider, useClass: LinksConfigProvider, multi: true },
        { provide: TerminalDecorator, useClass: LinkTooltipDecorator, multi: true },
        { provide: SettingsTabProvider, useClass: LinkTooltipSettingsTabProvider, multi: true },
        { provide: SettingsTabProvider, useClass: IntegrationsSettingsTabProvider, multi: true },
    ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export default class LinksModule {
    constructor (
        config: ConfigService,
        platform: PlatformService,
    ) {
        // `PlatformService.openExternal` asks for confirmation for any scheme it
        // does not know, and it cannot read the config itself without a
        // dependency cycle. Pushing the list here keeps the setting live.
        const apply = () => {
            platform.extraSafeSchemes = config.store.linkTooltip?.safeSchemes ?? []
        }
        config.ready$.subscribe(() => apply())
        config.changed$.subscribe(() => apply())
    }
}

export * from './api'
export { IntegrationRegistryService } from './services/integrationRegistry.service'
export { IntegrationRuntimeService } from './services/integrationRuntime.service'
export { LinkRulesService } from './services/linkRules.service'
