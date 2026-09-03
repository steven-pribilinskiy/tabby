import { Component } from '@angular/core'
import { ConfigService, HostAppService, Platform, PlatformService } from 'tabby-core'

import { Integration, LinkTooltipAction, LinkTooltipRule, hydrateRule, newRule } from '../api'
import { FILE_TYPE_GROUP_LABELS } from '../fileTypes'
import { checkPattern } from '../regexGuard'
import { IntegrationRegistryService } from '../services/integrationRegistry.service'

/** A comma-separated field, cleaned up. Empty entries are dropped, not stored. */
function splitList (value: string): string[] {
    return value.split(',').map(x => x.trim()).filter(x => x)
}

@Component({
    selector: 'link-tooltip-settings-tab',
    templateUrl: './linkTooltipSettingsTab.component.pug',
    styleUrls: ['./linkTooltipSettingsTab.component.scss'],
})
export class LinkTooltipSettingsTabComponent {
    Platform = Platform
    fileTypeGroups = FILE_TYPE_GROUP_LABELS
    currentRule: LinkTooltipRule | null = null
    patternError = ''
    integrations: Integration[] = []

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        private platform: PlatformService,
        registry: IntegrationRegistryService,
    ) {
        registry.integrations$.subscribe(list => {
            this.integrations = list
        })
    }

    get rules (): LinkTooltipRule[] {
        // Hydrated, because these come straight out of a file a person can
        // hand-edit and may be missing any key. Completed *in place* and the
        // stored array itself returned — `.map()` here would hand back a copy,
        // and adding, deleting or reordering a rule would then mutate a
        // throwaway and never reach the config.
        const stored = this.config.store.linkTooltip.rules as Partial<LinkTooltipRule>[]
        stored.forEach(hydrateRule)
        return stored as LinkTooltipRule[]
    }

    /**
     * The "single click" toggle drives `clickableLinks.modifier`, which already
     * existed, rather than a second setting that could disagree with it.
     */
    get openOnSingleClick (): boolean {
        return !this.config.store.clickableLinks?.modifier
    }

    set openOnSingleClick (value: boolean) {
        this.config.store.clickableLinks.modifier = value
            ? null
            : this.hostApp.platform === Platform.macOS ? 'metaKey' : 'ctrlKey'
        this.saveConfiguration()
    }

    get safeSchemes (): string {
        return (this.config.store.linkTooltip.safeSchemes ?? []).join(', ')
    }

    set safeSchemes (value: string) {
        this.config.store.linkTooltip.safeSchemes = splitList(value)
        this.saveConfiguration()
    }

    saveConfiguration (): void {
        this.config.save()
        this.platform.extraSafeSchemes = this.config.store.linkTooltip.safeSchemes ?? []
    }

    // ── the rule list ────────────────────────────────────────────────────────

    addRule (): void {
        const rule = newRule()
        this.rules.push(rule)
        this.currentRule = rule
        this.saveConfiguration()
    }

    editRule (rule: LinkTooltipRule): void {
        this.currentRule = this.currentRule === rule ? null : rule
        this.patternError = ''
    }

    moveRule (rule: LinkTooltipRule, delta: number): void {
        const index = this.rules.indexOf(rule)
        const target = index + delta
        if (index === -1 || target < 0 || target >= this.rules.length) {
            return
        }
        this.rules.splice(index, 1)
        this.rules.splice(target, 0, rule)
        this.saveConfiguration()
    }

    deleteRule (rule: LinkTooltipRule): void {
        const index = this.rules.indexOf(rule)
        if (index === -1) {
            return
        }
        this.rules.splice(index, 1)
        if (this.currentRule === rule) {
            this.currentRule = null
        }
        this.saveConfiguration()
    }

    /** The one-line description under a rule's name in the list. */
    summary (rule: LinkTooltipRule): string {
        if (rule.match === 'text') {
            const target = rule.integration && rule.integration !== 'none'
                ? this.integrationName(rule.integration)
                : rule.integration === 'none' ? 'no preview' : 'any integration'
            return `text: ${rule.pattern || '(no pattern)'}  →  ${target}`
        }
        const parts: string[] = []
        if (rule.schemes.length) {
            parts.push(`scheme: ${rule.schemes.join(', ')}`)
        }
        if (rule.pattern) {
            parts.push(`pattern: ${rule.pattern}`)
        }
        if (rule.fileTypeGroup !== 'none' || rule.extensions.length) {
            parts.push('file type')
        }
        return parts.join(' · ')
    }

    integrationName (id: string): string {
        return this.integrations.find(x => x.id === id)?.name ?? id
    }

    // ── the rule editor ──────────────────────────────────────────────────────

    schemesOf (rule: LinkTooltipRule): string {
        return rule.schemes.join(', ')
    }

    setSchemes (rule: LinkTooltipRule, value: string): void {
        rule.schemes = splitList(value)
        this.saveConfiguration()
    }

    extensionsOf (rule: LinkTooltipRule): string {
        return rule.extensions.join(', ')
    }

    setExtensions (rule: LinkTooltipRule, value: string): void {
        rule.extensions = splitList(value)
        this.saveConfiguration()
    }

    /**
     * Patterns are checked before they are stored. A backtracking pattern here
     * runs synchronously against whatever a remote host printed, so catching it
     * at authoring time is far better than catching it as a frozen window.
     */
    setPattern (rule: LinkTooltipRule, value: string): void {
        rule.pattern = value
        this.patternError = value ? checkPattern(value).error : ''
        this.saveConfiguration()
    }

    hasOverride (rule: LinkTooltipRule, key: 'showDelay' | 'hideDelay' | 'maxWidth'): boolean {
        return rule[key] !== null
    }

    toggleOverride (rule: LinkTooltipRule, key: 'showDelay' | 'hideDelay' | 'maxWidth'): void {
        if (this.hasOverride(rule, key)) {
            rule[key] = null
        } else {
            rule[key] = this.config.store.linkTooltip[key]
        }
        this.saveConfiguration()
    }

    addAction (rule: LinkTooltipRule): void {
        rule.actions.push({ name: '', icon: '', type: 'openUrl', value: '' })
        this.saveConfiguration()
    }

    deleteAction (rule: LinkTooltipRule, action: LinkTooltipAction): void {
        const index = rule.actions.indexOf(action)
        if (index !== -1) {
            rule.actions.splice(index, 1)
            this.saveConfiguration()
        }
    }

    trackRule (index: number): number {
        return index
    }
}
