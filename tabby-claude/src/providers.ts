import { Injectable } from '@angular/core'
import { BaseTabComponent, ConfigService, SidePanelProvider, TabHoverProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { ClaudeHoverCardComponent } from './components/claudeHoverCard.component'
import { ClaudePanelComponent } from './components/claudePanel.component'
import { ClaudeSettingsTabComponent } from './components/claudeSettingsTab.component'
import { ClaudeSessionsService } from './services/claudeSessions.service'

@Injectable()
export class ClaudeSidePanelProvider extends SidePanelProvider {
    id = 'claude'
    name = 'Claude'
    weight = 10

    getComponentType (): any {
        return ClaudePanelComponent
    }
}

@Injectable()
export class ClaudeTabHoverProvider extends TabHoverProvider {
    weight = 10

    constructor (
        private claude: ClaudeSessionsService,
        private config: ConfigService,
    ) {
        super()
    }

    /**
     * Called on every hover, so it must stay cheap — this is a map lookup
     * against the last poll, never a fetch or a file read.
     */
    isApplicable (tab: BaseTabComponent): boolean {
        if (!this.config.store.claude?.hover?.enabled) {
            return false
        }
        return !!this.claude.forTab(tab)
    }

    getComponentType (): any {
        return ClaudeHoverCardComponent
    }
}

@Injectable()
export class ClaudeSettingsTabProvider extends SettingsTabProvider {
    id = 'claude'
    icon = 'robot'
    title = 'Claude'

    getComponentType (): any {
        return ClaudeSettingsTabComponent
    }
}
