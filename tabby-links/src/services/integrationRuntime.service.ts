// The helpers here walk JSON that a manifest author described and a remote
// server produced. `any` is what that is; typing it as `unknown` would only
// move the casts around.
/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { Injectable } from '@angular/core'

import {
    Integration, IntegrationFetchStep, IntegrationMatcher,
    LinkMatchKind, LinkPreview, PreviewAction, PreviewField, PreviewGroup,
    PreviewTab, PreviewTabItem,
} from '../api'
import { GuardedRegex } from '../regexGuard'
import { adfToText, plainText } from '../richText'
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
    // A leading slash settles it before the colon is even looked for. Checking
    // the other way round misreads `/links/self:href` — a perfectly ordinary
    // pointer into a key containing a colon — as a step named `/links/self`,
    // and the field then silently renders as nothing.
    if (path.startsWith('/')) {
        return resolvePointer(last, path)
    }
    const colon = path.indexOf(':')
    if (colon !== -1) {
        return resolvePointer(results[path.substring(0, colon)], path.substring(colon + 1))
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

/**
 * Merge a required-field form into an action's body.
 *
 * The spec puts the user's answers in a top-level `fields` object *alongside*
 * whatever `body` already declares — which is Jira's shape for a transition
 * screen. A body that is not JSON is left exactly as the manifest wrote it; the
 * form is then only reachable through `{{field.<key>}}`.
 */
export function mergeActionFields (body: string, fieldValues: Record<string, string>): string {
    const entries = Object.entries(fieldValues).filter(([, v]) => v !== '')
    if (!entries.length) {
        return body
    }
    let parsed: any = null
    try {
        parsed = body ? JSON.parse(body) : {}
    } catch {
        return body
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return body
    }
    parsed.fields = { ...parsed.fields }
    for (const [key, value] of entries) {
        parsed.fields[key] = value
    }
    return JSON.stringify(parsed)
}

/**
 * The one line of an API error body worth showing.
 *
 * Jira answers a refused transition with `errorMessages` / `errors`, and without
 * it the card can only say "400", which tells nobody anything. Capped hard, and
 * only ever read from the response — never from the request.
 */
export function describeApiError (body: string): string {
    const json = parseJson(body)
    if (!json || typeof json !== 'object') {
        return ''
    }
    const messages: string[] = []
    const list = json.errorMessages
    if (Array.isArray(list)) {
        messages.push(...list.map(String))
    }
    const map = json.errors
    if (map && typeof map === 'object' && !Array.isArray(map)) {
        messages.push(...Object.values(map).map(String))
    }
    const single = json.message ?? json.error
    if (!messages.length && typeof single === 'string') {
        messages.push(single)
    }
    const text = messages.filter(x => x).join('; ').trim()
    return text ? ` — ${text.slice(0, 200)}` : ''
}

/** A comment thread can be thousands long; a card shows the recent end of it. */
const MAX_TAB_ITEMS = 25
/** A status picker with more options than this is a menu, not a card control. */
const MAX_ACTION_OPTIONS = 40

/**
 * Resolve a pointer *within* one value rather than against the step results.
 *
 * A tab's `item*Path` and an action's `option*Path` are relative to each element
 * of an array, so they never carry a `stepId:` prefix and must not be parsed as
 * though they might.
 */
export function lookupIn (value: any, pointer: string | undefined): any {
    if (!pointer) {
        return null
    }
    return resolvePointer(value, pointer)
}

/** A tab body, read according to the format the manifest declared. */
export function readTabBody (value: any, format: string | undefined): string {
    if (format === 'adf') {
        return adfToText(value)
    }
    // `markdown` is not parsed here: the card does that, so the parsed form
    // never has to survive the cache or a structured clone.
    return plainText(value)
}

/**
 * The fields the far end demands before it will accept an option.
 *
 * Jira hands back a map of field id → metadata, where `required` is what
 * actually matters. Anything not required is dropped: a card is not the place to
 * offer every optional field on a transition screen.
 */
export function readRequiredFields (value: any): { key: string, label: string, required: boolean }[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return []
    }
    const out: { key: string, label: string, required: boolean }[] = []
    for (const [key, meta] of Object.entries(value as Record<string, any>)) {
        if (meta?.required) {
            out.push({ key, label: String(meta.name ?? key), required: true })
        }
    }
    return out
}

/**
 * Replace any credential value that appears verbatim in `text`.
 *
 * Short values are left alone: a two-character secret would match half the
 * alphabet and redact text that has nothing to do with it.
 */
export function redactSecrets (text: string, credentials: Record<string, string>): string {
    let out = text
    for (const value of Object.values(credentials)) {
        if (value && value.length >= 6) {
            out = out.split(value).join('••••')
        }
    }
    return out
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

    /**
     * The link a text match resolves to, if an integration recognises it.
     *
     * Deliberately does not require the integration to be configured. Turning
     * `CAB-8209` into a link needs nothing but the matcher's own template — it
     * is *fetching* the issue that needs a credential. Requiring one here meant
     * an unconfigured Jira left the ticket unclickable, which is the opposite of
     * what someone who has not set it up yet needs.
     */
    resolveTextLink (text: string, hint: string): string {
        const match = this.findMatch('text', text, hint, false)
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
            : Math.max(0, seconds ?? 300) * 1000
        // `cacheSeconds: 0` means "never cache", not "cache for a moment" —
        // it is how a manifest whose data changes constantly opts out.
        if (ttl <= 0) {
            return preview
        }
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
     *
     * `mustBeConfigured` is what separates the two uses: showing a preview needs
     * the settings and credentials a fetch will use, but resolving a link only
     * needs the matcher.
     */
    private findMatch (
        kind: LinkMatchKind,
        text: string,
        hint: string,
        mustBeConfigured = true,
    ): Match | null {
        if (!text || hint === 'none') {
            return null
        }
        const candidates = this.registry.current().filter(x =>
            x.enabled && (!mustBeConfigured || x.configured) && (!hint || x.id === hint))
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
            groups: [],
            tabs: [],
            actions: [],
            skipped: [],
            error: '',
            link: match.matcher.link ? this.expand(match.matcher.link, match, {}, null, false) : '',
            html: integration.manifest.html ?? '',
            data: {},
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
                // An optional step is allowed to fail: it is recorded and
                // stepped over, and anything reading its result resolves to
                // nothing, so the fields depending on it simply do not render.
                // Jira's Development panel and GitHub's richer endpoints are
                // permissions-dependent, and losing the whole card because one
                // of them said 403 would be the wrong trade.
                if (step.optional) {
                    preview.skipped.push(step.id ?? step.url ?? 'step')
                    continue
                }
                preview.error = outcome.error
                break
            }
        }

        preview.fields = this.buildFields(integration, results, last)
        preview.groups = this.buildGroups(integration, preview.fields)
        preview.tabs = this.buildTabs(integration, results, last)
        preview.actions = this.buildActions(integration, results, last)
        // Only a manifest with an `html` document gets the raw step JSON kept —
        // it is what that page reads as `window.__data`. The field list has
        // already reduced everything it needs to strings, and these responses
        // are large and sit in the cache.
        if (preview.html) {
            preview.data = results
        }
        return preview
    }

    /**
     * Apply an action — the one place this whole subsystem *writes*.
     *
     * Deliberately not built on `runHttpStep`: an action defaults to POST rather
     * than GET, carries the chosen option as `{{choice}}`, and merges the form
     * the far end demanded into the body. It also drops the cached preview
     * afterwards, so the next hover shows the state that was just created rather
     * than the one that was replaced.
     */
    async applyAction (
        kind: LinkMatchKind,
        text: string,
        hint: string,
        actionKey: string,
        choiceId: string,
        fieldValues: Record<string, string>,
    ): Promise<{ error: string }> {
        const match = this.findMatch(kind, text, hint)
        if (!match) {
            return { error: 'No integration claims this link any more' }
        }
        const action = (match.integration.manifest.actions ?? [])
            .find(a => (a.key ?? a.label ?? '') === actionKey)
        if (!action) {
            return { error: `Unknown action: ${actionKey}` }
        }

        // `{{choice}}` and `{{field.<key>}}` ride in as ordinary template
        // variables, so nothing about expansion has to know they exist.
        const vars: Record<string, string> = { ...match.vars, choice: choiceId }
        for (const [key, value] of Object.entries(fieldValues)) {
            vars[`field.${key}`] = value
        }
        const actionMatch: Match = { ...match, vars }
        const name = match.integration.name

        const url = this.expand(action.url ?? '', actionMatch, {}, null, true)
        if (!url) {
            return { error: `${name}: the action has no URL` }
        }
        const headers: Record<string, string> = { accept: 'application/json' }
        for (const [key, value] of Object.entries(action.headers ?? {})) {
            headers[key.toLowerCase()] = this.expand(value, actionMatch, {}, null, false)
        }
        const auth = action.auth
        if (auth?.type === 'basic') {
            const user = this.expand(auth.user ?? '', actionMatch, {}, null, false)
            const password = this.expand(auth.password ?? '', actionMatch, {}, null, false)
            headers.authorization = `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
        } else if (auth?.type === 'bearer') {
            headers.authorization = `Bearer ${this.expand(auth.value ?? '', actionMatch, {}, null, false)}`
        } else if (auth?.type === 'header' && auth.header) {
            headers[auth.header.toLowerCase()] = this.expand(auth.value ?? '', actionMatch, {}, null, false)
        }

        const body = mergeActionFields(
            action.body ? this.expand(action.body, actionMatch, {}, null, false) : '',
            fieldValues,
        )

        try {
            const response = await httpRequest({
                url,
                method: action.method ? action.method : 'POST',
                headers,
                body: body || undefined,
                timeoutMs: action.timeoutMs && action.timeoutMs > 0 ? action.timeoutMs : DEFAULT_TIMEOUT_MS,
                allowUntrustedCertificate: action.allowUntrustedCertificate,
            })
            if (response.status < 200 || response.status >= 300) {
                // Same rule as a fetch step: never echo the URL, headers or
                // body back, because a manifest may have put a credential in
                // any of them.
                const detail = describeApiError(response.body)
                return { error: `${name}: ${response.status} ${response.statusText}${detail}`.trim() }
            }
        } catch (err) {
            return { error: `${name}: ${errorText(err)}` }
        }

        // The thing behind the link just changed, so the cached description of
        // it is wrong by definition.
        this.cache.delete(`${match.integration.id}|${text}`)
        return { error: '' }
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
        const { stdout, stderr } = await runCommand(
            commandLine,
            step.stdin ? this.expand(step.stdin, match, results, last, false) : '',
            step.timeoutMs && step.timeoutMs > 0 ? step.timeoutMs : DEFAULT_TIMEOUT_MS,
        )
        const json = parseJson(stdout)
        if (json === null) {
            // Only now is stderr worth showing: a command that produced usable
            // JSON has succeeded whatever it wrote there. Trimmed to one line,
            // because this lands in a hover card — and with any credential
            // scrubbed out of it, since a failing command very often echoes the
            // command line it was given, and that is where the token was.
            const detail = redactSecrets(
                stderr.trim().split('\n')[0].slice(0, 200),
                match.integration.credentials,
            )
            return {
                json: null,
                error: detail
                    ? `${name}: ${detail}`
                    : `${name}: the command produced no usable output`,
            }
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

    // ── groups, tabs and actions ─────────────────────────────────────────────

    /**
     * Arrange the rendered fields into the manifest's groups.
     *
     * Grouping is presentation only, so this works off what `buildFields`
     * already produced rather than resolving anything again — a field that
     * resolved to nothing is absent here too, and a group left with no fields
     * does not render. Anything no group claims falls into an implicit
     * "Details", which is also the whole answer for a manifest that declares no
     * groups at all.
     */
    private buildGroups (integration: Integration, fields: PreviewField[]): PreviewGroup[] {
        const declared = integration.manifest.fieldGroups ?? []
        if (!declared.length) {
            return fields.length ? [{ key: 'details', label: '', fields }] : []
        }
        const byKey = new Map(fields.map(f => [f.key, f]))
        const claimed = new Set<string>()
        const groups: PreviewGroup[] = []
        for (const group of declared) {
            const members: PreviewField[] = []
            for (const key of group.fields ?? []) {
                const field = byKey.get(key)
                if (field) {
                    members.push(field)
                    claimed.add(key)
                }
            }
            if (members.length) {
                groups.push({
                    key: group.key ?? group.label ?? '',
                    label: group.label ?? '',
                    fields: members,
                })
            }
        }
        const rest = fields.filter(f => !claimed.has(f.key))
        if (rest.length) {
            // Unclaimed fields lead, because a manifest that groups only its
            // secondary data still wants its title and status at the top.
            groups.unshift({ key: 'details', label: '', fields: rest })
        }
        return groups
    }

    private buildTabs (integration: Integration, results: Record<string, any>, last: any): PreviewTab[] {
        const wanted = this.registry.visibleTabKeys(integration)
        const out: PreviewTab[] = []
        for (const tab of integration.manifest.tabs ?? []) {
            const key = tab.key ?? tab.label ?? ''
            if (!wanted.includes(key)) {
                continue
            }
            const value = lookupPath(tab.path, results, last)
            if (value === null || value === undefined) {
                continue
            }
            const kind = tab.kind ?? 'body'
            if (kind === 'list') {
                const items = Array.isArray(value) ? value : []
                const rows: PreviewTabItem[] = []
                for (const item of items.slice(-MAX_TAB_ITEMS)) {
                    const body = readTabBody(lookupIn(item, tab.itemBodyPath), tab.format)
                    if (!body) {
                        continue
                    }
                    rows.push({
                        author: valueToString(lookupIn(item, tab.itemAuthorPath)),
                        avatarUri: valueToString(lookupIn(item, tab.itemAvatarPath)),
                        body,
                        time: formatValue(valueToString(lookupIn(item, tab.itemTimePath)), 'relativeTime'),
                    })
                }
                if (rows.length) {
                    out.push({ key, label: tab.label ?? key, kind, body: '', markdown: false, items: rows })
                }
                continue
            }
            const body = readTabBody(value, tab.format)
            if (body) {
                out.push({
                    key,
                    label: tab.label ?? key,
                    kind: 'body',
                    body,
                    markdown: tab.format === 'markdown',
                    items: [],
                })
            }
        }
        return out
    }

    /**
     * Resolve each action's options from what the fetch produced.
     *
     * An action with no options left is dropped: a `choice` whose list came back
     * empty — or whose step was optional and failed — is a control that could
     * only ever say "nothing to pick".
     */
    private buildActions (integration: Integration, results: Record<string, any>, last: any): PreviewAction[] {
        const out: PreviewAction[] = []
        for (const action of integration.manifest.actions ?? []) {
            const kind = action.kind ?? 'button'
            const resolved: PreviewAction = {
                key: action.key ?? action.label ?? '',
                label: action.label ?? action.key ?? '',
                kind,
                options: [],
                currentState: valueToString(lookupPath(action.currentStatePath, results, last)),
            }
            if (kind === 'choice') {
                const raw = lookupPath(action.optionsPath, results, last)
                const options = Array.isArray(raw) ? raw : []
                for (const option of options.slice(0, MAX_ACTION_OPTIONS)) {
                    const id = valueToString(lookupIn(option, action.optionIdPath))
                    if (!id) {
                        continue
                    }
                    resolved.options.push({
                        id,
                        label: valueToString(lookupIn(option, action.optionLabelPath)) || id,
                        badge: valueToString(lookupIn(option, action.optionBadgePath)),
                        color: valueToString(lookupIn(option, action.optionColorPath)),
                        targetId: valueToString(lookupIn(option, action.optionTargetIdPath)),
                        fields: readRequiredFields(lookupIn(option, action.optionFieldsPath)),
                    })
                }
                if (!resolved.options.length) {
                    continue
                }
            }
            out.push(resolved)
        }
        return out
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
                // `colorPath` first, `color` as the fallback. A manifest setting
                // both means "the status colour this issue actually has, or this
                // one if the response didn't carry it" — and the other fork
                // resolves it that way, so a manifest that sets both has to
                // render the same in each.
                color: valueToString(lookupPath(field.colorPath, results, last)) || (field.color ?? ''),
            })
        }
        return out
    }
}
