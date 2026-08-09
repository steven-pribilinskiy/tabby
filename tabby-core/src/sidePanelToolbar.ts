import { Inject, Injectable, Optional } from '@angular/core'
import { TranslateService } from '@ngx-translate/core'

import { SidePanelProvider } from './api/sidePanelProvider'
import { ToolbarButton, ToolbarButtonProvider } from './api/toolbarButtonProvider'
import { ConfigService } from './services/config.service'

/**
 * Toolbar toggle for the docked panel.
 *
 * The panel ships off by default, so without a visible affordance the only way
 * to reach it would be the config file. The button hides itself entirely when
 * nothing registers a panel, so a Tabby with no panel providers looks exactly
 * as it did before.
 */
@Injectable()
export class SidePanelToolbarButtonProvider extends ToolbarButtonProvider {
    constructor (
        private config: ConfigService,
        private translate: TranslateService,
        @Optional() @Inject(SidePanelProvider) private panels: SidePanelProvider[]|null,
    ) {
        super()
    }

    provide (): ToolbarButton[] {
        if (!this.panels?.some(x => x.isAvailable())) {
            return []
        }
        return [{
            icon: require('./icons/side-panel.svg'),
            weight: 5,
            title: this.translate.instant('Toggle the docked panel'),
            click: () => {
                this.config.store.sidePanel.enabled = !this.config.store.sidePanel.enabled
                this.config.save()
            },
        }]
    }
}
