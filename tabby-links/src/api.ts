/**
 * Shared types for link tooltips and integration manifests.
 *
 * The rule and manifest shapes are deliberately identical to the ones the
 * Windows Terminal fork uses (`HyperlinkTooltipRule`, `integration.json`), so a
 * rule can be pasted between the two apps and a manifest works unmodified in
 * both. Anything that differs is called out in `INTEGRATIONS.md`.
 */

export type LinkMatchKind = 'link' | 'text'

export type LinkFileTypeGroup =
    'none' | 'image' | 'video' | 'audio' | 'media' |
    'sourceCode' | 'document' | 'archive' | 'executable'

/**
 * What a custom tooltip button does. The Windows Terminal fork names an entry in
 * its own `actions` keybinding map; Tabby has no equivalent, so the three things
 * that map usefully onto Tabby's own primitives are named directly. `%u` in
 * `value` is replaced with the hovered link's URI, matching the substitution the
 * other fork applies to `SendInput` and `ExecuteCommandline`.
 */
export type LinkActionType = 'openUrl' | 'sendInput' | 'command'

export interface LinkTooltipAction {
    name: string
    /** FontAwesome name without the `fa-` prefix. */
    icon?: string
    type: LinkActionType
    value: string
}

export interface LinkTooltipRule {
    name: string
    enabled: boolean
    match: LinkMatchKind

    // --- match criteria; every criterion that is set must hold (AND) ---
    schemes: string[]
    pattern: string
    fileTypeGroup: LinkFileTypeGroup
    extensions: string[]

    // --- preview ---
    /** '' picks an integration automatically, 'none' disables preview, else an id. */
    integration: string
    preview: boolean

    // --- overrides; null means "inherit the global default" ---
    showDelay: number | null
    hideDelay: number | null
    maxWidth: number | null

    // --- built-in button suppression ---
    suppressOpen: boolean
    suppressCopyLink: boolean
    suppressCopyPath: boolean
    suppressReveal: boolean

    actions: LinkTooltipAction[]
}

export function newRule (): LinkTooltipRule {
    return {
        name: '',
        enabled: true,
        match: 'link',
        schemes: [],
        pattern: '',
        fileTypeGroup: 'none',
        extensions: [],
        integration: '',
        preview: true,
        showDelay: null,
        hideDelay: null,
        maxWidth: null,
        suppressOpen: false,
        suppressCopyLink: false,
        suppressCopyPath: false,
        suppressReveal: false,
        actions: [],
    }
}

/**
 * Fill in whatever a stored rule is missing, in place.
 *
 * Rules come out of `config.yaml`, which a person can hand-edit, so any key may
 * simply be absent. Completing them once here is what lets everything
 * downstream treat `LinkTooltipRule` as the total type it claims to be, instead
 * of defending against `undefined` at every use. In place, because the settings
 * page edits these same objects.
 */
export function hydrateRule (raw: Partial<LinkTooltipRule>): LinkTooltipRule {
    const defaults = newRule()
    for (const key of Object.keys(defaults) as (keyof LinkTooltipRule)[]) {
        if (raw[key] === undefined) {
            // `showDelay` and friends are legitimately null, which is not the
            // same as absent — only absent keys are filled.
            (raw as any)[key] = defaults[key]
        }
    }
    return raw as LinkTooltipRule
}

/** The tooltip behaviour that applies to one hovered match, after rules resolve. */
export interface EffectiveTooltipSettings {
    showDelay: number
    hideDelay: number
    maxWidth: number
    showOpen: boolean
    showCopyLink: boolean
    showCopyPath: boolean
    showReveal: boolean
    integration: string
    showPreview: boolean
    actions: LinkTooltipAction[]
    /** The rule that produced these, if any — for debugging and the summary line. */
    rule: LinkTooltipRule | null
}

/** One thing the link provider found in the buffer. */
export interface LinkMatch {
    kind: LinkMatchKind
    /** The matched text exactly as it appears in the buffer. */
    text: string
    /** Buffer range, xterm's 1-based convention. */
    range: { start: { x: number, y: number }, end: { x: number, y: number } }
    /** For link matches, the handler that claimed it (used for activate/convert). */
    handlerIndex: number
    /** For text matches, the rule that produced the pattern. */
    rule: LinkTooltipRule | null
}

// ── Integration manifests ───────────────────────────────────────────────────

export interface IntegrationField {
    key: string
    label?: string
    placeholder?: string
    description?: string
    required?: boolean
    /** Credentials only. Defaults to true except for email/user/username. */
    secret?: boolean
    /**
     * Settings only. `"host"` reduces whatever was entered to a bare hostname,
     * so pasting a full URL out of the address bar does the right thing.
     * Applied when the field loses focus, never while typing.
     */
    normalize?: 'host'
    /**
     * Settings only. Appended when the entered value looks like a bare name
     * rather than a hostname — `cloudbeds` becomes `cloudbeds.atlassian.net`.
     */
    suffix?: string
}

export interface IntegrationMatcher {
    kind?: LinkMatchKind
    pattern: string
    /** Link matchers only: the URI's host must equal this setting's value. */
    hostSetting?: string
    /** Text matchers only: how a match becomes a URL. */
    link?: string
    /** Text matchers only: offered on the Integrations page as "Add as rule". */
    suggested?: boolean
    description?: string
}

export interface IntegrationAuth {
    type: 'basic' | 'bearer' | 'header'
    user?: string
    password?: string
    value?: string
    header?: string
}

export interface IntegrationFetchStep {
    id?: string
    type?: 'http' | 'command'
    method?: string
    url?: string
    headers?: Record<string, string>
    auth?: IntegrationAuth
    body?: string
    allowUntrustedCertificate?: boolean
    commandLine?: string
    stdin?: string
    timeoutMs?: number
    when?: string
    unless?: string
}

export type IntegrationFieldKind =
    'text' | 'title' | 'subtitle' | 'badge' | 'link' | 'image' | 'multiline'

export interface IntegrationDisplayField {
    key?: string
    label?: string
    path?: string
    kind?: IntegrationFieldKind
    iconPath?: string
    colorPath?: string
    color?: string
    format?: 'relativeTime' | 'date'
    default?: boolean
}

export interface IntegrationManifest {
    id: string
    name?: string
    icon?: string
    version?: number
    cacheSeconds?: number
    settings?: IntegrationField[]
    credentials?: IntegrationField[]
    matchers?: IntegrationMatcher[]
    fetch?: IntegrationFetchStep[]
    fields?: IntegrationDisplayField[]
    /**
     * A complete HTML document, rendered in place of `fields`. Given inline —
     * there is no file-reference form. See INTEGRATIONS.md; the page is handed
     * `window.__data` and `window.__uri` and talks back over
     * `chrome.webview.postMessage`.
     *
     * The Windows Terminal fork hosts this in a WebView2 that ships disabled
     * (`Feature_HyperlinkPreviewHtml`), so a manifest setting it falls back to
     * `fields` there. Here it renders.
     */
    html?: string
}

/** A manifest plus where it came from and what the user has configured. */
export interface Integration {
    manifest: IntegrationManifest
    id: string
    name: string
    /** 'built-in' or the absolute path of the manifest file. */
    source: string
    enabled: boolean
    settings: Record<string, string>
    /** Credential values, resolved once per rebuild — never re-read on a hover. */
    credentials: Record<string, string>
    /**
     * Display field keys the user chose, in manifest order. `null` means they
     * never chose — an empty array means they chose nothing, which is a
     * different and equally valid answer.
     */
    fields: string[] | null
    configured: boolean
}

/** One rendered row on the card. */
export interface PreviewField {
    key: string
    label: string
    value: string
    kind: IntegrationFieldKind
    iconUri: string
    color: string
}

export interface LinkPreview {
    integrationId: string
    integrationName: string
    icon: string
    fields: PreviewField[]
    error: string
    /** For a text match, the URL the integration resolved it to. */
    link: string
    /** The manifest's `html` document, when it has one and the feature is on. */
    html: string
    /**
     * Every fetch step's JSON, keyed by step id — what an `html` page reads as
     * `window.__data`. Populated *only* when the manifest sets `html`, so the
     * field-list path never pays to retain a response it has already reduced to
     * strings.
     */
    data: Record<string, any>
}
