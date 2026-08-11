import { Injectable } from '@angular/core'
import { Observable } from 'rxjs'
import { ConfigService, ToolbarButton, ToolbarButtonProvider, TranslateService } from 'tabby-core'

import { NewBuildWatcherService } from './services/newBuildWatcher.service'

/**
 * The toolbar affordance for a newer build, and the thing that starts the
 * watcher.
 *
 * Toolbar providers are constructed at startup, which is what makes this the
 * natural home for a background watch — the same trick tabby-settings uses to
 * subscribe to its hotkey.
 */
@Injectable()
export class BuildsButtonProvider extends ToolbarButtonProvider {
    /** Tells the toolbar to ask again once a newer build has been spotted. */
    readonly changed$: Observable<void>

    constructor (
        config: ConfigService,
        private translate: TranslateService,
        private watcher: NewBuildWatcherService,
    ) {
        super()
        this.changed$ = watcher.changed$
        // Not in the constructor body directly: providers are built before the
        // config has loaded, so reading a setting here throws and takes the
        // whole boot down with it — the app comes up to a splash screen and
        // stays there.
        config.ready$.subscribe(() => this.watcher.start())
    }

    provide (): ToolbarButton[] {
        // Only present when there is something to say. A permanent button for
        // an event that happens twice a week is just clutter.
        if (!this.watcher.available) {
            return []
        }
        return [{
            icon: require('./icons/newBuild.svg'),
            title: this.translate.instant('A newer build is available'),
            weight: 5,
            click: () => void this.watcher.offer(),
        }]
    }
}
