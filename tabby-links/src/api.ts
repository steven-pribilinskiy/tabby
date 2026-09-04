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
    /**
     * A failing step is recorded and stepped over instead of ending the fetch.
     * Anything reading its result resolves to nothing, and fields that depend on
     * it are skipped — an empty value never renders a row.
     */
    optional?: boolean
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

/**
 * A named set of display fields, rendered together under one heading.
 *
 * Presentation only: a field still has to exist and its `key` appear here, and a
 * field named by no group falls into an implicit "Details". A group whose fields
 * all resolve to nothing does not render.
 */
export interface IntegrationFieldGroup {
    key?: string
    label?: string
    fields?: string[]
}

/**
 * Secondary content, too long for a field row — a description body, or a list of
 * comments — shown behind a tab strip above the fields.
 */
export interface IntegrationTab {
    key?: string
    label?: string
    /** One long value, or a repeating list of author/body/time rows. */
    kind?: 'body' | 'list'
    /** `body`: the value. `list`: the array to repeat over. */
    path?: string
    /**
     * How to read the body text. `adf` is Atlassian Document Format, a JSON
     * document flattened to text.
     */
    format?: 'markdown' | 'adf' | 'text'
    /** `list` only, and relative to *each element* of the array. */
    itemAuthorPath?: string
    itemAvatarPath?: string
    itemBodyPath?: string
    itemTimePath?: string
    default?: boolean
}

/**
 * Something the card can *do* to the thing behind the link, rather than
 * something it reads. A `button` fires one request; a `choice` offers options an
 * earlier step produced and fires a request for whichever is picked, with that
 * option's id available to the templates as `{{choice}}`.
 */
export interface IntegrationAction {
    key?: string
    label?: string
    kind?: 'button' | 'choice'
    /** Choice only: the array of options, in a fetch step's result. */
    optionsPath?: string
    /** The rest are relative to one option. */
    optionIdPath?: string
    optionLabelPath?: string
    optionBadgePath?: string
    optionColorPath?: string
    /** The id of the state this option moves the thing *to*. */
    optionTargetIdPath?: string
    /**
     * Where the thing's *current* state id lives. With `optionTargetIdPath`,
     * this is what lets an undo find the option that leads back.
     */
    currentStatePath?: string
    /** Fields the far end demands before it will accept the change. */
    optionFieldsPath?: string
    /** Defaults to POST — a fetch step defaults to GET. */
    method?: string
    url?: string
    body?: string
    headers?: Record<string, string>
    auth?: IntegrationAuth
    allowUntrustedCertificate?: boolean
    timeoutMs?: number
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
    fieldGroups?: IntegrationFieldGroup[]
    tabs?: IntegrationTab[]
    actions?: IntegrationAction[]
    /**
     * Patterns scanned in plain output while this plugin is enabled, so a scheme
     * it unambiguously owns is hoverable without OSC 8 and without the user
     * adding a rule. Distinct from a `text` matcher, which only *offers* itself
     * on the settings page and needs opting into.
     */
    detectPatterns?: string[]
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
    /** Tab keys the user chose, with the same null/empty distinction as fields. */
    tabs: string[] | null
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

/** Fields that render together, under one heading. */
export interface PreviewGroup {
    key: string
    label: string
    fields: PreviewField[]
}

/** One row of a `list` tab. */
export interface PreviewTabItem {
    author: string
    avatarUri: string
    body: string
    time: string
}

/** A rendered tab: either one block of text, or a list of rows. */
export interface PreviewTab {
    key: string
    label: string
    kind: 'body' | 'list'
    /** For `body`. Already flattened from markdown or ADF to text. */
    body: string
    /** Whether `body` should be drawn with the small markdown renderer. */
    markdown: boolean
    items: PreviewTabItem[]
}

/** One option of a `choice` action. */
export interface PreviewActionOption {
    id: string
    label: string
    badge: string
    color: string
    /** The state this option moves the thing to, for finding a way back. */
    targetId: string
    /** Fields the far end demands before it will accept this option. */
    fields: { key: string, label: string, required: boolean }[]
}

/** A rendered action, with whatever options an earlier step produced. */
export interface PreviewAction {
    key: string
    label: string
    kind: 'button' | 'choice'
    options: PreviewActionOption[]
    /** The thing's current state id, so an undo can look for the way back. */
    currentState: string
}

export interface LinkPreview {
    integrationId: string
    integrationName: string
    icon: string
    fields: PreviewField[]
    /** The same fields, arranged into the manifest's groups. */
    groups: PreviewGroup[]
    tabs: PreviewTab[]
    actions: PreviewAction[]
    /** Steps that failed but were marked `optional`, so the fetch carried on. */
    skipped: string[]
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
