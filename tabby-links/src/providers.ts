import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { IntegrationsSettingsTabComponent } from './components/integrationsSettingsTab.component'
import { LinkTooltipSettingsTabComponent } from './components/linkTooltipSettingsTab.component'

@Injectable()
export class LinkTooltipSettingsTabProvider extends SettingsTabProvider {
    id = 'link-tooltip'
    icon = 'link'
    title = 'Link Tooltip'

    getComponentType (): any {
        return LinkTooltipSettingsTabComponent
    }
}

@Injectable()
export class IntegrationsSettingsTabProvider extends SettingsTabProvider {
    id = 'integrations'
    icon = 'plug'
    title = 'Integrations'

    getComponentType (): any {
        return IntegrationsSettingsTabComponent
    }
}
