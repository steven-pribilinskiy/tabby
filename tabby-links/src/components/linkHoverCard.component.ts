import { ChangeDetectorRef, Component, ElementRef, ViewChild } from '@angular/core'

import { LinkPreview, LinkTooltipAction, PreviewField } from '../api'
import { badgeColor } from '../services/integrationRuntime.service'

/** Everything the card draws. Owned and updated by the decorator. */
export interface CardModel {
    text: string
    target: string
    hint: string
    maxWidth: number
    showOpen: boolean
    showCopyLink: boolean
    showCopyPath: boolean
    showReveal: boolean
    actions: LinkTooltipAction[]
    loading: boolean
    integrationName: string
    preview: LinkPreview | null
}

export interface CardHandlers {
    open: () => void
    copyLink: () => void
    copyPath: () => void
    reveal: () => void
    custom: (action: LinkTooltipAction) => void
    pointerEnter: () => void
    pointerLeave: () => void
}

export function emptyModel (): CardModel {
    return {
        text: '',
        target: '',
        hint: '',
        maxWidth: 640,
        showOpen: false,
        showCopyLink: false,
        showCopyPath: false,
        showReveal: false,
        actions: [],
        loading: false,
        integrationName: '',
        preview: null,
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
export class LinkHoverCardComponent {
    model: CardModel = emptyModel()
    handlers: CardHandlers | null = null

    @ViewChild('root') root?: ElementRef<HTMLElement>

    constructor (private changeDetector: ChangeDetectorRef) { }

    refresh (): void {
        // Everything that drives this component arrives from xterm's own DOM
        // listeners, which run outside Angular's zone, so a change-detection
        // pass has to be asked for explicitly.
        this.changeDetector.detectChanges()
    }

    get hasActions (): boolean {
        return this.model.showOpen || this.model.showCopyLink
            || this.model.showCopyPath || this.model.showReveal
            || !!this.model.actions.length
    }

    get showPreviewSection (): boolean {
        return this.model.loading || !!this.model.preview
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
}
