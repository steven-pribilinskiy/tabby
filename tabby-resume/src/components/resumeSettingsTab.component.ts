import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

import { AGENT_TABLE, MULTIPLEXERS } from '../recognize'

/** @hidden */
@Component({
    selector: 'resume-settings-tab',
    templateUrl: './resumeSettingsTab.component.pug',
})
export class ResumeSettingsTabComponent {
    /** Named on the page, because "known agents" is otherwise a promise with no receipt. */
    readonly agents = AGENT_TABLE.map(x => x.name).join(', ')
    readonly multiplexers = MULTIPLEXERS.join(', ')

    constructor (
        public config: ConfigService,
    ) { }

    /**
     * The two lists are edited as comma-separated text.
     *
     * A row-per-entry editor would be the richer control, but these lists are
     * program names — short, few, and most often pasted or typed in one go.
     */
    get extraPrograms (): string {
        return (this.config.store.resume.extraPrograms ?? []).join(', ')
    }

    set extraPrograms (value: string) {
        this.config.store.resume.extraPrograms = this.parseList(value)
    }

    get excludedPrograms (): string {
        return (this.config.store.resume.excludedPrograms ?? []).join(', ')
    }

    set excludedPrograms (value: string) {
        this.config.store.resume.excludedPrograms = this.parseList(value)
    }

    saveConfiguration (): void {
        this.config.save()
    }

    private parseList (value: string): string[] {
        return String(value)
            .split(/[,\s]+/)
            .map(x => x.trim())
            .filter(x => x)
    }
}
