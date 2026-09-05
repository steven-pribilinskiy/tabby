import { ApplicationRef, ComponentRef, createComponent, EnvironmentInjector, Inject, Injectable, NgZone, Optional } from '@angular/core'
import { ConfigService, HostAppService, Platform } from 'tabby-core'
import { LinkHandler } from 'tabby-linkifier'
import { BaseTerminalTabComponent, TerminalDecorator, XTermFrontend } from 'tabby-terminal'

import { LinkMatchKind, LinkPreview, LinkTooltipAction, LinkTooltipRule } from './api'
import { CardModel, CardHandlers, LinkHoverCardComponent, emptyModel } from './components/linkHoverCard.component'
import { BufferRange, getLineWindow, rangeFor } from './linkComputer'
import { MAX_TEXT_INPUT } from './regexGuard'
import { IntegrationRuntimeService } from './services/integrationRuntime.service'
import { LinkActionsService } from './services/linkActions.service'
import { LinkRulesService } from './services/linkRules.service'
import { LinkTargetService, punycodeHost } from './services/linkTarget.service'

interface HoveredLink {
    kind: LinkMatchKind
    text: string
    range: BufferRange
    handlerIndex: number
    rule: LinkTooltipRule | null
}

interface TabState {
    tab: BaseTerminalTabComponent<any>
    xterm: any
    core: any
    screen: HTMLElement
    componentRef: ComponentRef<LinkHoverCardComponent>
    host: HTMLElement
    disposables: { dispose: () => void }[]
    showTimer: any
    hideTimer: any
    /** Identity of what the card currently describes, so output cannot rebuild it. */
    shownKey: string
    /** Bumped on every hover so a stale preview cannot paint over a newer one. */
    generation: number
    pointerInCard: boolean
    hovered: HoveredLink | null
    /**
     * The rule that won for the card on screen, resolved against the link's
     * real path. Kept so hiding uses the same answer showing did.
     */
    settings: ReturnType<LinkRulesService['resolve']> | null
}

@Injectable()
export class LinkTooltipDecorator extends TerminalDecorator {
    private states = new Map<BaseTerminalTabComponent<any>, TabState>()

    constructor (
        private config: ConfigService,
        private zone: NgZone,
        private appRef: ApplicationRef,
        private injector: EnvironmentInjector,
        private hostApp: HostAppService,
        private rules: LinkRulesService,
        private targets: LinkTargetService,
        private actions: LinkActionsService,
        private runtime: IntegrationRuntimeService,
        @Optional() @Inject(LinkHandler) private handlers: LinkHandler[] | null,
    ) {
        super()
        if (!this.handlers?.length) {
            // Resolution of `tabby-linkifier` happens through NODE_PATH rather
            // than a node_modules symlink on Windows, and a miss there produces
            // an empty array rather than an error. Say so once, loudly, instead
            // of silently linkifying nothing.
            console.warn('[tabby-links] No LinkHandler providers found — links will not be detected.')
        }
    }

    attach (tab: BaseTerminalTabComponent<any>): void {
        if (!(tab.frontend instanceof XTermFrontend)) {
            return
        }
        const xterm = (tab.frontend as any).xterm
        const core = xterm._core
        const screen: HTMLElement | undefined = core?.screenElement
        if (!screen) {
            return
        }

        const componentRef = createComponent(LinkHoverCardComponent, {
            environmentInjector: this.injector,
        })
        // Without this the view is outside the change-detection tree entirely,
        // and the card renders once and then never updates — which is exactly
        // what an async preview needs to do.
        this.appRef.attachView(componentRef.hostView)

        const host = componentRef.location.nativeElement as HTMLElement
        // `xterm-hover` is xterm's own contract: a mousemove whose composedPath
        // hits this class before `.xterm` is ignored by the Linkifier, so the
        // card does not clear itself the moment the pointer reaches it.
        host.classList.add('xterm-hover', 'link-hover-card-host')
        host.style.position = 'fixed'
        host.style.left = '0'
        host.style.top = '0'
        host.style.zIndex = '11'
        host.style.display = 'none'
        this.swallowPointerEvents(host)
        screen.appendChild(host)

        const state: TabState = {
            tab, xterm, core, screen, componentRef, host,
            disposables: [],
            showTimer: null,
            hideTimer: null,
            shownKey: '',
            generation: 0,
            pointerInCard: false,
            hovered: null,
            settings: null,
        }
        componentRef.instance.handlers = this.cardHandlers(state)
        this.states.set(tab, state)

        const registration = xterm.registerLinkProvider({
            provideLinks: (y: number, callback: (links: any[] | undefined) => void) =>
                this.provideLinks(state, y, callback),
        })
        state.disposables.push(registration)
        this.promoteProvider(core)
        this.wrapLinkHandler(state)
        // `tabby-linkifier` writes `options.linkHandler` from its own decorator,
        // and only one of us can be last. Re-wrapping on the next frame makes the
        // attach order irrelevant instead of relying on it.
        setTimeout(() => this.wrapLinkHandler(state), 0)
    }

    detach (tab: BaseTerminalTabComponent<any>): void {
        super.detach(tab)
        // By the time this runs the tab has already cleared `frontend`, so
        // everything needed to clean up has to come from our own record.
        const state = this.states.get(tab)
        if (!state) {
            return
        }
        this.states.delete(tab)
        clearTimeout(state.showTimer)
        clearTimeout(state.hideTimer)
        for (const disposable of state.disposables) {
            try {
                disposable.dispose()
            } catch { /* the terminal may already be gone */ }
        }
        try {
            this.appRef.detachView(state.componentRef.hostView)
            state.componentRef.destroy()
            state.host.remove()
        } catch { /* ditto */ }
    }

    // ── detection ────────────────────────────────────────────────────────────

    /**
     * xterm calls this once per buffer row the pointer enters.
     *
     * The callback **must** fire exactly once on every path. xterm's own
     * `OscLinkProvider` sits at index 0 and always answers with an array — which
     * is truthy — so our links only ever arrive through the "every provider has
     * replied" pass. A provider that never calls back silently stops every
     * provider after it from ever producing a hover again.
     */
    private provideLinks (state: TabState, y: number, callback: (links: any[] | undefined) => void): void {
        let links: any[] | undefined = undefined
        try {
            links = this.computeLinks(state, y)
        } catch (err) {
            console.warn('[tabby-links] link provider failed', err)
            links = undefined
        } finally {
            callback(links)
        }
    }

    private computeLinks (state: TabState, y: number): any[] | undefined {
        if (!this.rules.detectLinks) {
            // Returning nothing lets whatever else is registered take over, so
            // the setting is live without any re-attach machinery.
            return undefined
        }
        const window = getLineWindow(state.xterm, y - 1)
        if (!window.text) {
            return undefined
        }

        const found: HoveredLink[] = []
        const claimed: { start: number, end: number, priority: number }[] = []

        const consider = (
            index: number,
            text: string,
            priority: number,
            make: (range: BufferRange) => HoveredLink,
        ) => {
            const end = index + text.length
            // A higher-priority handler already owning these cells wins; that is
            // what `LinkHandler.priority` is for, and the combined regex the
            // linkifier builds could never honour it.
            if (claimed.some(c => index < c.end && end > c.start && c.priority >= priority)) {
                return
            }
            const range = rangeFor(state.xterm, window.startLineIndex, index, text.length)
            if (!range) {
                return
            }
            claimed.push({ start: index, end, priority })
            found.push(make(range))
        }

        // Text rules first: they are the more specific statement of intent, and
        // an issue key inside a URL should still read as the URL.
        for (const { rule, search } of this.rules.textRules()) {
            if (!search) {
                continue
            }
            for (const match of search.execAll(window.text.substring(0, MAX_TEXT_INPUT))) {
                consider(match.index, match[0], 100, range => ({
                    kind: 'text', text: match[0], range, handlerIndex: -1, rule,
                }))
            }
        }

        // Then each link handler separately, so we know which one matched and
        // can honour its priority and its own convert/verify/handle.
        const handlers = this.handlers ?? []
        for (let i = 0; i < handlers.length; i++) {
            const handler = handlers[i]
            let regex = /(?:)/
            try {
                regex = new RegExp(handler.regex.source, `${handler.regex.flags.replace('g', '')}g`)
            } catch {
                continue
            }
            let guard = 0
            let match: RegExpExecArray | null = regex.exec(window.text)
            while (match && guard++ < 64) {
                if (match[0].length === 0) {
                    regex.lastIndex++
                    match = regex.exec(window.text)
                    continue
                }
                const text = match[0]
                const index = match.index
                consider(index, text, handler.priority, range => ({
                    kind: 'link', text, range, handlerIndex: i, rule: null,
                }))
                match = regex.exec(window.text)
            }
        }

        if (!found.length) {
            return undefined
        }
        // Fresh objects every call: the Linkifier replaces `decorations` with
        // its own accessor pair on whatever it is handed.
        return found.map(link => ({
            range: link.range,
            text: link.text,
            activate: (event: MouseEvent) => this.activate(state, link, event),
            hover: () => this.onHover(state, link),
            leave: () => this.onLeave(state),
            dispose: () => { /* nothing per-link to release */ },
        }))
    }

    /**
     * Put our provider immediately after xterm's OSC 8 provider.
     *
     * Providers are consulted in registration order and the first one with a
     * link at the position wins, so leaving this to decorator ordering would
     * mean `WebLinksAddon` shadowing us — with no hover, and with its `isUrl()`
     * filter still dropping file paths and bare IPs.
     */
    private promoteProvider (core: any): void {
        const providers: any[] = core?._linkProviderService?.linkProviders
        if (!Array.isArray(providers) || providers.length < 2) {
            return
        }
        const ours = providers.pop()
        providers.splice(1, 0, ours)
    }

    /** Add hover/leave to whatever OSC 8 handler is already installed. */
    private wrapLinkHandler (state: TabState): void {
        const existing = state.xterm.options.linkHandler
        if (existing?.__tabbyLinksWrapped) {
            return
        }
        state.xterm.options.linkHandler = {
            __tabbyLinksWrapped: true,
            allowNonHttpProtocols: existing?.allowNonHttpProtocols,
            activate: (event: MouseEvent, uri: string, range: BufferRange) => {
                existing?.activate?.(event, uri, range)
            },
            hover: (_event: MouseEvent, uri: string, range: BufferRange) => {
                this.onHover(state, { kind: 'link', text: uri, range, handlerIndex: -1, rule: null })
            },
            leave: () => this.onLeave(state),
        }
    }

    // ── hover lifecycle ──────────────────────────────────────────────────────

    private onHover (state: TabState, link: HoveredLink): void {
        if (!this.rules.enabled) {
            return
        }
        const key = `${link.kind}:${link.text}:${link.range.start.y}:${link.range.start.x}`
        clearTimeout(state.hideTimer)
        if (state.shownKey === key) {
            // The Linkifier re-asks on every rendered-viewport change touching
            // the hovered row, so during output this fires many times a second
            // for the same link. Rebuilding here would strobe the card and
            // restart its fetch on every frame.
            return
        }
        state.hovered = link
        const settings = this.rules.resolve(link.kind, link.text, '', link.rule)
        clearTimeout(state.showTimer)
        const show = () => this.show(state, link, settings, key)
        if (settings.showDelay > 0) {
            state.showTimer = setTimeout(show, settings.showDelay)
        } else {
            show()
        }
    }

    private onLeave (state: TabState): void {
        clearTimeout(state.showTimer)
        // Prefer the answer `show` arrived at: it knew the link's kind and its
        // resolved path, so a rule keyed on either has already been applied.
        // Falling back re-resolves without them, which is all that is available
        // when the pointer leaves before anything was shown.
        const settings = state.settings
            ?? this.rules.resolve(
                state.hovered?.kind ?? 'link',
                state.hovered?.text ?? '',
                '',
                state.hovered?.rule ?? null,
            )
        clearTimeout(state.hideTimer)
        // Not hidden immediately: the delay is the time available to move the
        // pointer onto the card and use its buttons.
        state.hideTimer = setTimeout(() => {
            if (!state.pointerInCard) {
                this.hide(state)
            }
        }, Math.max(0, settings.hideDelay))
    }

    private async show (
        state: TabState,
        link: HoveredLink,
        timing: ReturnType<LinkRulesService['resolve']>,
        key: string,
    ): Promise<void> {
        const generation = ++state.generation
        state.shownKey = key
        let settings = timing

        const handler = link.handlerIndex >= 0 ? this.handlers?.[link.handlerIndex] : undefined
        let converted = link.text
        if (handler) {
            try {
                converted = await handler.convert(link.text, state.tab)
            } catch {
                converted = link.text
            }
        }
        // Not gated on `handler.verify()` any more: it tests the path as
        // written, which for a WSL tab is a path Windows cannot see, so the
        // translation that would have made it real never ran. `resolve` decides
        // what the link points at and then asks whether *that* exists. It also
        // means an OSC 8 `file://` link, which arrives with no handler at all,
        // now resolves like any other path.
        const target = await this.targets.resolve(link.text, converted, state.tab)
        if (generation !== state.generation) {
            return
        }

        // Now that the link has been resolved to a path, ask the rules again.
        // `fileTypeGroup` and `extensions` can only be judged against a path,
        // and resolving one costs a `convert`/`verify` round trip — so the first
        // pass, the one that decided how long to wait before showing anything,
        // could not see it. Everything the card actually renders comes from this
        // second answer; only the show delay is the earlier one's.
        if (target.filePath) {
            settings = this.rules.resolve(link.kind, link.text, target.filePath, link.rule)
        }
        state.settings = settings

        const model = emptyModel()
        model.text = link.text
        model.target = target.display
        model.maxWidth = settings.maxWidth
        // The card's identity, so the html frame is written once per link
        // rather than on every re-ask. Same key the hover path dedupes on.
        model.key = key
        model.allowHtml = this.config.store.linkTooltip.allowHtml !== false
        model.hint = link.kind === 'text' ? '' : this.followHint()
        model.punycode = link.kind === 'link' ? punycodeHost(link.text) : ''
        const hasLink = link.kind === 'link' || !!this.runtime.resolveTextLink(link.text, settings.integration)
        model.showOpen = settings.showOpen && hasLink
        model.showCopyLink = settings.showCopyLink && hasLink
        model.showCopyPath = settings.showCopyPath && !!target.filePath
        model.showReveal = settings.showReveal && !!target.filePath
        model.actions = settings.actions

        const wantsPreview = settings.showPreview
            && settings.integration !== 'none'
            && this.runtime.canPreview(link.kind, link.text, settings.integration)
        model.loading = wantsPreview

        this.render(state, model, link, target.filePath, settings.integration)

        if (!wantsPreview) {
            return
        }
        let preview: Awaited<ReturnType<IntegrationRuntimeService['preview']>> = null
        try {
            preview = await this.runtime.preview(link.kind, link.text, settings.integration)
        } catch (err) {
            console.warn('[tabby-links] preview failed', err)
        }
        if (generation !== state.generation) {
            return
        }
        model.loading = false
        model.preview = preview
        model.integrationName = preview?.integrationName ?? ''
        if (preview?.link && link.kind === 'text') {
            // A text match only becomes openable once an integration says what
            // it refers to.
            model.target = preview.link
            model.showOpen = settings.showOpen
            model.showCopyLink = settings.showCopyLink
        }
        this.render(state, model, link, target.filePath, settings.integration)
    }

    private render (
        state: TabState,
        model: CardModel,
        link: HoveredLink,
        filePath: string,
        integration: string,
    ): void {
        this.zone.run(() => {
            const instance = state.componentRef.instance
            instance.model = model
            instance.handlers = this.cardHandlers(state, link, filePath, integration)
            state.host.style.display = ''
            instance.refresh()
            this.position(state, link.range)
        })
    }

    private hide (state: TabState): void {
        state.shownKey = ''
        state.hovered = null
        state.settings = null
        state.generation++
        state.host.style.display = 'none'
    }

    // ── positioning ──────────────────────────────────────────────────────────

    /**
     * Anchor the card under the hovered cell, flipping and clamping so it stays
     * on screen.
     *
     * The card is `position: fixed` because `.content` — the element xterm is
     * mounted in — is `overflow: hidden`, and an absolutely positioned card
     * would simply be cut off near a pane edge. Fixed does not mean "relative to
     * the window" here, though: `app-root` sets `will-change: transform` and a
     * maximized split pane sets `backdrop-filter`, either of which makes *it*
     * the containing block. Measuring the element's own origin at translate(0,0)
     * sidesteps the question of which ancestor won.
     */
    private position (state: TabState, range: BufferRange): void {
        const host = state.host
        host.style.transform = 'translate(0px, 0px)'
        const origin = host.getBoundingClientRect()
        const screen = state.screen.getBoundingClientRect()
        const cell = this.cellSize(state)
        const viewportY = state.xterm.buffer.active.viewportY ?? 0
        const row = range.start.y - 1 - viewportY
        const column = range.start.x - 1

        const cellLeft = screen.left + column * cell.width
        const cellTop = screen.top + row * cell.height
        const cellBottom = cellTop + cell.height

        const margin = 6
        const maxX = Math.max(margin, window.innerWidth - origin.width - margin)
        const maxY = Math.max(margin, window.innerHeight - origin.height - margin)

        let x = cellLeft
        let y = cellBottom + 2
        if (y > maxY) {
            // No room below — put it above the line rather than over it.
            y = cellTop - origin.height - 2
        }
        if (x > maxX) {
            x = cellLeft + cell.width - origin.width
        }
        x = Math.min(Math.max(x, margin), maxX)
        y = Math.min(Math.max(y, margin), maxY)

        host.style.transform = `translate(${Math.round(x - origin.left)}px, ${Math.round(y - origin.top)}px)`
    }

    private cellSize (state: TabState): { width: number, height: number } {
        const dimensions = state.core?._renderService?.dimensions?.css?.cell
        if (dimensions?.width > 0 && dimensions?.height > 0) {
            return { width: dimensions.width, height: dimensions.height }
        }
        // Good enough to place a card if the renderer has not measured yet.
        const rect = state.screen.getBoundingClientRect()
        return {
            width: rect.width / Math.max(1, state.xterm.cols),
            height: rect.height / Math.max(1, state.xterm.rows),
        }
    }

    // ── interaction ──────────────────────────────────────────────────────────

    /**
     * The card sits inside `.xterm-screen`, where xterm and Tabby both listen:
     * a mouseup would *also* activate the link under the card, a mousedown would
     * start a selection drag, and middle- or right-click would paste. Every one
     * of those has to stop here.
     */
    private swallowPointerEvents (host: HTMLElement): void {
        const stop = (event: Event) => event.stopPropagation()
        for (const name of ['mouseup', 'click', 'auxclick', 'contextmenu', 'dblclick', 'wheel']) {
            host.addEventListener(name, stop)
        }
        host.addEventListener('mousedown', event => {
            event.stopPropagation()
            // Also prevented, or the terminal underneath starts selecting text
            // the moment a button is pressed.
            event.preventDefault()
        })
    }

    private cardHandlers (
        state: TabState,
        link?: HoveredLink,
        filePath = '',
        integration = '',
    ): CardHandlers {
        const uri = () => {
            if (!link) {
                return ''
            }
            if (link.kind === 'text') {
                return this.runtime.resolveTextLink(link.text, integration) || link.text
            }
            return link.text
        }
        return {
            open: () => void this.actions.open(uri(), filePath),
            copyLink: () => this.actions.copy(uri()),
            copyPath: () => this.actions.copy(filePath),
            reveal: () => this.actions.reveal(filePath),
            custom: (action: LinkTooltipAction) => void this.actions.runCustom(action, uri(), state.tab),
            pointerEnter: () => {
                state.pointerInCard = true
                clearTimeout(state.hideTimer)
            },
            pointerLeave: () => {
                state.pointerInCard = false
                this.onLeave(state)
            },
            htmlResized: () => {
                // The frame grew or shrank, so where the card fits has changed.
                // Nothing else about it has, so this only re-places it.
                if (state.hovered) {
                    this.position(state, state.hovered.range)
                }
            },
            // Down the same path the Open button takes, so the unsafe-scheme
            // confirmation and the file:// resolution still apply — a plugin's
            // page does not get a way around them by asking nicely.
            htmlOpen: (url: string) => void this.actions.open(url, ''),
            applyAction: async (actionKey: string, optionId: string, fields: Record<string, string>) => {
                if (!link) {
                    return 'Nothing is hovered'
                }
                const outcome = await this.runtime.applyAction(
                    link.kind, link.text, integration, actionKey, optionId, fields)
                if (outcome.error) {
                    return outcome.error
                }
                // The action dropped the cached preview, so this re-fetches and
                // the card shows the state that was just created rather than
                // the one it replaced.
                await this.refreshPreview(state, link, integration)
                return ''
            },
        }
    }

    /**
     * Re-run the preview for the card on screen, in place.
     *
     * Deliberately not a full `show()`: the card is already up, the pointer is
     * inside it, and rebuilding would restart the show/hide timers underneath
     * someone who is mid-interaction.
     */
    private async refreshPreview (
        state: TabState,
        link: HoveredLink,
        integration: string,
    ): Promise<void> {
        const generation = state.generation
        let preview: LinkPreview | null = null
        try {
            preview = await this.runtime.preview(link.kind, link.text, integration)
        } catch (err) {
            console.warn('[tabby-links] refresh after action failed', err)
            return
        }
        if (generation !== state.generation) {
            return
        }
        this.zone.run(() => {
            const instance = state.componentRef.instance
            instance.model.preview = preview
            instance.refresh()
            this.position(state, link.range)
        })
    }

    private activate (state: TabState, link: HoveredLink, event: MouseEvent): void {
        const modifier = this.config.store.clickableLinks?.modifier
        if (modifier && !event[modifier]) {
            return
        }
        if (link.kind === 'text') {
            const resolved = this.runtime.resolveTextLink(link.text, link.rule?.integration ?? '')
            if (resolved) {
                void this.actions.open(resolved, '')
            }
            return
        }
        const handler = link.handlerIndex >= 0 ? this.handlers?.[link.handlerIndex] : undefined
        if (!handler) {
            void this.actions.open(link.text, '')
            return
        }
        void (async () => {
            const converted = await handler.convert(link.text, state.tab)
            const target = await this.targets.resolve(link.text, converted, state.tab)
            if (target.filePath && target.filePath !== converted) {
                // Translation changed the path, so the handler's own `verify`
                // would refuse it and `handle` would hand the shell a path it
                // cannot open — a WSL path being the whole case. Open what the
                // card said it would open, by the same route its button takes.
                void this.actions.open('', target.filePath)
                return
            }
            if (!await handler.verify(converted, state.tab)) {
                return
            }
            handler.handle(converted, state.tab)
        })()
    }

    private followHint (): string {
        const modifier = this.config.store.clickableLinks?.modifier
        if (!modifier) {
            return 'Click to follow link'
        }
        return this.hostApp.platform === Platform.macOS && modifier === 'metaKey'
            ? '⌘+Click to follow link'
            : 'Ctrl+Click to follow link'
    }
}
