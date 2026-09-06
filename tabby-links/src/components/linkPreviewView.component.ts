import { AfterViewChecked, ChangeDetectorRef, Component, ElementRef, HostBinding, Input, OnDestroy, ViewChild } from '@angular/core'

import {
    LinkPreview, PreviewAction, PreviewActionOption,
    PreviewField, PreviewGroup, PreviewTab,
} from '../api'
import { MarkdownBlock, parseMarkdown } from '../richText'
import { HTML_DEFAULT_HEIGHT, HTML_MAX_HEIGHT, buildHtmlDocument, parseHtmlHostMessage } from '../htmlHost'
import { badgeColor } from '../services/integrationRuntime.service'

/**
 * Everything the renderer below draws: the integration's answer, and enough
 * about the link to hand a plugin's own page its `__uri`.
 *
 * The hover card and the preview pane each carry a superset of this — the card
 * adds its buttons and its hint line, the pane adds where the link came from —
 * so both can be passed straight in.
 */
export interface PreviewModel {
    text: string
    target: string
    loading: boolean
    integrationName: string
    preview: LinkPreview | null
    /**
     * Identity of what is being shown. The frame's document is rewritten only
     * when this changes — see `sync`.
     */
    key: string
    /** Whether a plugin's `html` may be rendered at all (`linkTooltip.allowHtml`). */
    allowHtml: boolean
}

/** The three things this renderer needs its host to do for it. */
export interface PreviewHandlers {
    /** The html frame changed size and the host may need to re-place itself. */
    htmlResized: () => void
    /** Something in here asked for a link to be opened, the way Open would. */
    htmlOpen: (url: string) => void
    /**
     * Apply an integration action and refresh the preview. Resolves to an error
     * string, empty when it worked.
     */
    applyAction: (actionKey: string, optionId: string, fields: Record<string, string>) => Promise<string>
}

export function emptyPreviewModel (): PreviewModel {
    return {
        text: '',
        target: '',
        loading: false,
        integrationName: '',
        preview: null,
        key: '',
        allowHtml: true,
    }
}

/**
 * The preview itself: groups of fields, the tab strip and its bodies, the
 * actions, and a plugin's own `html` document.
 *
 * Deliberately one component used in two places rather than two that drift.
 * The hover card mounts it inside `.xterm-screen` and the preview pane mounts
 * it in a tab; the *only* difference between them is how much room there is,
 * which is `pane` and `maxHtmlHeight` and nothing else. Every rule about how a
 * preview is rendered — markdown parsed to data and never to HTML, `trackBy`
 * on every `*ngFor`, the frame's sandbox and its write-once `srcdoc` — is
 * therefore stated once and holds in both.
 */
@Component({
    selector: 'link-preview-view',
    templateUrl: './linkPreviewView.component.pug',
    styleUrls: ['./linkPreviewView.component.scss'],
})
export class LinkPreviewViewComponent implements AfterViewChecked, OnDestroy {
    @Input() model: PreviewModel = emptyPreviewModel()
    @Input() handlers: PreviewHandlers | null = null

    /**
     * Whether this is the pane rather than the card. Sizing only: the card
     * clamps bodies, images and clamped titles so a hover affordance cannot
     * grow without limit, and the pane — which the user asked for and can
     * resize — lets them run.
     */
    @Input() @HostBinding('class.pane') pane = false

    /** The tallest a plugin's own page may ask this host to make it. */
    @Input() maxHtmlHeight = HTML_MAX_HEIGHT

    @ViewChild('htmlFrame') htmlFrame?: ElementRef<HTMLIFrameElement>

    /** The preview whose document is currently in the frame. */
    private appliedKey = ''
    private frameLoads = 0

    /** Which tab the user picked, when there is more than one. */
    activeTabKey = ''
    // `| undefined` on purpose: without `noUncheckedIndexedAccess` an index
    // signature reads as always-present, and the guards below — which are real —
    // would be flagged as redundant.
    /** Chosen option per choice action, before it is applied. */
    chosen: Record<string, string | undefined> = {}
    /** What the user typed into an option's required-field form. */
    pendingFields: Record<string, Record<string, string | undefined> | undefined> = {}
    /** The action currently in flight, so its control can show it. */
    applying = ''
    actionError = ''
    /** Where the last applied action came *from*, so an undo can look for it. */
    private undoTarget: { actionKey: string, stateId: string } | null = null
    private markdownCacheKey = ''
    private markdownCache: MarkdownBlock[] = []

    constructor (private changeDetector: ChangeDetectorRef) {
        window.addEventListener('message', this.onFrameMessage)
    }

    ngOnDestroy (): void {
        window.removeEventListener('message', this.onFrameMessage)
    }

    /**
     * The frame is written from here rather than from each host, so neither has
     * to remember to do it: a check whose key has not changed is a comparison
     * and nothing else.
     */
    ngAfterViewChecked (): void {
        this.sync()
    }

    get showPreviewSection (): boolean {
        return this.model.loading || !!this.model.preview
    }

    /** Whether this renders a plugin's document instead of the field list. */
    get showHtml (): boolean {
        return this.model.allowHtml && !!this.model.preview?.html && !this.model.preview.error
    }

    // ── tabs ─────────────────────────────────────────────────────────────────

    /** The tab on screen. Falls back to the first, so one is always selected. */
    get activeTab (): PreviewTab | null {
        const tabs = this.model.preview?.tabs ?? []
        if (!tabs.length) {
            return null
        }
        return tabs.find(t => t.key === this.activeTabKey) ?? tabs[0]
    }

    selectTab (tab: PreviewTab): void {
        this.activeTabKey = tab.key
    }

    /**
     * A markdown body, parsed to blocks.
     *
     * Memoised on the text itself: change detection asks for this on every pass,
     * and re-parsing a comment thread each time would be a needless cost on a
     * card that is already redrawn whenever the terminal scrolls.
     */
    blocksFor (tab: PreviewTab): MarkdownBlock[] {
        if (!tab.markdown) {
            return []
        }
        if (this.markdownCacheKey !== tab.body) {
            this.markdownCacheKey = tab.body
            this.markdownCache = parseMarkdown(tab.body)
        }
        return this.markdownCache
    }

    // ── actions ──────────────────────────────────────────────────────────────

    optionFor (action: PreviewAction): PreviewActionOption | null {
        const chosen = this.chosen[action.key]
        return action.options.find(o => o.id === chosen) ?? null
    }

    chooseOption (action: PreviewAction, optionId: string): void {
        this.chosen[action.key] = optionId
        this.actionError = ''
    }

    /** The fields the chosen option demands, if any. */
    requiredFields (action: PreviewAction): { key: string, label: string, required: boolean }[] {
        return this.optionFor(action)?.fields ?? []
    }

    fieldValue (action: PreviewAction, key: string): string {
        return this.pendingFields[action.key]?.[key] ?? ''
    }

    setFieldValue (action: PreviewAction, key: string, value: string): void {
        this.pendingFields[action.key] = { ...this.pendingFields[action.key], [key]: value }
    }

    /** Only the entries actually filled in, as plain strings. */
    private filledFields (action: PreviewAction): Record<string, string> {
        const out: Record<string, string> = {}
        for (const [key, value] of Object.entries(this.pendingFields[action.key] ?? {})) {
            if (value) {
                out[key] = value
            }
        }
        return out
    }

    /** Every field the far end insists on has to be filled before Apply lights. */
    canApply (action: PreviewAction): boolean {
        if (this.applying) {
            return false
        }
        if (action.kind === 'button') {
            return true
        }
        const option = this.optionFor(action)
        if (!option) {
            return false
        }
        return option.fields.every(f => !f.required || this.fieldValue(action, f.key))
    }

    async apply (action: PreviewAction): Promise<void> {
        if (!this.handlers || !this.canApply(action)) {
            return
        }
        this.applying = action.key
        this.actionError = ''
        // Remembered before the change, because an undo is "the option whose
        // target is where we just came from" — and after the refresh that value
        // is gone.
        const cameFrom = action.currentState
        try {
            const error = await this.handlers.applyAction(
                action.key,
                this.chosen[action.key] ?? '',
                this.filledFields(action),
            )
            this.actionError = error
            if (!error) {
                this.undoTarget = cameFrom ? { actionKey: action.key, stateId: cameFrom } : null
                Reflect.deleteProperty(this.chosen, action.key)
                Reflect.deleteProperty(this.pendingFields, action.key)
            }
        } finally {
            this.applying = ''
            // The card is mounted by a decorator and driven from xterm's own
            // listeners, so it cannot rely on a zone tick arriving to show the
            // outcome. The pane does not need this; asking for it costs one
            // pass over a view that is already on screen.
            this.changeDetector.detectChanges()
        }
    }

    /**
     * The option that leads back to where we were, when the far end offers one.
     *
     * Jira workflows are frequently one-directional, so this is often absent —
     * in which case the card says nothing rather than offering an undo that
     * would fail.
     */
    undoOption (action: PreviewAction): PreviewActionOption | null {
        if (this.undoTarget?.actionKey !== action.key) {
            return null
        }
        const target = this.undoTarget.stateId
        return action.options.find(o => o.targetId && o.targetId === target) ?? null
    }

    async undo (action: PreviewAction): Promise<void> {
        const option = this.undoOption(action)
        if (!option) {
            return
        }
        this.chosen[action.key] = option.id
        this.undoTarget = null
        await this.apply(action)
    }

    optionBadgeBackground (option: PreviewActionOption): string {
        return `${badgeColor(option.color)}55`
    }

    badgeBackground (field: PreviewField): string {
        // Translucent over the card's own background: readable in either theme
        // without computing a contrasting foreground for every badge.
        return `${badgeColor(field.color)}55`
    }

    trackTab (_index: number, tab: PreviewTab): string {
        return tab.key
    }

    trackGroup (_index: number, group: PreviewGroup): string {
        return group.key
    }

    trackField (_index: number, field: PreviewField): string {
        return field.key
    }

    /** Distinct from the card's `trackAction`, which tracks a *rule's* buttons. */
    trackIntegrationAction (_index: number, action: PreviewAction): string {
        return action.key
    }

    trackItem (index: number): number {
        return index
    }

    // ── the html frame ───────────────────────────────────────────────────────

    /**
     * Write the plugin's document into the frame — but only when what is being
     * shown is new.
     *
     * This guard is the whole reason the model carries a key. The Linkifier
     * re-asks for a link on every rendered-viewport change that touches the
     * hovered row, which during output is many times a second; assigning
     * `srcdoc` reloads the frame and restarts the page's script, so rewriting it
     * on each pass would leave the card permanently blank and re-running.
     */
    sync (): void {
        const frame = this.htmlFrame?.nativeElement
        if (!frame) {
            this.appliedKey = ''
            return
        }
        if (this.appliedKey === this.model.key) {
            return
        }
        this.appliedKey = this.model.key
        this.frameLoads = 0
        frame.style.height = `${HTML_DEFAULT_HEIGHT}px`
        frame.srcdoc = buildHtmlDocument(
            this.model.preview?.html ?? '',
            this.model.preview?.data ?? {},
            this.model.target || this.model.text,
        )
    }

    /**
     * A sandboxed frame cannot navigate the top window, but nothing stops it
     * navigating *itself* — which would take `window.__data` along in a URL. The
     * document we wrote is the only one it gets; a second load means it went
     * somewhere, so it loses its contents.
     */
    onFrameLoad (): void {
        this.frameLoads++
        if (this.frameLoads > 1 && this.htmlFrame) {
            this.htmlFrame.nativeElement.srcdoc = ''
            this.appliedKey = ''
        }
    }

    /**
     * The page's side of the contract. The frame has an opaque origin, so
     * `event.origin` is the string "null" and proves nothing — identity of the
     * source window is what tells us this came from our own frame and not from
     * some other window that found us.
     */
    private onFrameMessage = (event: MessageEvent): void => {
        const frame = this.htmlFrame?.nativeElement
        if (!frame || event.source !== frame.contentWindow) {
            return
        }
        const message = parseHtmlHostMessage(event.data, this.maxHtmlHeight)
        if (!message) {
            return
        }
        if (message.height !== undefined) {
            frame.style.height = `${message.height}px`
            // A taller card may no longer fit where it was put.
            this.handlers?.htmlResized()
        }
        if (message.open !== undefined) {
            this.handlers?.htmlOpen(message.open)
        }
    }
}
