import { Component, Optional } from '@angular/core'
import { ConfigService, NotificationsService, PlatformService } from 'tabby-core'
import { SettingsTabComponent } from 'tabby-settings'

import {
    Integration, IntegrationDisplayField, IntegrationField, IntegrationMatcher, newRule,
} from '../api'
import { IntegrationCredentialsService } from '../services/integrationCredentials.service'
import { IntegrationRegistryService, isSecretField, normalizeSettingValue } from '../services/integrationRegistry.service'

interface CredentialRow {
    field: IntegrationField
    secret: boolean
    stored: boolean
    /** What is in the box. Pre-filled with the real value for a non-secret. */
    pending: string
    /** A masked preview of a stored secret, so you can tell which one it is. */
    hint: string
}

@Component({
    selector: 'integrations-settings-tab',
    templateUrl: './integrationsSettingsTab.component.pug',
    styleUrls: ['./integrationsSettingsTab.component.scss'],
})
export class IntegrationsSettingsTabComponent {
    integrations: Integration[] = []
    current: Integration | null = null
    credentialRows: CredentialRow[] = []
    userDirectory = ''
    encryptionAvailable = true
    addedRuleName = ''

    constructor (
        public config: ConfigService,
        public registry: IntegrationRegistryService,
        private credentials: IntegrationCredentialsService,
        private platform: PlatformService,
        private notifications: NotificationsService,
        @Optional() private settingsTab: SettingsTabComponent | null,
    ) {
        this.userDirectory = registry.userDirectory()
        registry.integrations$.subscribe(list => {
            this.integrations = list
            if (this.current) {
                this.current = list.find(x => x.id === this.current!.id) ?? null
                void this.loadCredentialRows()
            }
        })
        void this.credentials.isAvailable().then(available => {
            this.encryptionAvailable = available
        })
    }

    async select (integration: Integration | null): Promise<void> {
        this.current = integration
        this.addedRuleName = ''
        await this.loadCredentialRows()
    }

    setEnabled (integration: Integration, enabled: boolean): void {
        this.registry.setEnabled(integration.id, enabled)
    }

    settingValue (integration: Integration, key: string): string {
        // From the config, not from `integration.settings` — that snapshot is
        // only rebuilt after `config.save()` resolves, and an input bound to it
        // reverts characters while they are being typed.
        return this.registry.settingValue(integration.id, key)
    }

    setSetting (integration: Integration, key: string, value: string): void {
        this.registry.setSetting(integration.id, key, value)
    }

    /**
     * Tidy a setting when the field loses focus — paste a Jira URL straight out
     * of the address bar and it becomes the host the guard compares, and a bare
     * `cloudbeds` becomes `cloudbeds.atlassian.net`. Done on blur rather than
     * per keystroke so nothing is rewritten mid-word.
     */
    normalizeSetting (integration: Integration, field: IntegrationField): void {
        const current = this.settingValue(integration, field.key)
        const normalized = normalizeSettingValue(field, current)
        if (normalized !== current) {
            this.registry.setSetting(integration.id, field.key, normalized)
        }
    }

    // ── credentials ──────────────────────────────────────────────────────────

    private async loadCredentialRows (): Promise<void> {
        const integration = this.current
        if (!integration) {
            this.credentialRows = []
            return
        }
        const rows: CredentialRow[] = []
        for (const field of integration.manifest.credentials ?? []) {
            const secret = isSecretField(field.key, field.secret)
            const stored = await this.credentials.has(integration.id, field.key)
            rows.push({
                field,
                secret,
                stored,
                // A non-secret credential — an account name — is shown back in
                // full and stays editable. There is nothing to protect, and an
                // account you cannot read is one you have to guess at.
                pending: !secret && stored ? await this.credentials.get(integration.id, field.key) : '',
                hint: secret && stored ? await this.credentials.hint(integration.id, field.key) : '',
            })
        }
        this.credentialRows = rows
    }

    async saveCredential (row: CredentialRow): Promise<void> {
        if (!this.current) {
            return
        }
        try {
            await this.credentials.set(this.current.id, row.field.key, row.pending)
            row.stored = !!row.pending
            if (row.secret) {
                // A secret is never redisplayed; the preview is what confirms
                // which value went in.
                row.hint = await this.credentials.hint(this.current.id, row.field.key)
                row.pending = ''
            }
            await this.registry.rebuild()
        } catch (err) {
            this.notifications.error(`${err}`)
        }
    }

    async clearCredential (row: CredentialRow): Promise<void> {
        if (!this.current) {
            return
        }
        await this.credentials.clear(this.current.id, row.field.key)
        row.stored = false
        row.pending = ''
        row.hint = ''
        await this.registry.rebuild()
    }

    // ── display fields ───────────────────────────────────────────────────────

    isFieldVisible (integration: Integration, key: string): boolean {
        return this.registry.visibleFieldKeys(integration).includes(key)
    }

    setFieldVisible (integration: Integration, key: string, visible: boolean): void {
        this.registry.setFieldVisible(integration.id, key, visible)
    }

    isTabVisible (integration: Integration, key: string): boolean {
        return this.registry.visibleTabKeys(integration).includes(key)
    }

    setTabVisible (integration: Integration, key: string, visible: boolean): void {
        this.registry.setTabVisible(integration.id, key, visible)
    }

    /**
     * The manifest's field groups, resolved to the actual field objects — plus
     * an implicit unlabelled group for anything no group claims, so every field
     * is reachable however the manifest is written.
     */
    fieldGroups (integration: Integration): { key: string, label: string, fields: IntegrationDisplayField[] }[] {
        const all = integration.manifest.fields ?? []
        const declared = integration.manifest.fieldGroups ?? []
        if (!declared.length) {
            return [{ key: 'all', label: '', fields: all }]
        }
        const byKey = new Map(all.map(f => [f.key ?? f.label ?? '', f]))
        const claimed = new Set<string>()
        const groups = declared.map(group => {
            const fields: IntegrationDisplayField[] = []
            for (const key of group.fields ?? []) {
                const field = byKey.get(key)
                if (field) {
                    fields.push(field)
                    claimed.add(key)
                }
            }
            return { key: group.key ?? group.label ?? '', label: group.label ?? '', fields }
        }).filter(g => g.fields.length)
        const rest = all.filter(f => !claimed.has(f.key ?? f.label ?? ''))
        if (rest.length) {
            groups.unshift({ key: 'other', label: '', fields: rest })
        }
        return groups
    }

    /**
     * Whether a group is fully on, fully off, or somewhere between — the third
     * state is what stops the header checkbox from lying about a group where
     * only some fields are shown.
     */
    groupState (
        integration: Integration,
        group: { fields: IntegrationDisplayField[] },
    ): boolean | 'partial' {
        const visible = this.registry.visibleFieldKeys(integration)
        const keys = group.fields.map(f => f.key ?? f.label ?? '')
        const on = keys.filter(k => visible.includes(k)).length
        if (!on) {
            return false
        }
        return on === keys.length ? true : 'partial'
    }

    setGroupVisible (
        integration: Integration,
        group: { fields: IntegrationDisplayField[] },
        visible: boolean,
    ): void {
        for (const field of group.fields) {
            this.registry.setFieldVisible(integration.id, field.key ?? field.label ?? '', visible)
        }
    }

    // ── suggested text matchers ──────────────────────────────────────────────

    suggestedMatchers (integration: Integration): IntegrationMatcher[] {
        return (integration.manifest.matchers ?? []).filter(m =>
            m.kind === 'text' && m.suggested && m.pattern)
    }

    /**
     * Turn a suggested matcher into a Link Tooltip rule. Link matchers need no
     * rule — they fire directly against hovered URIs — but plain terminal text
     * is only ever scanned because a rule said so.
     */
    addAsRule (integration: Integration, matcher: IntegrationMatcher): void {
        // `||`, not `??`: an empty description should fall back to the pattern.
        const description = matcher.description ? matcher.description : matcher.pattern
        const rule = newRule()
        rule.name = `${integration.name}: ${description}`
        rule.match = 'text'
        rule.pattern = matcher.pattern
        rule.integration = integration.id
        this.config.store.linkTooltip.rules.push(rule)
        this.config.save()
        this.addedRuleName = rule.name
    }

    goToLinkTooltip (): void {
        if (this.settingsTab) {
            this.settingsTab.activeTab = 'link-tooltip'
        }
    }

    openUserDirectory (): void {
        if (this.userDirectory) {
            this.platform.openPath(this.userDirectory)
        }
    }

    copyUserDirectory (): void {
        this.platform.setClipboard({ text: this.userDirectory })
        this.notifications.notice('Copied')
    }
}
