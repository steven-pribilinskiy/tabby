import { BaseTabComponent } from '../components/baseTab.component'

/**
 * Extend to show a rich card when a tab header is hovered.
 *
 * The tab header only ever had room for a title, so anything a tab knows about
 * itself beyond its name has had nowhere to surface. A provider can render
 * whatever it likes; the header falls back to its plain title tooltip when no
 * provider applies, so tabs without extra information are unaffected.
 *
 * The component is created lazily on hover and destroyed when the card closes,
 * so a provider costs nothing for tabs the user never hovers. It receives the
 * hovered tab as a `tab` input.
 */
export abstract class TabHoverProvider {
    /** Ordering; the lowest-weight applicable provider wins. */
    weight = 0

    /** Whether this provider has anything to say about the given tab. */
    abstract isApplicable (tab: BaseTabComponent): boolean

    abstract getComponentType (): any
}
