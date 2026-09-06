import { ChangeDetectorRef, Component, ElementRef, ViewChild } from '@angular/core'

import { LinkTooltipAction } from '../api'
import { PreviewHandlers, PreviewModel, emptyPreviewModel } from './linkPreviewView.component'

/**
 * Everything the card draws. Owned and updated by the decorator.
 *
 * The preview itself is `PreviewModel`, which the pane carries too — the card
 * adds only what a *hover* needs: the hint, the homograph warning, and which
 * buttons it offers.
 */
export interface CardModel extends PreviewModel {
    hint: string
    /**
     * The host's real ASCII form, when the link is not spelled the way it
     * resolves. Empty for every ordinary link.
     */
    punycode: string
    showOpen: boolean
    showCopyLink: boolean
    showCopyPath: boolean
    showReveal: boolean
    showInPane: boolean
    actions: LinkTooltipAction[]
}

export interface CardHandlers extends PreviewHandlers {
    open: () => void
    copyLink: () => void
    copyPath: () => void
    reveal: () => void
    /** Put this same preview in a pane, where there is room to read it. */
    showInPane: () => void
    custom: (action: LinkTooltipAction) => void
    pointerEnter: () => void
    pointerLeave: () => void
}

export function emptyModel (): CardModel {
    return {
        ...emptyPreviewModel(),
        hint: '',
        punycode: '',
        showOpen: false,
        showCopyLink: false,
        showCopyPath: false,
        showReveal: false,
        showInPane: false,
        actions: [],
    }
}

/**
 * The link hover card.
 *
 * Created imperatively by `LinkTooltipDecorator` and mounted inside
 * `.xterm-screen`, so it has no `@Input()`s in the usual sense — the decorator
 * writes `model` and calls `refresh()`.
 *
 * What the card *is* has not changed: a hover affordance, sized to the pane it
 * floats over. Everything below the link line is `link-preview-view`, which the
 * preview pane renders too.
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
        // pass has to be asked for explicitly. The preview's html frame is
        // written from the child's own `ngAfterViewChecked`, which this pass
        // runs.
        this.changeDetector.detectChanges()
    }

    get hasActions (): boolean {
        return this.model.showOpen || this.model.showCopyLink
            || this.model.showCopyPath || this.model.showReveal
            || this.model.showInPane
            || !!this.model.actions.length
    }

    trackAction (index: number, action: LinkTooltipAction): string {
        return `${index}:${action.name}`
    }
}
