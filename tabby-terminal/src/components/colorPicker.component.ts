import { Component, Input, Output, EventEmitter, HostBinding } from '@angular/core'

/**
 * Relative luminance of a #rgb/#rrggbb colour, or null if it is not a hex value.
 * Avoids pulling the `color` package into this package just for one check.
 */
function hexLuminance (value: string): number|null {
    let hex = value.trim().replace(/^#/, '')
    if (hex.length === 3) {
        hex = hex.split('').map(c => c + c).join('')
    }
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
        return null
    }
    const channel = (v: number) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
    }
    const r = channel(parseInt(hex.slice(0, 2), 16))
    const g = channel(parseInt(hex.slice(2, 4), 16))
    const b = channel(parseInt(hex.slice(4, 6), 16))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** @hidden */
@Component({
    selector: 'color-picker',
    templateUrl: './colorPicker.component.pug',
    styleUrls: ['./colorPicker.component.scss'],
})
export class ColorPickerComponent {
    @Input() model: string
    @Input() title: string
    @Input() hint: string
    @Output() modelChange = new EventEmitter<string>()

    /**
     * `title` is also a native attribute, so Angular mirrors it onto the host and
     * the browser shows its own tooltip on top of the ngbTooltip hint.
     */
    @HostBinding('attr.title') hostTitle = null

    /**
     * The swatch label was always white, which disappeared on light swatches
     * (background, selection, ANSI 7/15) and on unset ones. Pick whichever of
     * black/white contrasts with the swatch itself.
     */
    get labelColor (): string {
        if (!this.model) {
            // Unset: the swatch is transparent, so follow the surrounding theme.
            return 'var(--theme-fg)'
        }
        const luminance = hexLuminance(this.model)
        if (luminance === null) {
            return '#fff'
        }
        return luminance > 0.4 ? '#000' : '#fff'
    }

    get labelShadow (): string {
        if (!this.model) {
            return 'none'
        }
        const luminance = hexLuminance(this.model)
        return luminance !== null && luminance > 0.4
            ? '0 1px 1px rgba(255,255,255,.5)'
            : '0 1px 1px rgba(0,0,0,.5)'
    }
}
