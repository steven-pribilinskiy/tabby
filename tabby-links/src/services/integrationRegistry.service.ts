import * as fs from 'fs/promises'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { BehaviorSubject, Observable } from 'rxjs'
import { ConfigService, LogService, Logger, PlatformService } from 'tabby-core'

import { Integration, IntegrationField, IntegrationManifest } from '../api'
import { IntegrationCredentialsService } from './integrationCredentials.service'

/**
 * Built-ins. Bundled rather than read from disk so a fresh install has working
 * integrations, and byte-identical to the Windows Terminal fork's copies — that
 * identity is the compatibility test for the manifest format.
 */
const BUILT_IN: IntegrationManifest[] = [
    require('../integrations/jira.json'),
    require('../integrations/slack.json'),
    require('../integrations/stith.json'),
]

/**
 * An integration is only contacted once every `required` setting has a value and
 * every credential field it declares is stored. A credential's own `required`
 * flag is not consulted — same as the other fork, where a declared credential is
 * always needed in practice.
 */
export function isConfigured (
    manifest: IntegrationManifest,
    settings: Record<string, string>,
    credentials: Record<string, string>,
): boolean {
    for (const field of manifest.settings ?? []) {
        if (field.required && !settings[field.key]) {
            return false
        }
    }
    for (const field of manifest.credentials ?? []) {
        if (!credentials[field.key]) {
            return false
        }
    }
    return true
}

/**
 * A credential is secret unless it says otherwise, or is one of the well-known
 * identity keys. Jira's `email` relies on this.
 *
 * A non-secret credential is still *stored* the same way — it is half of a
 * basic-auth pair and has no business in `config.yaml` either — but it is not
 * masked and, unlike a secret, it is shown back once saved. An account name you
 * cannot read is just a thing you have to guess at.
 */
export function isSecretField (key: string, declared?: boolean): boolean {
    if (declared === false) {
        return false
    }
    return !['email', 'user', 'username'].includes(key)
}

/**
 * Clean up what was typed into a setting, when the manifest asks for it.
 *
 * Applied on blur rather than per keystroke: rewriting the text under someone
 * mid-word is worse than leaving it alone for a moment.
 */
export function normalizeSettingValue (field: IntegrationField, raw: string): string {
    let value = raw.trim()
    if (!value) {
        return ''
    }
    if (field.normalize === 'host') {
        // Whatever came out of the address bar: scheme, path, query, port and
        // userinfo all go, leaving the host the guard actually compares.
        const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`
        try {
            const host = new URL(withScheme).hostname
            if (host) {
                value = host
            }
        } catch {
            // Not a URL and not a host — leave it alone and let the field's own
            // "required" handling say so.
            value = value.replace(/\/.*$/, '')
        }
    }
    if (field.suffix && value && !value.includes('.')) {
        // A bare name: `cloudbeds` is what people say, `cloudbeds.atlassian.net`
        // is what the guard needs.
        value += field.suffix
    }
    return value
}

@Injectable({ providedIn: 'root' })
export class IntegrationRegistryService {
    private logger: Logger
    private integrations = new BehaviorSubject<Integration[]>([])
    private rebuilding: Promise<void> | null = null

    get integrations$ (): Observable<Integration[]> { return this.integrations }

    constructor (
        private config: ConfigService,
        private platform: PlatformService,
        private credentials: IntegrationCredentialsService,
        log: LogService,
    ) {
        this.logger = log.create('integrations')
        void this.rebuild()
        // Manifests are re-scanned and credentials re-read on a settings reload,
        // which is also the only moment the keystore is touched.
        this.config.changed$.subscribe(() => void this.rebuild())
    }

    /** The directory user manifests are dropped into. */
    userDirectory (): string {
        const configPath = this.platform.getConfigPath()
        return configPath ? path.join(path.dirname(configPath), 'integrations') : ''
    }

    current (): Integration[] {
        return this.integrations.value
    }

    byId (id: string): Integration | null {
        return this.current().find(x => x.id === id) ?? null
    }

    /** Re-scan and re-read everything. Serialised: overlapping calls share one pass. */
    async rebuild (): Promise<void> {
        if (!this.rebuilding) {
            this.rebuilding = this.doRebuild().finally(() => {
                this.rebuilding = null
            })
        }
        await this.rebuilding
    }

    private async doRebuild (): Promise<void> {
        const manifests = new Map<string, { manifest: IntegrationManifest, source: string }>()
        for (const manifest of BUILT_IN) {
            if (manifest.id) {
                manifests.set(manifest.id, { manifest, source: 'built-in' })
            }
        }
        // A user manifest with the same id *replaces* a built-in outright, which
        // is what lets one be forked and edited in place.
        for (const found of await this.scanUserDirectory()) {
            manifests.set(found.manifest.id, found)
        }

        const stored = this.config.store.integrations ?? {}
        const out: Integration[] = []
        for (const { manifest, source } of manifests.values()) {
            const state = stored[manifest.id] ?? {}
            const settings: Record<string, string> = { ...state.settings ?? {} }
            let credentialValues: Record<string, string> = {}
            try {
                credentialValues = await this.credentials.getAll(manifest.id)
            } catch (err) {
                this.logger.warn(`Could not read credentials for ${manifest.id}`, err)
            }
            out.push({
                manifest,
                id: manifest.id,
                name: manifest.name ? manifest.name : manifest.id,
                source,
                enabled: state.enabled !== false,
                settings,
                credentials: credentialValues,
                fields: Array.isArray(state.fields) ? state.fields : [],
                configured: isConfigured(manifest, settings, credentialValues),
            })
        }
        this.integrations.next(out)
    }

    private async scanUserDirectory (): Promise<{ manifest: IntegrationManifest, source: string }[]> {
        const dir = this.userDirectory()
        if (!dir) {
            return []
        }
        const found: { manifest: IntegrationManifest, source: string }[] = []
        let entries: any[] = []
        try {
            entries = await fs.readdir(dir, { withFileTypes: true })
        } catch {
            // Not having the directory is the normal case, not a problem.
            return []
        }
        for (const entry of entries) {
            const candidates = entry.isDirectory()
                ? [path.join(dir, entry.name, 'integration.json')]
                : entry.name.toLowerCase().endsWith('.json') ? [path.join(dir, entry.name)] : []
            for (const file of candidates) {
                const manifest = await this.readManifest(file)
                if (manifest) {
                    found.push({ manifest, source: file })
                }
            }
        }
        return found
    }

    private async readManifest (file: string): Promise<IntegrationManifest | null> {
        try {
            const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
            if (!parsed?.id || typeof parsed.id !== 'string') {
                // A manifest without an id cannot be addressed, overridden or
                // configured. Skipped and logged, never fatal.
                this.logger.warn(`Ignoring ${file}: no "id"`)
                return null
            }
            return parsed as IntegrationManifest
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                this.logger.warn(`Ignoring ${file}`, err)
            }
            return null
        }
    }

    // ── persisted state ──────────────────────────────────────────────────────

    private stateFor (id: string): any {
        const all = this.config.store.integrations
        all[id] ??= {}
        return all[id]
    }

    setEnabled (id: string, enabled: boolean): void {
        this.stateFor(id).enabled = enabled
        this.config.save()
    }

    /**
     * The stored value, read straight from the config rather than from an
     * `Integration` snapshot.
     *
     * The snapshots are rebuilt on `config.changed$`, which arrives *after*
     * `config.save()` resolves — so a text input bound to a snapshot shows the
     * previous value for as long as that takes, and reverts what is being
     * typed. Bind inputs to this instead.
     */
    settingValue (id: string, key: string): string {
        return this.config.store.integrations?.[id]?.settings?.[key] ?? ''
    }

    setSetting (id: string, key: string, value: string): void {
        const state = this.stateFor(id)
        state.settings ??= {}
        if (value) {
            state.settings[key] = value
        } else {
            // Storing '' would look configured while not being usable.
            Reflect.deleteProperty(state.settings, key)
        }
        this.config.save()
    }

    /**
     * Which display fields to show. The first edit seeds from the manifest's own
     * `default: true` set, so ticking one box does not silently drop the rest,
     * and the list is always re-sorted into manifest order so the card reads the
     * way its author intended regardless of click order.
     */
    setFieldVisible (id: string, key: string, visible: boolean): void {
        const integration = this.byId(id)
        if (!integration) {
            return
        }
        const order = (integration.manifest.fields ?? []).map(f => f.key ?? f.label ?? '')
        const current = integration.fields.length
            ? integration.fields
            : (integration.manifest.fields ?? []).filter(f => f.default).map(f => f.key ?? f.label ?? '')
        const next = new Set(current)
        if (visible) {
            next.add(key)
        } else {
            next.delete(key)
        }
        this.stateFor(id).fields = order.filter(k => next.has(k))
        this.config.save()
    }

    /** The display fields to render, honouring the user's choice or the defaults. */
    visibleFieldKeys (integration: Integration): string[] {
        if (integration.fields.length) {
            return integration.fields
        }
        return (integration.manifest.fields ?? [])
            .filter(f => f.default)
            .map(f => f.key ?? f.label ?? '')
    }
}
