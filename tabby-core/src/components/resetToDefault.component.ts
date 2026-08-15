/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import deepEqual from 'deep-equal'
import { Component, Input } from '@angular/core'
import { ConfigService } from '../services/config.service'

/**
 * A "revert this setting" button that is only there while the setting differs
 * from its default. Drop it into a `.form-line` just before the control:
 *
 *     reset-to-default([proxy]='config.store.terminal', key='minimumContrastRatio')
 *
 * @hidden
 */
@Component({
    selector: 'reset-to-default',
    template: `
        <button
            *ngIf="!isDefault"
            type="button"
            class="btn btn-link btn-sm text-decoration-none px-2"
            [ngbTooltip]="'Reset to default' | translate"
            (click)="reset()"
        >
            <i class="fas fa-fw fa-rotate-left"></i>
        </button>
    `,
})
export class ResetToDefaultComponent {
    /** The config subtree holding the setting, e.g. `config.store.terminal` */
    @Input() proxy: any

    /** The setting's key within that subtree */
    @Input() key: string

    constructor (
        private config: ConfigService,
    ) { }

    get isDefault (): boolean {
        return deepEqual(this.proxy[this.key], this.proxy.__getDefault(this.key))
    }

    reset (): void {
        // ConfigProxy drops a key from the stored config once it equals its
        // default, so this leaves nothing behind in config.yaml either.
        this.proxy[this.key] = this.proxy.__getDefault(this.key)
        this.config.save()
    }
}
