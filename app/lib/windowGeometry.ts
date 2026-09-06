import { screen, BrowserWindow, Rectangle } from 'electron'
import ElectronConfig = require('electron-config')

import { recordFailure, report } from './diagnostics'

/**
 * Where each window was, remembered per window rather than per application.
 *
 * Upstream saves one `windowBoundaries` key and every window reads and writes
 * it, which is fine while there is one window and wrong the moment there are
 * two: the second opens exactly on top of the first, and whichever closes last
 * overwrites the other's position.
 *
 * ## Identity
 *
 * A saved rectangle is only worth anything if the next launch can say which
 * window it belonged to, so the whole feature rests on what identifies a window
 * across a restart. Tabby has exactly one such identity today, and it is an
 * ordinal: `isMainWindow`, set on the first window in `Application.windows`,
 * which is the sole condition under which the saved tab list is replayed
 * (`app.service.ts`, `bootstrapData.isMainWindow`). Nothing else about a window
 * survives a restart — the tab list is a single `localStorage` blob shared by
 * every window in the partition and only the main window reads it, so there is
 * no per-window content to derive an identity from.
 *
 * So a slot here is that same ordinal widened from one bit to N: window #1 is
 * the main window, #2 is the next one you opened, and so on. Slots are claimed
 * lowest-free at construction and released on close, which means *open* order
 * decides them and close order cannot disturb them. Open order at launch is not
 * a guess: `app.on('ready')` creates exactly one window, so slot 1 is always
 * the main window, and the second window you open is always slot 2.
 *
 * What that does not survive: closing window 1 and opening another *within* a
 * session hands the new window slot 1, so it lands where window 1 was rather
 * than where the one you just closed was. That is deterministic, it is what
 * "the first window goes here" means, and it is the price of an identity that
 * is real rather than invented.
 *
 * ## Not stored
 *
 * No DPI. The reference implementation for this (Windows Terminal, GH#12633)
 * stores physical pixels and rescales them, but Electron's screen coordinates
 * are already DIPs computed per display, so a rectangle of the same DIP size
 * is the same logical size on a 100% and a 200% display. Rescaling would
 * introduce the drift it is meant to prevent.
 */

export interface WindowGeometry {
    x: number
    y: number
    width: number
    height: number
    maximized: boolean
    /** The display it was saved on. Recorded for the log; the maths never uses it. */
    display?: number
}

export interface Placement {
    /** Merged into the BrowserWindow options. Position is absent on a first run. */
    bounds: { width: number, height: number, x?: number, y?: number }
    maximized: boolean
    /** How this was arrived at — written to the log so a surprising position has an answer. */
    source: 'restored' | 'restored-adjusted' | 'cascade' | 'default'
}

/** Windows' own cascade step, in DIPs. */
const STEP = 28
/** How much of a window has to be on a display for it to count as reachable. */
const MIN_VISIBLE_WIDTH = 120
const MIN_VISIBLE_TITLEBAR = 32
/** Slots are bounded by the number of *concurrent* windows; this is only hygiene. */
const MAX_REMEMBERED = 32

const GEOMETRIES = 'windowGeometries'
const LEGACY_BOUNDS = 'windowBoundaries'
const LEGACY_MAXIMIZED = 'maximized'

const claimed = new Set<number>()

// eslint-disable-next-line @typescript-eslint/init-declarations
let config: ElectronConfig | null = null

function store (): ElectronConfig {
    // Lazily, and once: `conf` re-reads the file on every access, so a single
    // instance shared by every window in the process is always current, and two
    // windows writing different slots cannot clobber each other.
    config ??= new ElectronConfig({ name: 'window' })
    return config
}

/**
 * Take the lowest slot no live window holds.
 *
 * Lowest-free rather than next-highest so that closing a window frees its place
 * for the next one, which is what makes a session that opens and closes windows
 * settle back onto the same arrangement instead of drifting down the desktop.
 */
export function claimSlot (): number {
    let slot = 1
    while (claimed.has(slot)) {
        slot++
    }
    claimed.add(slot)
    return slot
}

export function releaseSlot (slot: number): void {
    claimed.delete(slot)
}

export function loadGeometry (slot: number): WindowGeometry | null {
    const saved = store().get(`${GEOMETRIES}.${slot}`)
    if (saved) {
        return saved
    }
    // Upstream's single shared slot is this fork's slot 1, so an install that
    // predates slots keeps the position it had rather than starting over.
    if (slot === 1) {
        const legacy = store().get(LEGACY_BOUNDS)
        if (legacy) {
            return { ...legacy, maximized: !!store().get(LEGACY_MAXIMIZED) }
        }
    }
    return null
}

export function saveGeometry (slot: number, geometry: WindowGeometry): void {
    if (slot > MAX_REMEMBERED) {
        return
    }
    try {
        store().set(`${GEOMETRIES}.${slot}`, geometry)
        if (slot === 1) {
            // Mirrored so that downgrading to a build without slots — upstream,
            // or an older one of ours — still finds the main window's place.
            store().set(LEGACY_BOUNDS, {
                x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height,
            })
            store().set(LEGACY_MAXIMIZED, geometry.maximized)
        }
    } catch (err) {
        // `conf` writes through write-file-atomic, whose rename over a
        // read-only file is EPERM on Windows — which is exactly the state a
        // mis-frozen build slot leaves its `data` directory in. Losing a window
        // position is not worth throwing out of a `close` handler over, but it
        // must not be lost in silence either.
        recordFailure('window-geometry-save-failed', err)
    }
}

function usable (g: WindowGeometry | null): g is WindowGeometry {
    return !!g
        && [g.x, g.y, g.width, g.height].every(n => typeof n === 'number' && Number.isFinite(n))
        && g.width >= 1 && g.height >= 1
}

/**
 * Can the user get hold of this window with a mouse?
 *
 * The title bar is the drag handle, so a window whose top edge is above the top
 * of every work area cannot be moved back however much of its body is visible.
 * Requiring a strip of the top edge to sit inside one display's work area is
 * the whole test — anything looser lets a stale rectangle strand a window, and
 * anything stricter snaps back a window the user deliberately hung off an edge.
 */
function isReachable (b: Rectangle): boolean {
    return screen.getAllDisplays().some(display => {
        const area = display.workArea
        const overlap = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x)
        const topOnScreen = b.y >= area.y && b.y <= area.y + area.height - MIN_VISIBLE_TITLEBAR
        return overlap >= MIN_VISIBLE_WIDTH && topOnScreen
    })
}

const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)))

/**
 * Bring a saved rectangle back onto the displays that exist now.
 *
 * `getDisplayMatching` answers with the display the rectangle overlaps most, or
 * the nearest one when it overlaps none — so a monitor that has been unplugged
 * resolves to a surviving one rather than to nothing.
 */
function fitToDisplays (b: Rectangle): { bounds: Rectangle, reason: string | null } {
    const area = screen.getDisplayMatching(b).workArea
    let { x, y, width, height } = b
    let reason: string | null = null

    if (width > area.width || height > area.height) {
        width = Math.min(width, area.width)
        height = Math.min(height, area.height)
        reason = 'larger than the work area'
    }
    if (!isReachable({ x, y, width, height })) {
        x = clamp(x, area.x, area.x + area.width - width)
        y = clamp(y, area.y, area.y + area.height - height)
        reason = reason ? `${reason}, and out of reach` : 'out of reach'
    }
    return { bounds: { x, y, width, height }, reason }
}

/**
 * Where to put a window nothing is remembered about.
 *
 * The first window of a session is left to Electron, which is what upstream
 * did and what every existing install already looks like. A later one steps
 * down and right off the newest live window, wrapping back to the top of the
 * work area when it runs out of room — otherwise it opens exactly on top of a
 * window that is already there, which is the same complaint as the shared slot.
 */
function cascade (size: { width: number, height: number }): Placement {
    const existing = BrowserWindow.getAllWindows()
        .filter(w => !w.isDestroyed())
        .map(w => w.getBounds())
    if (!existing.length) {
        return { bounds: size, maximized: false, source: 'default' }
    }

    const last = existing[existing.length - 1]
    const area = screen.getDisplayMatching(last).workArea
    const width = Math.min(size.width, area.width)
    const height = Math.min(size.height, area.height)
    let x = last.x + STEP
    let y = last.y + STEP
    for (let attempt = 0; attempt < 16; attempt++) {
        if (x + width > area.x + area.width || y + height > area.y + area.height) {
            x = area.x + STEP
            y = area.y + STEP
        }
        const [candidateX, candidateY] = [x, y]
        if (!existing.some(b => Math.abs(b.x - candidateX) < 2 && Math.abs(b.y - candidateY) < 2)) {
            break
        }
        x += STEP
        y += STEP
    }
    return { bounds: { x, y, width, height }, maximized: false, source: 'cascade' }
}

function restore (slot: number, saved: WindowGeometry): Placement {
    const fitted = fitToDisplays(saved)
    if (fitted.reason) {
        report('window-geometry-adjusted', {
            slot,
            summary: `saved geometry for window ${slot} was ${fitted.reason}`,
            saved: { x: saved.x, y: saved.y, width: saved.width, height: saved.height },
            bounds: fitted.bounds,
        })
    }
    return {
        bounds: fitted.bounds,
        maximized: !!saved.maximized,
        source: fitted.reason ? 'restored-adjusted' : 'restored',
    }
}

/**
 * Decide where the window for `slot` goes, and say so in the log.
 *
 * `defaultSize` is upstream's first-run size and is used only when nothing is
 * remembered for this slot.
 */
export function placeWindow (slot: number, defaultSize: { width: number, height: number }): Placement {
    const saved = loadGeometry(slot)
    const placement = usable(saved) ? restore(slot, saved) : cascade(defaultSize)
    report('window-geometry', { slot, source: placement.source, ...placement.bounds, maximized: placement.maximized })
    return placement
}

/** The geometry to remember for a window currently at `bounds`. */
export function describe (bounds: Rectangle, maximized: boolean): WindowGeometry {
    return {
        ...bounds,
        maximized,
        display: screen.getDisplayMatching(bounds).id,
    }
}
