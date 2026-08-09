import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

import { StithHealth } from '../api'
import { StithService } from '../services/stith.service'

/** @hidden */
@Component({
    selector: 'claude-settings-tab',
    templateUrl: './claudeSettingsTab.component.pug',
})
export class ClaudeSettingsTabComponent {
    health: StithHealth = 'never-tried'
    /** Result of the manual connection test, shown next to the URL field. */
    testResult: string | null = null
    testing = false

    constructor (
        public config: ConfigService,
        private stith: StithService,
    ) { }

    saveConfiguration (): void {
        this.config.save()
    }

    /**
     * Explicit connection test. The panel already reports reachability, but a
     * user editing the URL needs an answer without opening the panel and
     * waiting for a poll.
     */
    async testConnection (): Promise<void> {
        this.testing = true
        this.testResult = null
        try {
            const response = await fetch(`${this.stith.baseURL}/api/agents`, {
                headers: { accept: 'application/json' },
            })
            if (!response.ok) {
                this.testResult = `HTTP ${response.status}`
                return
            }
            const data = await response.json()
            const count = Array.isArray(data.agents) ? data.agents.length : 0
            this.testResult = `OK — ${count} session(s)`
        } catch (err) {
            this.testResult = String(err)
        } finally {
            this.testing = false
            this.stith.refreshNow()
        }
    }
}
