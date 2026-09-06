import * as glasstron from 'glasstron'
import { autoUpdater } from 'electron-updater'
import { Subject, Observable, debounceTime } from 'rxjs'
import { BrowserWindow, app, ipcMain, Rectangle, Menu, screen, BrowserWindowConstructorOptions, TouchBar, nativeImage, WebContents, nativeTheme } from 'electron'
import { enable as enableRemote } from '@electron/remote/main'
import * as os from 'os'
import * as path from 'path'
import macOSRelease from 'macos-release'
import { compare as compareVersions } from 'compare-versions'

import type { Application } from './app'
import { parseArgs } from './cli'
import { note, recordFailure } from './diagnostics'
import { parseTabbyURL, isTabbyURL } from './urlHandler'
import { claimSlot, describe, placeWindow, releaseSlot, saveGeometry } from './windowGeometry'

let DwmEnableBlurBehindWindow: any = null
if (process.platform === 'win32') {
    DwmEnableBlurBehindWindow = require('@tabby-gang/windows-blurbehind').DwmEnableBlurBehindWindow
}

export interface WindowOptions {
    hidden?: boolean
    /** Recovery token of a tab to open in the new window (see hostApp.newWindow) */
    initialTab?: any
}

abstract class GlasstronWindow extends BrowserWindow {
    blurType: string
    abstract setBlur (_: boolean)
}

const macOSVibrancyType: any = process.platform === 'darwin' ? compareVersions(macOSRelease().version || '0.0', '10.14', '>=') ? 'fullscreen-ui' : 'dark' : null

const activityIcon = nativeImage.createFromPath(`${app.getAppPath()}/assets/activity.png`)

export class Window {
    ready: Promise<void>
    isMainWindow = false
    webContents: WebContents
    private visible = new Subject<boolean>()
    private closed = new Subject<void>()
    private window?: GlasstronWindow
    private windowBounds?: Rectangle
    /** Which remembered geometry this window is. See ./windowGeometry. */
    private geometrySlot: number
    private savedGeometry: string | null = null
    private closing = false
    private lastVibrancy: { enabled: boolean, type?: string } | null = null
    private disableVibrancyWhileDragging = false
    private touchBarControl: any
    private isFluentVibrancy = false
    private dockHidden = false
    private options: WindowOptions

    get visible$ (): Observable<boolean> { return this.visible }
    get closed$ (): Observable<void> { return this.closed }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    constructor (private application: Application, private configStore: any, options?: WindowOptions) {
        options = options ?? {}
        this.options = options

        this.geometrySlot = claimSlot()

        // Full HD for a first run, clamped to the work area: 1080 does not fit
        // a 1080-tall display once the taskbar is out of it, and a smaller
        // screen would otherwise get a window hanging off the bottom. Only a
        // slot with nothing remembered uses this at all.
        const workArea = screen.getPrimaryDisplay().workAreaSize
        const placement = placeWindow(this.geometrySlot, {
            width: Math.min(1920, workArea.width),
            height: Math.min(1080, workArea.height),
        })
        const maximized = placement.maximized

        const bwOptions: BrowserWindowConstructorOptions = {
            ...placement.bounds,
            title: 'Tabby',
            minWidth: 400,
            minHeight: 300,
            webPreferences: {
                nodeIntegration: true,
                preload: path.join(__dirname, 'sentry.js'),
                backgroundThrottling: false,
                contextIsolation: false,
            },
            maximizable: true,
            frame: false,
            show: false,
            // A transparent backing surface makes Chromium fall back from
            // subpixel to grayscale antialiasing, which renders text thin with a
            // halo around every glyph — invisible on dark themes, very visible on
            // light. Only go transparent when vibrancy actually needs it.
            backgroundColor: this.configStore.appearance?.vibrancy
                ? '#00000000'
                : (nativeTheme.shouldUseDarkColors ? '#131d27' : '#ffffff'),
            acceptFirstMouse: true,
        }

        if (this.configStore.appearance?.frame === 'native') {
            bwOptions.frame = true
        } else {
            bwOptions.titleBarStyle = 'hidden'
            if (process.platform === 'win32') {
                bwOptions.titleBarOverlay = {
                    color: '#00000000',
                }
            }
        }

        if (process.platform === 'darwin') {
            bwOptions.visualEffectState = 'active'
        }

        if (process.platform === 'darwin') {
            this.window = new BrowserWindow(bwOptions) as GlasstronWindow
        } else {
            this.window = new glasstron.BrowserWindow(bwOptions)
        }

        if (placement.source !== 'default') {
            // The constructor's width and height are not what `getBounds()`
            // reports back — measured on Windows, consistently 2px taller for a
            // frameless window — so a rectangle that came from `getBounds()`
            // and goes back in through the constructor grows a little every
            // time it round-trips, and a window that is only ever opened and
            // closed creeps down the screen. `setBounds` is exact, so applying
            // the same rectangle once more is what stops the drift.
            this.window.setBounds(placement.bounds as Rectangle)
        }

        this.webContents = this.window.webContents
        // Where it actually landed, not where we asked it to: a window opened
        // by cascade and never touched is still worth remembering, and this is
        // the only place it is known before the first move event.
        this.windowBounds = this.window.getBounds()

        this.window.webContents.once('did-finish-load', () => {
            if (process.platform === 'darwin') {
                this.window.setVibrancy(macOSVibrancyType)
            } else if (process.platform === 'win32' && this.configStore.appearance?.vibrancy) {
                this.setVibrancy(true)
            }

            // Must match appearance.colorSchemeMode in configDefaults.yaml —
            // this reads the raw stored config, which is not merged with defaults.
            this.setDarkMode(this.configStore.appearance?.colorSchemeMode ?? 'auto')

            if (!options.hidden) {
                if (maximized) {
                    this.window.maximize()
                } else {
                    this.window.show()
                }
                this.window.focus()
                this.window.moveTop()
                application.focus()
            }
        })

        // Chromium's own verdict on the renderer, from outside it. It is a
        // weaker signal than the renderer's stall detector — a window can be
        // frozen for a minute without ever being called unresponsive — but it
        // costs nothing and it still fires when the renderer is too wedged to
        // report on itself.
        let unresponsiveSince = 0
        this.window.on('unresponsive', () => {
            unresponsiveSince = Date.now()
            note('window-unresponsive')
        })
        this.window.on('responsive', () => {
            note('window-responsive', { afterMs: unresponsiveSince ? Date.now() - unresponsiveSince : null })
        })
        this.window.webContents.on('render-process-gone', (_event, details) => {
            recordFailure('window-render-process-gone', `${details.reason} (exit ${details.exitCode})`)
        })

        this.window.on('blur', () => {
            if (
                (this.configStore.appearance?.dock ?? 'off') !== 'off' &&
                this.configStore.appearance?.dockHideOnBlur &&
                !BrowserWindow.getFocusedWindow()
            ) {
                this.hide()
            }
        })

        enableRemote(this.window.webContents)

        this.window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'))

        this.window.webContents.setVisualZoomLevelLimits(1, 1)
        this.window.webContents.setZoomFactor(1)
        this.window.webContents.session.setPermissionCheckHandler(() => true)
        this.window.webContents.session.setDevicePermissionHandler(() => true)
        this.window.webContents.session.setSpellCheckerEnabled(false)

        if (process.platform === 'darwin') {
            this.touchBarControl = new TouchBar.TouchBarSegmentedControl({
                segments: [],
                change: index => this.send('touchbar-selection', index),
            })
            this.window.setTouchBar(new TouchBar({
                items: [this.touchBarControl],
            }))
        } else {
            this.window.setMenu(null)
        }

        this.setupWindowManagement()
        this.setupUpdater()

        this.ready = new Promise(resolve => {
            const listener = event => {
                if (event.sender === this.window.webContents) {
                    ipcMain.removeListener('app:ready', listener as any)
                    resolve()
                }
            }
            ipcMain.on('app:ready', listener)
        })
    }

    makeMain (): void {
        this.isMainWindow = true
        this.window.webContents.send('host:became-main-window')
    }

    setVibrancy (enabled: boolean, type?: string, userRequested?: boolean): void {
        if (userRequested ?? true) {
            this.lastVibrancy = { enabled, type }
        }
        if (process.platform === 'win32') {
            if (parseFloat(os.release()) >= 10) {
                this.window.blurType = enabled ? type === 'fluent' ? 'acrylic' : 'blurbehind' : null
                try {
                    this.window.setBlur(enabled)
                    this.isFluentVibrancy = enabled && type === 'fluent'
                } catch (error) {
                    console.error('Failed to set window blur', error)
                }
            } else {
                DwmEnableBlurBehindWindow(this.window.getNativeWindowHandle(), enabled)
            }
        } else if (process.platform === 'linux') {
            this.window.setBackgroundColor(enabled ? '#00000000' : this.opaqueBackgroundColor())
            this.window.setBlur(enabled)
        } else {
            this.window.setVibrancy(enabled ? macOSVibrancyType : null)
        }
    }

    /**
     * An opaque window background matching the OS scheme, so text keeps
     * subpixel antialiasing. Only the few pixels not covered by the page ever
     * show, so an approximate colour is fine — what matters is the alpha.
     */
    private opaqueBackgroundColor (): string {
        return nativeTheme.shouldUseDarkColors ? '#131d27' : '#ffffff'
    }

    setDarkMode (mode: string): void {
        // Not macOS-only: nativeTheme drives the native chrome on Windows and
        // Linux too, and opaqueBackgroundColor() reads shouldUseDarkColors.
        if ('light' === mode) {
            nativeTheme.themeSource = 'light'
        } else if ('auto' === mode) {
            nativeTheme.themeSource = 'system'
        } else {
            nativeTheme.themeSource = 'dark'
        }
        // Deliberately not touching the window background here. Every
        // config.changed$ reaches this method, and calling setBackgroundColor on
        // a glasstron window from that path crashed the app natively (selecting
        // Window frame > Full). The backing colour is chosen once at
        // construction instead, which is where transparency actually matters.
    }

    focus (): void {
        this.window.focus()
    }

    send (event: string, ...args: any[]): void {
        if (!this.window) {
            return
        }
        this.window.webContents.send(event, ...args)
        if (event === 'host:config-change') {
            this.configStore = args[0]
            this.enableDockedWindowStyles(this.isDockedOnTop())
        }
    }

    isDestroyed (): boolean {
        return !this.window || this.window.isDestroyed()
    }

    isFocused (): boolean {
        return this.window.isFocused()
    }

    isVisible (): boolean {
        return this.window.isVisible()
    }

    isDockedOnTop (): boolean {
        return this.isMainWindow && this.configStore.appearance?.dock && this.configStore.appearance?.dock !== 'off' && (this.configStore.appearance?.dockAlwaysOnTop ?? true)
    }

    async hide (): Promise<void> {
        if (process.platform === 'darwin') {
            // Lose focus
            Menu.sendActionToFirstResponder('hide:')
            // Don't disable docked window styles when hiding - keep dock hidden if feature is enabled
            if (this.isDockedOnTop()) {
                // Temporarily disable always-on-top and other properties while hidden
                if (this.window.isAlwaysOnTop()) {
                    this.window.setAlwaysOnTop(false)
                }
            }
        }
        this.window.blur()
        this.window.hide()
    }

    async show (): Promise<void> {
        await this.enableDockedWindowStyles(this.isDockedOnTop())
        this.window.show()
        this.window.focus()
    }

    async present (): Promise<void> {
        await this.show()
        this.window.moveTop()
    }

    passCliArguments (argv: string[], cwd: string, secondInstance: boolean): void {
        const urlArg = argv.find(arg => isTabbyURL(arg))
        if (urlArg) {
            this.send('cli', parseTabbyURL(urlArg, cwd), cwd, secondInstance)
        } else {
            this.send('cli', parseArgs(argv, cwd), cwd, secondInstance)
        }
    }

    private async enableDockedWindowStyles (enabled: boolean) {
        if (process.platform === 'darwin') {
            if (enabled) {
                if (!this.dockHidden) {
                    app.dock.hide()
                    this.dockHidden = true
                }
                this.window.setAlwaysOnTop(true, 'screen-saver', 1)
                if (!this.window.isVisibleOnAllWorkspaces()) {
                    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
                }
                if (this.window.fullScreenable) {
                    this.window.setFullScreenable(false)
                }
            } else {
                if (this.dockHidden) {
                    await app.dock.show()
                    this.dockHidden = false
                }
                if (this.window.isAlwaysOnTop()) {
                    this.window.setAlwaysOnTop(false)
                }
                if (this.window.isVisibleOnAllWorkspaces()) {
                    this.window.setVisibleOnAllWorkspaces(false)
                }
                if (!this.window.fullScreenable) {
                    this.window.setFullScreenable(true)
                }
            }
        }
    }

    /**
     * Remember where this window is, under its own slot.
     *
     * `windowBounds` and not `getBounds()`: it is only updated while the window
     * is not maximized, which is what makes a maximized window remember the
     * size it would restore to rather than the size of the screen.
     */
    private persistGeometry (): void {
        if (!this.window || this.window.isDestroyed() || !this.windowBounds) {
            return
        }
        const geometry = describe(this.windowBounds, this.window.isMaximized())
        const digest = JSON.stringify(geometry)
        if (digest === this.savedGeometry) {
            return
        }
        this.savedGeometry = digest
        saveGeometry(this.geometrySlot, geometry)
    }

    private setupWindowManagement () {
        this.window.on('show', () => {
            this.visible.next(true)
            this.send('host:window-shown')
        })

        this.window.on('hide', () => {
            this.visible.next(false)
        })

        const moveSubscription = new Observable<void>(observer => {
            this.window.on('move', () => observer.next())
        }).pipe(debounceTime(250)).subscribe(() => {
            this.send('host:window-moved')
        })

        // A close is not the only way a window goes away — the watchdog's
        // `app.exit()`, a session ending and a crash all skip it — so the
        // geometry is written once the user stops dragging as well as on close.
        // Debounced because `conf` reads and rewrites the file synchronously
        // and a drag is hundreds of events, and skipped when nothing moved.
        const geometrySubscription = new Observable<void>(observer => {
            this.window.on('move', () => observer.next())
            this.window.on('resize', () => observer.next())
        }).pipe(debounceTime(2000)).subscribe(() => {
            this.persistGeometry()
        })

        this.window.on('closed', () => {
            moveSubscription.unsubscribe()
            geometrySubscription.unsubscribe()
        })

        this.window.on('enter-full-screen', () => this.send('host:window-enter-full-screen'))
        this.window.on('leave-full-screen', () => this.send('host:window-leave-full-screen'))

        this.window.on('maximize', () => this.send('host:window-maximized'))
        this.window.on('unmaximize', () => this.send('host:window-unmaximized'))

        this.window.on('close', event => {
            if (!this.closing) {
                event.preventDefault()
                this.send('host:window-close-request')
                return
            }
            this.persistGeometry()
        })

        this.window.on('closed', () => {
            // Only now: a slot taken by a window that is still on screen would
            // hand the next window this one's remembered place.
            releaseSlot(this.geometrySlot)
            this.destroy()
        })

        this.window.on('resize', () => {
            if (!this.window.isMaximized()) {
                this.windowBounds = this.window.getBounds()
            }
        })

        this.window.on('move', () => {
            if (!this.window.isMaximized()) {
                this.windowBounds = this.window.getBounds()
            }
        })

        this.window.on('focus', () => {
            this.send('host:window-focused')
        })

        this.on('ready', () => {
            this.window?.webContents.send('start', {
                config: this.configStore,
                executable: app.getPath('exe'),
                windowID: this.window.id,
                isMainWindow: this.isMainWindow,
                userPluginsPath: this.application.userPluginsPath,
                initialTab: this.options.initialTab,
            })
        })

        this.on('window-minimize', () => {
            this.window?.minimize()
        })

        this.on('window-set-bounds', (_, bounds) => {
            this.window?.setBounds(bounds)
        })

        this.on('window-set-always-on-top', (_, flag) => {
            this.window?.setAlwaysOnTop(flag)
        })

        this.on('window-set-vibrancy', (_, enabled, type) => {
            this.setVibrancy(enabled, type)
        })

        this.on('window-set-dark-mode', (_, mode) => {
            this.setDarkMode(mode)
        })

        this.on('window-set-window-controls-color', (_, theme) => {
            if (process.platform === 'win32') {
                const symbolColor: string = theme.foreground
                this.window?.setTitleBarOverlay(
                    {
                        symbolColor: symbolColor,
                        height: 32,
                    },
                )
            }
        })

        this.on('window-set-title', (_, title) => {
            this.window?.setTitle(title)
        })

        this.on('window-bring-to-front', () => {
            if (this.window?.isMinimized()) {
                this.window.restore()
            }
            this.present()
        })

        this.on('window-close', () => {
            this.closing = true
            this.window.close()
        })

        this.on('window-set-touch-bar', (_, segments, selectedIndex) => {
            this.touchBarControl.segments = segments.map(s => ({
                label: s.label,
                icon: s.hasActivity ? activityIcon : undefined,
            }))
            this.touchBarControl.selectedIndex = selectedIndex
        })

        this.window.webContents.setWindowOpenHandler(() => {
            return { action: 'deny' }
        })

        ipcMain.on('window-set-disable-vibrancy-while-dragging', (_event, value) => {
            this.disableVibrancyWhileDragging = value && this.configStore.hacks?.disableVibrancyWhileDragging
        })

        let moveEndedTimeout: any = null
        const onBoundsChange = () => {
            if (!this.lastVibrancy?.enabled || !this.disableVibrancyWhileDragging || !this.isFluentVibrancy) {
                return
            }
            this.setVibrancy(false, undefined, false)
            if (moveEndedTimeout) {
                clearTimeout(moveEndedTimeout)
            }
            moveEndedTimeout = setTimeout(() => {
                this.setVibrancy(this.lastVibrancy.enabled, this.lastVibrancy.type)
            }, 50)
        }
        this.window.on('move', onBoundsChange)
        this.window.on('resize', onBoundsChange)

        ipcMain.on('window-set-traffic-light-position', (_event, x, y) => {
            this.window.setWindowButtonPosition({ x, y })
        })

        ipcMain.on('window-set-opacity', (_event, opacity) => {
            this.window.setOpacity(opacity)
        })

        this.on('window-set-progress-bar', (_, value) => {
            this.window?.setProgressBar(value, { mode: value < 0 ? 'none' : 'normal' })
        })
    }

    on (event: string, listener: (...args: any[]) => void): void {
        ipcMain.on(event, (e, ...args) => {
            if (!this.window || e.sender !== this.window.webContents) {
                return
            }
            listener(e, ...args)
        })
    }

    private setupUpdater () {
        autoUpdater.autoDownload = true
        autoUpdater.autoInstallOnAppQuit = true

        autoUpdater.on('update-available', () => {
            this.send('updater:update-available')
        })

        autoUpdater.on('update-not-available', () => {
            this.send('updater:update-not-available')
        })

        autoUpdater.on('error', err => {
            this.send('updater:error', err)
        })

        autoUpdater.on('update-downloaded', () => {
            this.send('updater:update-downloaded')
        })

        this.on('updater:check-for-updates', () => {
            autoUpdater.checkForUpdates()
        })

        this.on('updater:quit-and-install', () => {
            autoUpdater.quitAndInstall()
        })
    }

    private destroy () {
        this.window = null
        this.closed.next()
        this.visible.complete()
        this.closed.complete()
    }
}
