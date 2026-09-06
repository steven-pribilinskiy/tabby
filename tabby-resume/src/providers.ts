import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { ResumeSettingsTabComponent } from './components/resumeSettingsTab.component'

/** @hidden */
@Injectable()
export class ResumeSettingsTabProvider extends SettingsTabProvider {
    id = 'resume'
    icon = 'rotate-left'
    title = 'Resume'

    getComponentType (): any {
        return ResumeSettingsTabComponent
    }
}
