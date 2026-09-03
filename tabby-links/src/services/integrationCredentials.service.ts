import * as fs from 'fs/promises'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { LogService, Logger, PlatformService } from 'tabby-core'

const FILE_NAME = 'integration-credentials.json'

/**
 * A preview of a stored secret: the first and last few characters with the
 * middle masked, so you can tell which value is in there without reading it.
 * Anything short enough that the ends would give it away is masked completely.
 */
export function maskSecret (value: string): string {
    if (!value) {
        return ''
    }
    if (value.length <= 10) {
        return '•'.repeat(value.length)
    }
    const keep = value.length >= 24 ? 4 : 3
    return `${value.slice(0, keep)}${'•'.repeat(8)}${value.slice(-keep)}`
}

/**
 * Integration credentials, encrypted with the OS keystore.
 *
 * Deliberately *not* `config.yaml`: Config Sync uploads that file verbatim, so a
 * Jira token in it leaves the machine. Values are encrypted in the main process
 * (`app/lib/secrets.ts`) and stored base64 in a sidecar beside the config.
 *
 * Nothing here is on the hover path. `IntegrationRegistryService` reads every
 * credential once per rebuild and hands the runtime a plain snapshot, so
 * previewing a link never touches the keystore or the disk.
 */
@Injectable({ providedIn: 'root' })
export class IntegrationCredentialsService {
    private logger: Logger
    private cache: Record<string, Record<string, string> | undefined> | null = null
    private available: boolean | null = null

    constructor (
        private platform: PlatformService,
        log: LogService,
    ) {
        this.logger = log.create('integration-credentials')
    }

    /** Whether the OS can encrypt at all — false on Linux with no keyring. */
    async isAvailable (): Promise<boolean> {
        if (this.available === null) {
            this.available = await this.invoke<boolean>('secrets:available', undefined) ?? false
        }
        return this.available
    }

    async keysFor (integrationId: string): Promise<string[]> {
        const all = await this.load()
        return Object.keys(all[integrationId] ?? {})
    }

    async has (integrationId: string, key: string): Promise<boolean> {
        const all = await this.load()
        return !!all[integrationId]?.[key]
    }

    /**
     * Enough of a stored secret to recognise it by, and no more.
     *
     * "Record<string, Record<string, string> | undefined>" alone does not answer the question you actually have, which is
     * *which* token is in there — the old one or the one you just rotated. The
     * ends are shown only when there is enough length that they do not give the
     * value away; anything short is masked completely.
     */
    async hint (integrationId: string, key: string): Promise<string> {
        return maskSecret(await this.get(integrationId, key))
    }

    async get (integrationId: string, key: string): Promise<string> {
        const all = await this.load()
        const encrypted = all[integrationId]?.[key]
        if (!encrypted) {
            return ''
        }
        return await this.invoke<string>('secrets:decrypt', encrypted) ?? ''
    }

    /** Every credential for one integration, decrypted. Called once per rebuild. */
    async getAll (integrationId: string): Promise<Record<string, string>> {
        const all = await this.load()
        const entries = all[integrationId] ?? {}
        const out: Record<string, string> = {}
        for (const key of Object.keys(entries)) {
            const value = await this.invoke<string>('secrets:decrypt', entries[key])
            if (value) {
                out[key] = value
            }
        }
        return out
    }

    /** An empty value clears the credential rather than storing an empty string. */
    async set (integrationId: string, key: string, value: string): Promise<void> {
        const all = await this.load()
        if (!value) {
            const entry = all[integrationId]
            if (entry) {
                Reflect.deleteProperty(entry, key)
                if (!Object.keys(entry).length) {
                    Reflect.deleteProperty(all, integrationId)
                }
            }
        } else {
            const encrypted = await this.invoke<string>('secrets:encrypt', value)
            if (!encrypted) {
                throw new Error('This system cannot encrypt secrets, so the credential was not saved.')
            }
            all[integrationId] = { ...all[integrationId], [key]: encrypted }
        }
        await this.save(all)
    }

    async clear (integrationId: string, key: string): Promise<void> {
        await this.set(integrationId, key, '')
    }

    private filePath (): string | null {
        const configPath = this.platform.getConfigPath()
        return configPath ? path.join(path.dirname(configPath), FILE_NAME) : null
    }

    private async load (): Promise<Record<string, Record<string, string> | undefined>> {
        if (this.cache) {
            return this.cache
        }
        const p = this.filePath()
        if (!p) {
            this.cache = {}
            return this.cache
        }
        try {
            const raw = await fs.readFile(p, 'utf8')
            const parsed = JSON.parse(raw)
            this.cache = parsed && typeof parsed === 'object' ? parsed : {}
        } catch (err: any) {
            if (err?.code !== 'ENOENT') {
                this.logger.warn('Could not read stored credentials', err)
            }
            this.cache = {}
        }
        return this.cache!
    }

    private async save (all: Record<string, Record<string, string> | undefined>): Promise<void> {
        const p = this.filePath()
        if (!p) {
            return
        }
        this.cache = all
        // 0600: the contents are already encrypted, but there is no reason for
        // another account on the machine to be able to read the file at all.
        await fs.writeFile(p, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 })
    }

    // eslint-disable-next-line @typescript-eslint/member-ordering
    private async invoke<T> (channel: string, arg: any): Promise<T | null> {
        try {
            const { ipcRenderer } = require('electron')
            return await ipcRenderer.invoke(channel, arg) as T
        } catch (err) {
            this.logger.warn(`${channel} failed`, err)
            return null
        }
    }
}
