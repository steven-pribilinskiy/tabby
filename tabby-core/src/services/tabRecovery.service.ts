import { Injectable, Inject, Optional } from '@angular/core'
import { TabRecoveryProvider, RecoveryToken } from '../api/tabRecovery'
import { TabRecoveryAugmentor } from '../api/tabRecoveryAugmentor'
import { BaseTabComponent, GetRecoveryTokenOptions } from '../components/baseTab.component'
import { Logger, LogService } from './log.service'
import { ConfigService } from './config.service'
import { NewTabParameters } from './tabs.service'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class TabRecoveryService {
    logger: Logger
    enabled = false

    private constructor (
        @Inject(TabRecoveryProvider) private tabRecoveryProviders: TabRecoveryProvider<BaseTabComponent>[]|null,
        @Optional() @Inject(TabRecoveryAugmentor) private augmentors: TabRecoveryAugmentor[]|null,
        private config: ConfigService,
        log: LogService,
    ) {
        this.logger = log.create('tabRecovery')
    }

    async saveTabs (tabs: BaseTabComponent[]): Promise<void> {
        if (!this.enabled || !this.config.store.recoverTabs) {
            return
        }
        window.localStorage.tabsRecovery = JSON.stringify(
            (await Promise.all(
                tabs.map(async tab => this.getFullRecoveryToken(tab, { includeState: true })),
            )).filter(token => !!token),
        )
    }

    async getFullRecoveryToken (tab: BaseTabComponent, options?: GetRecoveryTokenOptions): Promise<RecoveryToken|null> {
        const token = await tab.getRecoveryToken(options)
        if (token) {
            token.tabTitle = tab.title
            token.tabCustomTitle = tab.customTitle
            token.tabPinned = tab.pinned
            if (tab.icon) {
                token.tabIcon = tab.icon
            }
            if (tab.color) {
                token.tabColor = tab.color
            }
            token.disableDynamicTitle = tab['disableDynamicTitle']
            for (const augmentor of this.config.enabledServices(this.augmentors ?? [])) {
                try {
                    await augmentor.augment(tab, token, options)
                } catch (error) {
                    this.logger.warn('Recovery token augmentor crashed:', augmentor, error)
                }
            }
        }
        return token
    }

    async recoverTab (token: RecoveryToken): Promise<NewTabParameters<BaseTabComponent>|null> {
        for (const provider of this.config.enabledServices(this.tabRecoveryProviders ?? [])) {
            try {
                if (!await provider.applicableTo(token)) {
                    continue
                }
                const tab = await provider.recover(token)
                tab.inputs = tab.inputs ?? {}
                tab.inputs.icon = token.tabIcon ?? null
                tab.inputs.color = token.tabColor ?? null
                tab.inputs.title = token.tabTitle || ''
                tab.inputs.customTitle = token.tabCustomTitle || ''
                tab.inputs.pinned = token.tabPinned ?? false
                tab.inputs.disableDynamicTitle = token.disableDynamicTitle
                for (const augmentor of this.config.enabledServices(this.augmentors ?? [])) {
                    try {
                        await augmentor.restore(token, tab)
                    } catch (error) {
                        this.logger.warn('Recovery token augmentor crashed:', augmentor, error)
                    }
                }
                return tab
            } catch (error) {
                this.logger.warn('Tab recovery crashed:', token, provider, error)
            }
        }
        return null
    }

    async recoverTabs (): Promise<NewTabParameters<BaseTabComponent>[]> {
        if (window.localStorage.tabsRecovery) {
            const tabs: NewTabParameters<BaseTabComponent>[] = []
            for (const token of JSON.parse(window.localStorage.tabsRecovery)) {
                const tab = await this.recoverTab(token)
                if (tab) {
                    tabs.push(tab)
                }
            }
            return tabs
        }
        return []
    }
}
