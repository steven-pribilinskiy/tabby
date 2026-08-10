import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { BuildsSettingsTabComponent } from './components/buildsSettingsTab.component'

@Injectable()
export class BuildsSettingsTabProvider extends SettingsTabProvider {
    id = 'builds'
    icon = 'cubes'
    title = 'Builds'
    /** A table of eleven columns including full paths; 600px would gut it. */
    wide = true

    getComponentType (): any {
        return BuildsSettingsTabComponent
    }
}
