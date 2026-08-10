import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { BuildsSettingsTabComponent } from './components/buildsSettingsTab.component'

@Injectable()
export class BuildsSettingsTabProvider extends SettingsTabProvider {
    id = 'builds'
    icon = 'cubes'
    title = 'Builds'

    getComponentType (): any {
        return BuildsSettingsTabComponent
    }
}
