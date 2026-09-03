// The helpers here walk JSON that a manifest author described and a remote
// server produced. `any` is what that is; typing it as `unknown` would only
// move the casts around.
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'

import {
    Integration, IntegrationFetchStep, IntegrationMatcher,
    LinkMatchKind, LinkPreview, PreviewField,
} from '../api'
import { GuardedRegex } from '../regexGuard'
import { httpRequest, runCommand } from './httpFetch'
import { IntegrationRegistryService } from './integrationRegistry.service'

/** Errors are cached briefly so a bad token does not retry on every hover. */
const ERROR_TTL_MS = 30_000
const MAX_CACHE_ENTRIES = 256
const DEFAULT_TIMEOUT_MS = 8000

interface CacheEntry {
    expiry: number
    preview: LinkPreview
}

interface Match {
    integration: Integration
    matcher: IntegrationMatcher
    /** Capture groups plus the synthetic `match` and `uri`. */
    vars: Record<string, string>
}

// ── helpers, exported so they can be exercised without a running app ────────

/**
 * RFC 6901, plus one extension shared with the other fork: a negative array
 * index counts back from the end, so `/messages/-1/text` is "the last message".
 * Slack needs it — `conversations.history` returns the message asked for as the
 * last entry, however many it decides to include.
 */
export function resolvePointer (root: any, pointer: string): any {
    if (root === null || root === undefined) {
        return null
    }
    if (!pointer || pointer === '/') {
        return root
    }
    if (!pointer.startsWith('/')) {
        return null
    }
    let current = root
    for (const rawSegment of pointer.substring(1).split('/')) {
        // Left to right, so `~01` decodes to `~1` and not to `/`.
        const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
        if (current === null || current === undefined) {
            return null
        }
        if (Array.isArray(current)) {
            let index = Number(segment)
            if (!Number.isInteger(index)) {
                return null
            }
            if (index < 0) {
                index += current.length
            }
            if (index < 0 || index >= current.length) {
                return null
            }
            current = current[index]
            continue
        }
        if (typeof current !== 'object') {
            return null
        }
        current = current[segment]
    }
    return current ?? null
}

/**
 * A path is either `stepId:/pointer` or a bare `/pointer` resolved against the
 * most recent step that produced parseable JSON.
 */
export function lookupPath (path: string | undefined, results: Record<string, any>, last: any): any {
    if (!path) {
        return null
    }
    const colon = path.indexOf(':')
    if (colon !== -1) {
        return resolvePointer(results[path.substring(0, colon)], path.substring(colon + 1))
    }
    if (path.startsWith('/')) {
        return resolvePointer(last, path)
    }
    return null
}

/** Only scalars render. An object or array in a field's path shows nothing. */
export function valueToString (value: any): string {
    if (value === null || value === undefined) {
        return ''
    }
    if (typeof value === 'string') {
        return value
    }
    if (typeof value === 'number') {
        return Number.isInteger(value) ? String(value) : String(value)
    }
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false'
    }
    return ''
}

export function parseJson (body: string): any {
    if (!body) {
        return null
    }
    try {
        const parsed = JSON.parse(body)
        return typeof parsed === 'object' ? parsed : null
    } catch {
        return null
    }
}

/** The host of either a bare host name or a full URL, lowercased. */
export function hostOf (value: string): string {
    if (!value) {
        return ''
    }
    const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`
    try {
        return new URL(withScheme).hostname.toLowerCase()
    } catch {
        return ''
    }
}

/** ISO 8601, or fractional Unix seconds as Slack sends them. */
export function parseTimestamp (raw: string): number | null {
    if (/^\d+(\.\d+)?$/.test(raw)) {
        return Math.round(parseFloat(raw) * 1000)
    }
    const parsed = Date.parse(raw)
    return Number.isNaN(parsed) ? null : parsed
}

export function relativeTime (millis: number, now = Date.now()): string {
    const seconds = (now - millis) / 1000
    // A timestamp slightly in the future is clock skew, not a negative age.
    if (seconds < 60) {
        return 'just now'
    }
    if (seconds < 3600) {
        return `${Math.floor(seconds / 60)} min ago`
    }
    if (seconds < 86400) {
        return `${Math.floor(seconds / 3600)} h ago`
    }
    if (seconds < 604800) {
        return `${Math.floor(seconds / 86400)} d ago`
    }
    if (seconds < 2592000) {
        return `${Math.floor(seconds / 604800)} wk ago`
    }
    if (seconds < 31536000) {
        return `${Math.floor(seconds / 2592000)} mo ago`
    }
    return `${Math.floor(seconds / 31536000)} y ago`
}

export function formatValue (raw: string, format?: 'relativeTime' | 'date'): string {
    if (!format) {
        return raw
    }
    const millis = parseTimestamp(raw)
    if (millis === null) {
        // Unparseable input is shown as it came, never blanked.
        return raw
    }
    if (format === 'date') {
        const d = new Date(millis)
        const pad = (n: number) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    return relativeTime(millis)
}

/**
 * Badge colours, matching the other fork so the same manifest looks the same in
 * both. Rendered translucent over the card's own background, which is what keeps
 * them readable in either theme without computing a contrasting foreground.
 */
export function badgeColor (name: string): string {
    const value = (name || '').trim().toLowerCase()
    if (/^#[0-9a-f]{6}$/.test(value)) {
        return value
    }
    if (['green', 'success', 'done', 'live', 'running', 'active'].includes(value)) {
        return '#2EA043'
    }
    if (['yellow', 'inprogress', 'in progress', 'warning', 'waiting', 'idle'].includes(value)) {
        return '#E0A800'
    }
    if (['red', 'error', 'failed', 'blocked', 'dead', 'stale'].includes(value)) {
        return '#D03C3C'
    }
    if (['blue', 'info', 'new', 'open'].includes(value)) {
        return '#3B82D6'
    }
    // Jira's "blue-gray" (To Do) lands here, deliberately.
    return '#808890'
}

function errorText (err: any): string {
    const message = err?.message ?? `${err}`
    return String(message).replace(/^Error:\s*/, '')
}

@Injectable({ providedIn: 'root' })
export class IntegrationRuntimeService {
    private cache = new Map<string, CacheEntry>()
    private compiled = new Map<string, GuardedRegex>()

    constructor (
        private registry: IntegrationRegistryService,
    ) {
        // Anything cached was rendered against settings that no longer apply.
        this.registry.integrations$.subscribe(() => {
            this.cache.clear()
            this.compiled.clear()
        })
    }

    /**
     * Whether a preview is even worth showing a spinner for. An integration that
     * is disabled or not configured is silent, not erroring.
     */
    canPreview (kind: LinkMatchKind, text: string, hint: string): boolean {
        const match = this.findMatch(kind, text, hint)
        return !!match && !!(match.integration.manifest.fetch ?? []).length
    }

    /** The link a text match resolves to, if an integration recognises it. */
    resolveTextLink (text: string, hint: string): string {
        const match = this.findMatch('text', text, hint)
        if (!match?.matcher.link) {
            return ''
        }
        return this.expand(match.matcher.link, match, {}, null, false)
    }

    async preview (kind: LinkMatchKind, text: string, hint: string): Promise<LinkPreview | null> {
        const match = this.findMatch(kind, text, hint)
        if (!match) {
            return null
        }
        const key = `${match.integration.id}|${text}`
        const cached = this.cache.get(key)
        if (cached && Date.now() < cached.expiry) {
            return cached.preview
        }

        const preview = await this.run(match)
        const seconds = match.integration.manifest.cacheSeconds
        const ttl = preview.error
            ? ERROR_TTL_MS
            : Math.max(1, seconds === undefined ? 300 : Math.max(0, seconds)) * 1000
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
            this.cache.clear()
        }
        this.cache.set(key, { expiry: Date.now() + ttl, preview })
        return preview
    }

    // ── matching ─────────────────────────────────────────────────────────────

    /**
     * Which integration claims this text.
     *
     * `hint` is the rule's `integration` field: '' picks automatically, 'none'
     * refuses, anything else names one. A text match is additionally only ever
     * eligible because an enabled rule said so — the integration's own text
     * matcher must then also match it in full.
     */
    private findMatch (kind: LinkMatchKind, text: string, hint: string): Match | null {
        if (!text || hint === 'none') {
            return null
        }
        const candidates = this.registry.current().filter(x =>
            x.enabled && x.configured && (!hint || x.id === hint))
        for (const integration of candidates) {
            for (const matcher of integration.manifest.matchers ?? []) {
                if ((matcher.kind ?? 'link') !== kind) {
                    continue
                }
                const vars = this.matchWith(integration, matcher, text, kind)
                if (vars) {
                    return { integration, matcher, vars }
                }
            }
        }
        return null
    }

    private matchWith (
        integration: Integration,
        matcher: IntegrationMatcher,
        text: string,
        kind: LinkMatchKind,
    ): Record<string, string> | null {
        if (!matcher.pattern) {
            return null
        }
        // Host guarding. The hovered URI's host must equal the host of the named
        // setting's *current* value — which may be spelled as a bare host or a
        // full URL. This is what stops a look-alike link from ever causing a
        // credential to be sent: the matcher simply never fires.
        if (kind === 'link' && matcher.hostSetting) {
            const expected = hostOf(integration.settings[matcher.hostSetting])
            const actual = hostOf(text)
            if (!expected || !actual || expected !== actual) {
                return null
            }
        }
        const regex = this.regexFor(matcher.pattern, '')
        if (!regex.usable) {
            return null
        }
        // Link matchers search; text matchers must consume the whole run.
        if (kind === 'text' && !regex.fullMatch(text)) {
            return null
        }
        const found = regex.execAll(text, 1)[0] as RegExpExecArray | undefined
        if (!found) {
            return null
        }
        return { ...found.groups, match: found[0], uri: text }
    }

    private regexFor (source: string, flags: string): GuardedRegex {
        const key = `${flags}|${source}`
        let regex = this.compiled.get(key)
        if (!regex) {
            regex = new GuardedRegex(source, flags, source)
            this.compiled.set(key, regex)
        }
        return regex
    }

    // ── the fetch pipeline ───────────────────────────────────────────────────

    private async run (match: Match): Promise<LinkPreview> {
        const { integration } = match
        const preview: LinkPreview = {
            integrationId: integration.id,
            integrationName: integration.name,
            icon: integration.manifest.icon ?? '',
            fields: [],
            error: '',
            link: match.matcher.link ? this.expand(match.matcher.link, match, {}, null, false) : '',
        }

        const results: Record<string, any> = {}
        let last: any = null

        for (const step of integration.manifest.fetch ?? []) {
            // `when`/`unless` are presence tests on the expanded text, which
            // works because an unknown template name expands to ''.
            if (step.when !== undefined && !this.expand(step.when, match, results, last, false)) {
                continue
            }
            if (step.unless !== undefined && this.expand(step.unless, match, results, last, false)) {
                continue
            }
            let outcome: { json: any, error: string } = { json: null, error: '' }
            try {
                outcome = step.type === 'command'
                    ? await this.runCommandStep(step, match, results, last)
                    : await this.runHttpStep(step, match, results, last)
            } catch (err) {
                outcome = { json: null, error: `${integration.name}: ${errorText(err)}` }
            }
            // The body is kept even when the step errored: Slack answers HTTP
            // 200 with `{"ok":false,"error":…}`, and a 4xx body often carries
            // the only useful detail there is.
            if (outcome.json !== null && outcome.json !== undefined) {
                if (step.id) {
                    results[step.id] = outcome.json
                }
                last = outcome.json
            }
            if (outcome.error) {
                preview.error = outcome.error
                break
            }
        }

        preview.fields = this.buildFields(integration, results, last)
        return preview
    }

    private async runHttpStep (
        step: IntegrationFetchStep,
        match: Match,
        results: Record<string, any>,
        last: any,
    ): Promise<{ json: any, error: string }> {
        const name = match.integration.name
        const url = this.expand(step.url ?? '', match, results, last, true)
        if (!url) {
            return { json: null, error: `${name}: the step has no URL` }
        }
        const headers: Record<string, string> = { accept: 'application/json' }
        for (const [key, value] of Object.entries(step.headers ?? {})) {
            headers[key.toLowerCase()] = this.expand(value, match, results, last, false)
        }
        const auth = step.auth
        if (auth?.type === 'basic') {
            const user = this.expand(auth.user ?? '', match, results, last, false)
            const password = this.expand(auth.password ?? '', match, results, last, false)
            headers.authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
        } else if (auth?.type === 'bearer') {
            headers.authorization = `Bearer ${this.expand(auth.value ?? '', match, results, last, false)}`
        } else if (auth?.type === 'header' && auth.header) {
            headers[auth.header.toLowerCase()] = this.expand(auth.value ?? '', match, results, last, false)
        }

        const response = await httpRequest({
            url,
            method: step.method ? step.method : 'GET',
            headers,
            body: step.body ? this.expand(step.body, match, results, last, false) : undefined,
            timeoutMs: step.timeoutMs && step.timeoutMs > 0 ? step.timeoutMs : DEFAULT_TIMEOUT_MS,
            allowUntrustedCertificate: step.allowUntrustedCertificate,
        })
        const json = parseJson(response.body)
        const ok = response.status >= 200 && response.status < 300
        return {
            json,
            // Never include the URL, headers or body — a manifest is free to put
            // a credential in any of them, and an error message is the one place
            // a secret must not surface.
            error: ok ? '' : `${name}: ${response.status} ${response.statusText}`.trim(),
        }
    }

    private async runCommandStep (
        step: IntegrationFetchStep,
        match: Match,
        results: Record<string, any>,
        last: any,
    ): Promise<{ json: any, error: string }> {
        const name = match.integration.name
        const commandLine = this.expand(step.commandLine ?? '', match, results, last, false)
        if (!commandLine) {
            return { json: null, error: `${name}: the step has no command` }
        }
        const { stdout } = await runCommand(
            commandLine,
            step.stdin ? this.expand(step.stdin, match, results, last, false) : '',
            step.timeoutMs && step.timeoutMs > 0 ? step.timeoutMs : DEFAULT_TIMEOUT_MS,
        )
        const json = parseJson(stdout)
        if (json === null) {
            return { json: null, error: `${name}: the command produced no usable output` }
        }
        return { json, error: '' }
    }

    // ── templates ────────────────────────────────────────────────────────────

    /**
     * `{{name}}` substitution. Namespaces, in order: `settings.<k>`,
     * `credentials.<k>`, `<stepId>:<pointer>`, otherwise a capture group.
     *
     * Only values that come from *data* — capture groups and step results — are
     * percent-encoded, and only when building a URL. A setting like
     * `https://stith.lvh.me` is a whole scheme and host, and escaping it would
     * produce nonsense. An unknown name expands to '' rather than throwing,
     * which is what makes `when`/`unless` work.
     */
    private expand (
        template: string,
        match: Match,
        results: Record<string, any>,
        last: any,
        urlEncode: boolean,
    ): string {
        if (!template.includes('{{')) {
            return template
        }
        let out = ''
        let index = 0
        while (index < template.length) {
            const open = template.indexOf('{{', index)
            if (open === -1) {
                out += template.substring(index)
                break
            }
            const close = template.indexOf('}}', open + 2)
            if (close === -1) {
                // An unterminated `{{` is emitted literally rather than eaten.
                out += template.substring(index)
                break
            }
            out += template.substring(index, open)
            const name = template.substring(open + 2, close).trim()
            const { value, fromData } = this.lookup(name, match, results, last)
            out += urlEncode && fromData ? encodeURIComponent(value) : value
            index = close + 2
        }
        return out
    }

    private lookup (
        name: string,
        match: Match,
        results: Record<string, any>,
        last: any,
    ): { value: string, fromData: boolean } {
        if (name.startsWith('settings.')) {
            return { value: match.integration.settings[name.substring(9)] as string | undefined ?? '', fromData: false }
        }
        if (name.startsWith('credentials.')) {
            return { value: match.integration.credentials[name.substring(12)] as string | undefined ?? '', fromData: false }
        }
        const colon = name.indexOf(':')
        if (colon !== -1) {
            const stepId = name.substring(0, colon)
            const pointer = name.substring(colon + 1)
            return { value: valueToString(resolvePointer(results[stepId], pointer)), fromData: true }
        }
        if (name in match.vars) {
            return { value: match.vars[name], fromData: true }
        }
        // Deliberately not an error: `when`/`unless` rely on this being ''.
        void last
        return { value: '', fromData: true }
    }

    // ── display fields ───────────────────────────────────────────────────────

    private buildFields (integration: Integration, results: Record<string, any>, last: any): PreviewField[] {
        const wanted = this.registry.visibleFieldKeys(integration)
        const out: PreviewField[] = []
        for (const field of integration.manifest.fields ?? []) {
            const key = field.key ?? field.label ?? ''
            if (!wanted.includes(key)) {
                continue
            }
            const raw = valueToString(lookupPath(field.path, results, last))
            if (!raw) {
                continue
            }
            out.push({
                key,
                label: field.label ?? key,
                value: formatValue(raw, field.format),
                kind: field.kind ?? 'text',
                iconUri: valueToString(lookupPath(field.iconPath, results, last)),
                color: field.color ? field.color : valueToString(lookupPath(field.colorPath, results, last)),
            })
        }
        return out
    }
}
