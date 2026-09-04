import { ChangeDetectorRef, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core'

import { LinkPreview, LinkTooltipAction, PreviewField } from '../api'
import { HTML_DEFAULT_HEIGHT, buildHtmlDocument, parseHtmlHostMessage } from '../htmlHost'
import { badgeColor } from '../services/integrationRuntime.service'

/** Everything the card draws. Owned and updated by the decorator. */
export interface CardModel {
    text: string
    target: string
    hint: string
    /**
     * The host's real ASCII form, when the link is not spelled the way it
     * resolves. Empty for every ordinary link.
     */
    punycode: string
    maxWidth: number
    showOpen: boolean
    showCopyLink: boolean
    showCopyPath: boolean
    showReveal: boolean
    actions: LinkTooltipAction[]
    loading: boolean
    integrationName: string
    preview: LinkPreview | null
    /**
     * Identity of what the card is showing. The frame's document is rewritten
     * only when this changes — see `syncHtmlFrame`.
     */
    key: string
    /** Whether a plugin's `html` may be rendered at all (`linkTooltip.allowHtml`). */
    allowHtml: boolean
}

export interface CardHandlers {
    open: () => void
    copyLink: () => void
    copyPath: () => void
    reveal: () => void
    custom: (action: LinkTooltipAction) => void
    pointerEnter: () => void
    pointerLeave: () => void
    /** The html frame changed size and the card needs placing again. */
    htmlResized: () => void
    /** The page asked for a link to be opened, the way the Open button would. */
    htmlOpen: (url: string) => void
}

export function emptyModel (): CardModel {
    return {
        text: '',
        target: '',
        hint: '',
        punycode: '',
        maxWidth: 640,
        showOpen: false,
        showCopyLink: false,
        showCopyPath: false,
        showReveal: false,
        actions: [],
        loading: false,
        integrationName: '',
        preview: null,
        key: '',
        allowHtml: true,
    }
}

/**
 * The link hover card.
 *
 * Created imperatively by `LinkTooltipDecorator` and mounted inside
 * `.xterm-screen`, so it has no `@Input()`s in the usual sense — the decorator
 * writes `model` and calls `refresh()`.
 */
@Component({
    selector: 'link-hover-card',
    templateUrl: './linkHoverCard.component.pug',
    styleUrls: ['./linkHoverCard.component.scss'],
})
export class LinkHoverCardComponent implements OnDestroy {
    model: CardModel = emptyModel()
    handlers: CardHandlers | null = null

    @ViewChild('root') root?: ElementRef<HTMLElement>
    @ViewChild('htmlFrame') htmlFrame?: ElementRef<HTMLIFrameElement>

    /** The card whose document is currently in the frame. */
    private appliedKey = ''
    private frameLoads = 0

    constructor (private changeDetector: ChangeDetectorRef) {
        window.addEventListener('message', this.onFrameMessage)
    }

    ngOnDestroy (): void {
        window.removeEventListener('message', this.onFrameMessage)
    }

    refresh (): void {
        // Everything that drives this component arrives from xterm's own DOM
        // listeners, which run outside Angular's zone, so a change-detection
        // pass has to be asked for explicitly.
        this.changeDetector.detectChanges()
        this.syncHtmlFrame()
    }

    get hasActions (): boolean {
        return this.model.showOpen || this.model.showCopyLink
            || this.model.showCopyPath || this.model.showReveal
            || !!this.model.actions.length
    }

    get showPreviewSection (): boolean {
        return this.model.loading || !!this.model.preview
    }

    /** Whether this card renders a plugin's document instead of the field list. */
    get showHtml (): boolean {
        return this.model.allowHtml && !!this.model.preview?.html && !this.model.preview.error
    }

    badgeBackground (field: PreviewField): string {
        // Translucent over the card's own background: readable in either theme
        // without computing a contrasting foreground for every badge.
        return `${badgeColor(field.color)}55`
    }

    trackField (_index: number, field: PreviewField): string {
        return field.key
    }

    trackAction (index: number, action: LinkTooltipAction): string {
        return `${index}:${action.name}`
    }

    // ── the html frame ───────────────────────────────────────────────────────

    /**
     * Write the plugin's document into the frame — but only when the card is
     * showing something new.
     *
     * This guard is the whole reason the model carries a key. The Linkifier
     * re-asks for a link on every rendered-viewport change that touches the
     * hovered row, which during output is many times a second; assigning
     * `srcdoc` reloads the frame and restarts the page's script, so rewriting it
     * on each pass would leave the card permanently blank and re-running.
     */
    private syncHtmlFrame (): void {
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
        const message = parseHtmlHostMessage(event.data)
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
