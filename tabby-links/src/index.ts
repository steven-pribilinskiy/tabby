import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgbModule } from '@ng-bootstrap/ng-bootstrap'
import TabbyCoreModule, { ConfigProvider, ConfigService, PlatformService } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'

import { IntegrationsSettingsTabComponent } from './components/integrationsSettingsTab.component'
import { LinkHoverCardComponent } from './components/linkHoverCard.component'
import { LinkPreviewTabComponent } from './components/linkPreviewTab.component'
import { LinkPreviewViewComponent } from './components/linkPreviewView.component'
import { LinkTooltipSettingsTabComponent } from './components/linkTooltipSettingsTab.component'
import { LinksConfigProvider } from './config'
import { LinkTooltipDecorator } from './decorator'
import { IntegrationsSettingsTabProvider, LinkTooltipSettingsTabProvider } from './providers'
import { LinkClicksService } from './services/linkClicks.service'

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
        LinkPreviewTabComponent,
        LinkPreviewViewComponent,
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
        clicks: LinkClicksService,
    ) {
        // `PlatformService.openExternal` asks for confirmation for any scheme it
        // does not know, and it cannot read the config itself without a
        // dependency cycle. Pushing the list here keeps the setting live.
        const apply = () => {
            platform.extraSafeSchemes = config.store.linkTooltip?.safeSchemes ?? []
        }
        // The legacy modifier is carried onto the chords here rather than in the
        // decorator or the settings page, because both of those only exist once
        // you open a terminal or that page — and until it runs, an existing
        // `clickableLinks.modifier` and the chords are both live and disagreeing.
        //
        // On every change as well as at startup, because upstream's own Terminal
        // settings page still writes that key ("Require a key to click links").
        // Migrating only at startup would leave a control that appears to do
        // nothing and then overwrites the chords at the next launch. This way it
        // keeps working, as a shorthand: it takes effect at once, and springs
        // back to "No modifier" because the setting has moved.
        const migrate = () => clicks.migrateLegacyModifier()
        config.ready$.subscribe(() => {
            apply()
            migrate()
        })
        config.changed$.subscribe(() => {
            apply()
            migrate()
        })
    }
}

export * from './api'
export * from './clickChords'
export { LinkPreviewTabComponent, LinkPreviewRequest } from './components/linkPreviewTab.component'
export { IntegrationRegistryService } from './services/integrationRegistry.service'
export { IntegrationRuntimeService } from './services/integrationRuntime.service'
export { LinkClicksService } from './services/linkClicks.service'
export { LinkPanesService } from './services/linkPanes.service'
export { LinkRulesService } from './services/linkRules.service'
