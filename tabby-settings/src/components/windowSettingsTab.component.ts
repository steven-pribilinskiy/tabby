/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { debounce } from 'utils-decorators/dist/esm/debounce/debounce'
import { Component, HostBinding, Inject, NgZone, Optional } from '@angular/core'
import {
    DockingService,
    ConfigService,
    Theme,
    HostAppService,
    Platform,
    isWindowsBuild,
    WIN_BUILD_FLUENT_BG_SUPPORTED,
    BaseComponent,
    Screen,
    PlatformService,
} from 'tabby-core'


/** Shown by the swatch when the scheme's accent is not a plain hex colour. */
const ACCENT_FALLBACK = '#0275d8'

/** @hidden */
@Component({
    selector: 'window-settings-tab',
    templateUrl: './windowSettingsTab.component.pug',
})
export class WindowSettingsTabComponent extends BaseComponent {
    screens: Screen[]
    accentColor = ACCENT_FALLBACK
    Platform = Platform
    isFluentVibrancySupported = false

    @HostBinding('class.content-box') true

    constructor (
        public config: ConfigService,
        public hostApp: HostAppService,
        public platform: PlatformService,
        public zone: NgZone,
        @Inject(Theme) public themes: Theme[],
        @Optional() public docking?: DockingService,
    ) {
        super()

        this.themes = config.enabledServices(this.themes)

        const dockingService = docking
        if (dockingService) {
            this.subscribeUntilDestroyed(dockingService.screensChanged$, () => {
                this.zone.run(() => this.screens = dockingService.getScreens())
            })
            this.screens = dockingService.getScreens()
        }

        this.isFluentVibrancySupported = isWindowsBuild(WIN_BUILD_FLUENT_BG_SUPPORTED)
        this.readAccentColor()
        // The scheme can change under us — a theme swap, or the OS flipping
        // between light and dark — and the swatch has to follow.
        this.subscribeUntilDestroyed(config.changed$, () => this.readAccentColor())
    }

    setAccentColor (color: string | null): void {
        const value = color?.trim() ? color.trim() : null
        this.config.store.appearance.accentColor = value
        // Straight through rather than via readAccentColor(): the save is
        // debounced, so the variable still holds the old colour for half a
        // second and the swatch would visibly snap back to it. Clearing is the
        // other way round — what it resolves to is only known once the theme
        // has been re-applied, which config.changed$ reports.
        if (value) {
            this.accentColor = value
        }
        this.saveConfiguration()
    }

    /**
     * What the accent currently *is*, which is not the same as what is
     * configured: null there means "follow the color scheme", and a colour
     * input has no way to show that. So the swatch shows the resolved
     * variable while the text box stays empty until a colour is chosen.
     *
     * Read once and cached, never from the template — a getter bound in a
     * template runs on every change detection pass.
     */
    private readAccentColor (): void {
        const resolved = getComputedStyle(document.documentElement)
            .getPropertyValue('--theme-accent').trim()
        // A color input accepts only #rrggbb, and a scheme may have written a
        // name or an rgb() string.
        const parsed = /^#[0-9a-f]{6}$/i.exec(resolved)
        this.accentColor = parsed ? parsed[0] : ACCENT_FALLBACK
    }

    @debounce(500)
    saveConfiguration (requireRestart?: boolean) {
        this.config.save()
        if (requireRestart) {
            this.config.requestRestart()
        }
    }
}
