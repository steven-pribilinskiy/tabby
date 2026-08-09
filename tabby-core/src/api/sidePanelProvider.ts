/**
 * Extend to contribute a panel that docks to an edge of the window.
 *
 * Tabby's other extension points are all scoped to a tab (decorators, context
 * menus, recovery) or to the toolbar. A panel is neither: it is app-level
 * chrome that outlives the active tab and sits alongside the terminal area, so
 * it needs its own registration point. `profile-tree` is the built-in
 * precedent, but it is hardcoded into the app root and cannot be extended.
 *
 * Registered panels appear in the dock host; the user chooses which edge it
 * docks to and how large it is, so a provider never positions itself.
 */
export abstract class SidePanelProvider {
    /** Stable identifier, persisted in config as the selected panel. */
    abstract id: string

    /** Shown in the panel's header and in the picker. */
    abstract name: string

    /** Raw SVG icon code, as with [[ToolbarButton]]. */
    icon?: string

    /** Ordering among panels; lower sorts first. */
    weight = 0

    /**
     * The component rendered inside the dock. It is instantiated once and kept
     * alive while the panel is selected.
     */
    abstract getComponentType (): any

    /**
     * Allows a panel to hide itself entirely — e.g. a feature the user has
     * turned off. Re-evaluated whenever the config changes.
     */
    isAvailable (): boolean {
        return true
    }
}
