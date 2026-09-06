import { ChangeDetectorRef, Component, Injector, NgZone, OnInit } from '@angular/core'
import { BaseTabComponent, ConfigService } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

import { LinkMatchKind, LinkTooltipAction } from '../api'
import { HTML_PANE_MAX_HEIGHT } from '../htmlHost'
import { PreviewHandlers, PreviewModel, emptyPreviewModel } from './linkPreviewView.component'
import { IntegrationRuntimeService } from '../services/integrationRuntime.service'
import { LinkActionsService } from '../services/linkActions.service'

/**
 * Everything the pane needs to describe one link. Built by the decorator from
 * the card the user pressed "Show in pane" on, so the pane offers exactly the
 * buttons that card did rather than working any of it out a second time.
 */
export interface LinkPreviewRequest {
    kind: LinkMatchKind
    /** The text exactly as it appears in the terminal buffer. */
    text: string
    /** What Open and Copy link act on — a URI, or a text match's resolved link. */
    uri: string
    /** The local path the link resolves to, when it resolves to one. */
    filePath: string
    /** The rule's integration hint: '' picks automatically, 'none' refuses. */
    integration: string
    showOpen: boolean
    showCopyLink: boolean
    showCopyPath: boolean
    showReveal: boolean
    /** The matched rule's own buttons. */
    actions: LinkTooltipAction[]
    /** Whether a plugin's own document may be rendered (`linkTooltip.allowHtml`). */
    allowHtml: boolean
    /** The terminal the link was hovered in — a `sendInput` action needs it. */
    tab: BaseTerminalTabComponent<any> | null
}

export function emptyRequest (): LinkPreviewRequest {
    return {
        kind: 'link',
        text: '',
        uri: '',
        filePath: '',
        integration: '',
        showOpen: false,
        showCopyLink: false,
        showCopyPath: false,
        showReveal: false,
        actions: [],
        allowHtml: true,
        tab: null,
    }
}

/**
 * The preview pane: the same preview the hover card shows, in a tab of its own.
 *
 * This reverses a decision this package used to state in writing — that a
 * preview is a hover affordance and a plugin asking for room "does not get the
 * pane". The card is unchanged and still bounded by the terminal pane it floats
 * over; what this adds is somewhere to put a preview you want to *read*, which
 * a hover card can never be, because it disappears when you look away.
 *
 * It renders through `link-preview-view`, the same component the card renders
 * through. Nothing about how a preview is drawn is written twice, and the only
 * thing this passes it that the card does not is more room.
 */
@Component({
    selector: 'link-preview-tab',
    templateUrl: './linkPreviewTab.component.pug',
    styleUrls: ['./linkPreviewTab.component.scss'],
})
export class LinkPreviewTabComponent extends BaseTabComponent implements OnInit {
    /** Assigned by `LinkPanesService` through `TabsService.create`. */
    request: LinkPreviewRequest = emptyRequest()

    model: PreviewModel = emptyPreviewModel()
    handlers: PreviewHandlers
    /** A page may ask for a lot more room here than it may on the card. */
    readonly maxHtmlHeight = HTML_PANE_MAX_HEIGHT

    /** True once a fetch has finished and found nobody to answer. */
    unclaimed = false
    error = ''

    /** Bumped per load, so a slow fetch cannot paint over a newer one. */
    private generation = 0
    private alive = true

    constructor (
        injector: Injector,
        private zone: NgZone,
        private changeDetector: ChangeDetectorRef,
        private runtime: IntegrationRuntimeService,
        private actions: LinkActionsService,
        public config: ConfigService,
    ) {
        super(injector)
        this.icon = 'fas fa-link'
        this.setTitle('Preview')
        this.destroyed$.subscribe(() => {
            this.alive = false
        })
        this.handlers = {
            // The pane is exactly as big as the user made it, so a page saying
            // how tall it would like to be changes only the frame inside it.
            htmlResized: () => { /* nothing to re-place */ },
            // The same path the Open button takes, so the unsafe-scheme
            // confirmation still applies to a link a plugin's page offered.
            htmlOpen: (url: string) => void this.actions.open(url, ''),
            applyAction: async (actionKey: string, optionId: string, fields: Record<string, string>) => {
                const outcome = await this.runtime.applyAction(
                    this.request.kind, this.request.text, this.request.integration,
                    actionKey, optionId, fields)
                if (outcome.error) {
                    return outcome.error
                }
                // The action dropped the cached preview, so this shows the state
                // that was just created rather than the one it replaced.
                await this.load()
                return ''
            },
        }
    }

    ngOnInit (): void {
        this.setTitle(this.request.text || 'Preview')
        // Off this change-detection pass. `load` finishes synchronously when no
        // integration claims the link, and settling inside the pass that is
        // creating this view would re-enter change detection.
        void Promise.resolve().then(() => this.load())
    }

    /**
     * Whether hover cards are silenced while a preview pane is open.
     *
     * Kept in the config rather than on the pane, so the answer survives the
     * pane that set it — someone who works this way wants it on next time too.
     * It only *does* anything while a pane is open; `LinkPanesService` is what
     * joins the two.
     */
    get hideTooltips (): boolean {
        return this.config.store.linkTooltip?.hideTooltipsWithPane === true
    }

    set hideTooltips (value: boolean) {
        this.config.store.linkTooltip.hideTooltipsWithPane = value
        this.config.save()
    }

    get busy (): boolean {
        return this.model.loading
    }

    /**
     * What the link resolves to, when that is worth saying. A path wins over
     * the URI: for a `file://` link out of WSL the translated path is the
     * useful half, and for everything else they are the same string.
     */
    get resolved (): string {
        if (this.request.filePath) {
            return this.request.filePath
        }
        return this.request.uri === this.request.text ? '' : this.request.uri
    }

    async load (force = false): Promise<void> {
        const generation = ++this.generation
        if (force) {
            this.runtime.invalidate(this.request.kind, this.request.text, this.request.integration)
        }
        this.error = ''
        this.unclaimed = false
        this.model = { ...this.model, loading: true, allowHtml: this.request.allowHtml }
        if (this.request.integration === 'none'
            || !this.runtime.canPreview(this.request.kind, this.request.text, this.request.integration)) {
            this.settle(generation, null, true, '')
            return
        }
        let preview: Awaited<ReturnType<IntegrationRuntimeService['preview']>> = null
        let error = ''
        try {
            preview = await this.runtime.preview(
                this.request.kind, this.request.text, this.request.integration)
        } catch (err) {
            error = `${err}`
        }
        this.settle(generation, preview, !preview, error)
    }

    open (): void {
        void this.actions.open(this.request.uri, this.request.filePath)
    }

    copyLink (): void {
        this.actions.copy(this.request.uri)
    }

    copyPath (): void {
        this.actions.copy(this.request.filePath)
    }

    reveal (): void {
        this.actions.reveal(this.request.filePath)
    }

    custom (action: LinkTooltipAction): void {
        void this.actions.runCustom(action, this.request.uri, this.request.tab)
    }

    refresh (): void {
        void this.load(true)
    }

    close (): void {
        this.destroy()
    }

    trackAction (index: number, action: LinkTooltipAction): string {
        return `${index}:${action.name}`
    }

    /**
     * One place where a load ends, so the generation guard and the
     * change-detection nudge are stated once.
     *
     * The nudge is not optional: an action applied from the card's own renderer
     * and a fetch started before the tab was ever focused both resolve outside
     * whatever pass would otherwise have drawn the result.
     */
    private settle (
        generation: number,
        preview: Awaited<ReturnType<IntegrationRuntimeService['preview']>>,
        unclaimed: boolean,
        error: string,
    ): void {
        if (generation !== this.generation || !this.alive) {
            return
        }
        this.zone.run(() => {
            this.unclaimed = unclaimed && !error
            this.error = error
            this.model = {
                ...this.model,
                loading: false,
                preview,
                integrationName: preview?.integrationName ?? '',
                text: this.request.text,
                target: this.request.uri,
                allowHtml: this.request.allowHtml,
                // Identity of what is on screen, which is what tells the shared
                // renderer to write a plugin's document into its frame again.
                // Keyed on the load and not on the link, so Refresh really does
                // re-run the page.
                key: `pane:${this.request.text}:${generation}`,
            }
            this.changeDetector.detectChanges()
        })
    }
}
