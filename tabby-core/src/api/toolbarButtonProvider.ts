import { Observable } from 'rxjs'

/**
 * See [[ToolbarButtonProvider]]
 */
export interface ToolbarButton {
    /**
     * Raw SVG icon code
     */
    icon?: string

    title: string

    /**
     * Optional Touch Bar icon ID
     */
    touchBarNSImage?: string

    /**
     * Optional Touch Bar button label
     */
    touchBarTitle?: string

    weight?: number

    click?: () => void

    submenu?: () => Promise<ToolbarButton[]>

    /** @hidden */
    submenuItems?: ToolbarButton[]
}

/**
 * Extend to add buttons to the toolbar
 */
export abstract class ToolbarButtonProvider {
    abstract provide (): ToolbarButton[]

    /**
     * Emit to have the toolbar ask for the buttons again.
     *
     * Without this the toolbar is built once, on config load, and a provider
     * whose buttons depend on something discovered later — an update that
     * appears, a device that is plugged in — can only ever contribute what it
     * knew at startup.
     */
    readonly changed$?: Observable<void>
}
