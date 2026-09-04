import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { UpstreamSettingsTabComponent } from './components/upstreamSettingsTab.component'

@Injectable()
export class UpstreamSettingsTabProvider extends SettingsTabProvider {
    id = 'upstream'
    icon = 'code-branch'
    title = 'Upstream'

    getComponentType (): any {
        return UpstreamSettingsTabComponent
    }
}
