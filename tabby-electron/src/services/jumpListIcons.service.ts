import * as path from 'path'
import { Injectable } from '@angular/core'
import { LogService, Logger, PlatformService } from 'tabby-core'

/**
 * Turning a profile icon into a file the Windows shell can draw.
 *
 * A Tabby profile icon is either a Font Awesome class (`fas fa-desktop`, and
 * the default for most providers) or an inline SVG document, inlined at build
 * time by `svg-inline-loader`. The renderer draws both directly. A jump list
 * entry cannot: `iconPath` takes a file containing an icon plus an index, and
 * neither a CSS class nor a blob of markup is one — so every entry came out
 * wearing the Tabby executable's own icon, which is to say the jump list told
 * you nothing about which profile you were about to open.
 *
 * So rasterize them ourselves and hand the shell a real `.ico`. This is the
 * approach the Windows Terminal maintainers suggested for the same class of bug
 * in microsoft/terminal#10552, and what the reference fork does with
 * Direct2D/DirectWrite — here the renderer already *is* a text-and-SVG
 * rasterizer, so a canvas does the work with no native code and no new
 * dependency.
 *
 * Nothing here throws. A missing icon is worth degrading over — the entry falls
 * back to the app icon — and is never worth failing a jump list for.
 */

/** Sizes baked into each file: 100%, 125%, 150% and 200% of a 16px shell icon. */
const SIZES = [16, 24, 32, 48]

/** Leaves a little air around a glyph; drawn edge to edge it reads as clipped. */
const GLYPH_SCALE = 0.75

/** SVG viewBoxes are tighter than a font's side bearings, so inset a touch less. */
const SVG_SCALE = 0.8

/** A data: URL that will not decode must not hold a jump list rebuild up. */
const DECODE_MS = 2000

/**
 * Node's `fs`, without Electron's asar layer.
 *
 * A portable build keeps its config directory *inside* the build
 * (`<slot>\data\`), a sibling of `resources\app.asar` — and the first patched
 * `fs` call on an archive opens it and holds the handle for the life of the
 * process, which is what made a build undeletable in `tabby-builds`. Nothing
 * here has any business opening one, so it never uses the layer that can.
 */
function loadFs (): typeof import('fs') {
    try {
        return window['nodeRequire']('original-fs')
    } catch {
        // Not under Electron: there is no patched layer, and no archive to trip
        // over either.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('fs')
    }
}

const nodeFs = loadFs()
const fs = nodeFs.promises

/**
 * 64 bits of FNV-1a, as sixteen hex digits.
 *
 * The cache key, and deliberately not a crypto hash: this names a file whose
 * contents we just generated, so all that is asked of it is that two different
 * icons do not collide. `crypto` is not among the plugin bundle's externals and
 * has no business being pulled in for this.
 */
function hash (value: string): string {
    const pass = (basis: number, index: (i: number) => number): number => {
        let h = basis
        for (let i = 0; i < value.length; i++) {
            h ^= value.charCodeAt(index(i))
            h = Math.imul(h, 0x0100_0193) >>> 0
        }
        return h >>> 0
    }
    // Two passes, different basis, opposite directions: sixteen hex digits with
    // no bignum, and no shared state between the halves.
    const a = pass(0x811c_9dc5, i => i)
    const b = pass(0x0100_0193, i => value.length - 1 - i)
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

/**
 * The `.ico` container, written by hand.
 *
 * There is no encoder for it anywhere in this stack — a canvas produces PNG and
 * nothing else — but the container is a fixed header plus one directory entry
 * per image, and PNG-compressed entries have been legal since Vista. So the
 * bitmaps come from the canvas and only the bytes around them are ours.
 */
export function wrapPngsInIco (images: { size: number, png: Buffer }[]): Buffer {
    const count = images.length
    const directory = Buffer.alloc(6 + 16 * count)
    directory.writeUInt16LE(0, 0) // reserved
    directory.writeUInt16LE(1, 2) // type: icon
    directory.writeUInt16LE(count, 4)

    let offset = directory.length
    images.forEach((image, index) => {
        const at = 6 + 16 * index
        // 256 is written as 0. Nothing here is that big, but the encoding is
        // the encoding.
        directory.writeUInt8(image.size >= 256 ? 0 : image.size, at)
        directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1)
        directory.writeUInt8(0, at + 2) // palette size (0 = not paletted)
        directory.writeUInt8(0, at + 3) // reserved
        directory.writeUInt16LE(1, at + 4) // colour planes
        directory.writeUInt16LE(32, at + 6) // bits per pixel
        directory.writeUInt32LE(image.png.length, at + 8)
        directory.writeUInt32LE(offset, at + 12)
        offset += image.png.length
    })

    return Buffer.concat([directory, ...images.map(image => image.png)])
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/**
 * The character and font behind a Font Awesome class.
 *
 * Read out of the stylesheet rather than from a table of codepoints: the
 * `::before` rule is the only thing that knows what `fa-desktop` means, it
 * moves between Font Awesome releases, and the same lookup then covers every
 * class the app has loaded — solid, regular and brands — plus whatever a
 * profile has been given by hand.
 */
export function resolveGlyph (icon: string): { text: string, font: string } | null {
    const probe = document.createElement('i')
    probe.className = `fa-fw ${icon}`
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;font-size:100px'
    document.body.appendChild(probe)
    try {
        const style = window.getComputedStyle(probe, '::before')
        const content = style.content
        if (!content || content === 'none' || content === 'normal') {
            return null
        }
        // A computed string `content` comes back quoted.
        const text = content.replace(/^["']/, '').replace(/["']$/, '')
        const family = style.fontFamily
        // Anything else is a class that resolved to no icon font at all — a
        // typo, or a profile carrying a class from a Font Awesome we do not
        // ship — and drawing it would produce a box, not an icon.
        if (!text || !family.includes('Font Awesome')) {
            return null
        }
        return { text, font: `normal ${style.fontWeight} 100px ${family}` }
    } catch {
        return null
    } finally {
        probe.remove()
    }
}

/**
 * Wait for the webfont behind a glyph.
 *
 * Without this the first rebuild after a cold start draws tofu: the face is
 * declared `font-display: block`, so the CSS knows the family long before the
 * file itself has been fetched, and a canvas silently substitutes rather than
 * waiting. Asked once per icon — loading a face is not per-size.
 */
async function loadGlyphFont (glyph: { text: string, font: string }): Promise<void> {
    try {
        if (!document.fonts.check(glyph.font, glyph.text)) {
            await document.fonts.load(glyph.font, glyph.text)
        }
    } catch {
        // Font loading is a hint. If it failed, the blank check decides.
    }
}

function drawGlyph (ctx: CanvasRenderingContext2D, glyph: { text: string, font: string }, fill: string, size: number): void {
    ctx.font = glyph.font.replace('100px', `${Math.round(size * GLYPH_SCALE)}px`)
    ctx.fillStyle = fill
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(glyph.text, size / 2, size / 2)
}

/**
 * The `<svg>` behind an inline icon, or null if there is not one.
 *
 * Parsed as HTML, both because that is the parser Tabby itself renders these
 * with — `svg-inline-loader` emits HTML5-shaped markup, not strict XML — and
 * because the document it produces is inert: nothing loads, nothing runs, and
 * an `onerror` written into a config file by hand never fires. Serializing the
 * element back out still yields namespaced XML, since it is in the SVG
 * namespace whichever parser put it there.
 */
export function parseSvg (markup: string): SVGSVGElement | null {
    try {
        const doc = new DOMParser().parseFromString(markup, 'text/html')
        const svg = doc.body.querySelector('svg')
        return svg instanceof SVGSVGElement ? svg : null
    } catch {
        return null
    }
}

/**
 * An inline icon, sized and tinted for the shell.
 *
 * `fill: currentColor` on the root is what carries the tint: `fill` inherits,
 * so a path with no fill of its own picks it up, a path that says
 * `fill="currentColor"` — which is what Font Awesome's SVGs say — resolves it
 * against the `color` set alongside, and a path with a literal colour keeps it.
 */
function sizeSvg (root: SVGSVGElement, fill: string, size: number): string | null {
    if (!root.getAttribute('viewBox')) {
        // `svg-inline-loader` strips width and height from the root tag, so an
        // icon that carried its size there and no viewBox arrives with no
        // intrinsic size at all — and the browser would then draw it at a
        // default of its own choosing.
        const width = parseFloat(root.getAttribute('width') ?? '')
        const height = parseFloat(root.getAttribute('height') ?? '')
        if (!(width > 0) || !(height > 0)) {
            return null
        }
        root.setAttribute('viewBox', `0 0 ${width} ${height}`)
    }
    root.setAttribute('width', String(size))
    root.setAttribute('height', String(size))
    root.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    root.setAttribute('style', `${root.getAttribute('style') ?? ''};color:${fill};fill:currentColor`)
    return new XMLSerializer().serializeToString(root)
}

async function drawSvg (ctx: CanvasRenderingContext2D, root: SVGSVGElement, fill: string, size: number): Promise<boolean> {
    const box = Math.round(size * SVG_SCALE)
    const prepared = sizeSvg(root, fill, box)
    if (!prepared) {
        return false
    }
    const image = new Image()
    // A data: URL rather than a blob: this document is rendered by `<img>`,
    // where no script runs, and there is no object URL to remember to revoke.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(prepared)}`
    try {
        await Promise.race([
            image.decode(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('decode timed out')), DECODE_MS)),
        ])
    } catch {
        return false
    }
    const offset = Math.round((size - box) / 2)
    ctx.drawImage(image, offset, offset, box, box)
    return true
}

/** Did anything at all land on the canvas? */
function isBlank (ctx: CanvasRenderingContext2D, size: number): boolean {
    const { data } = ctx.getImageData(0, 0, size, size)
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 8) {
            return false
        }
    }
    return true
}

// ── The cache ───────────────────────────────────────────────────────────────

/**
 * One rebuild of the jump list.
 *
 * Held for the length of a pass rather than for ever, because pruning needs to
 * know what was handed out *this* time — the cache is keyed partly on colour,
 * so a user who switches theme would otherwise accumulate a file per theme per
 * icon, and nothing would ever remove the half no longer drawn.
 */
export class JumpListIconPass {
    /** How many icons this pass had to draw rather than find already cached. */
    drawn = 0

    private used = new Set<string>()

    constructor (
        public readonly directory: string,
        public readonly foreground: string,
        private logger: Logger,
    ) { }

    /**
     * The path to an `.ico` drawing `icon`, or null if it could not be drawn.
     *
     * Null is a normal answer, not an error: a profile with no icon, a class
     * Font Awesome does not define, and markup that will not parse all arrive
     * here and all mean the same thing to the caller — use the app icon.
     */
    async ensure (icon: string | null | undefined, color?: string | null): Promise<string | null> {
        const source = (icon ?? '').trim()
        if (!source) {
            return null
        }
        const chosen = color?.trim() ?? ''
        const fill = chosen === '' ? this.foreground : chosen
        const file = path.join(this.directory, `${hash(`${fill} ${source}`)}.ico`)
        this.used.add(path.basename(file))

        // Checked every pass, not just the first: the shell keeps its copy of
        // the list across restarts and across builds, so a cached path that has
        // since been swept — or that belonged to a slot that has been deleted —
        // must be redrawn rather than trusted.
        try {
            await fs.access(file)
            return file
        } catch {
            // Not cached yet.
        }

        try {
            // Resolved once, drawn four times. Reading a Font Awesome class out
            // of the stylesheet means a DOM insertion and a forced style recalc,
            // and parsing an SVG means a whole document — neither is per-size,
            // and this runs on the renderer thread for every profile there is.
            const svg = source.startsWith('<') ? parseSvg(source) : null
            const glyph = svg ? null : resolveGlyph(source)
            if (!svg && !glyph) {
                return null
            }
            if (glyph) {
                await loadGlyphFont(glyph)
            }

            const images: { size: number, png: Buffer }[] = []
            for (const size of SIZES) {
                const png = await this.draw(svg, glyph, fill, size)
                if (!png) {
                    return null
                }
                images.push({ size, png })
            }
            await this.write(file, wrapPngsInIco(images))
            this.drawn++
            return file
        } catch (err) {
            this.logger.debug(`could not rasterize the icon ${JSON.stringify(source.slice(0, 40))}`, err)
            return null
        }
    }

    /** Delete every cached file this pass did not hand out. */
    async pruneUnused (): Promise<void> {
        let names: string[] = []
        try {
            names = await fs.readdir(this.directory)
        } catch {
            return
        }
        for (const name of names) {
            if (this.used.has(name)) {
                continue
            }
            try {
                await fs.unlink(path.join(this.directory, name))
            } catch {
                // Another instance got there first, or the shell has it open.
            }
        }
    }

    private async draw (
        svg: SVGSVGElement | null,
        glyph: { text: string, font: string } | null,
        fill: string,
        size: number,
    ): Promise<Buffer | null> {
        const canvas = document.createElement('canvas')
        canvas.width = size
        canvas.height = size
        const ctx = canvas.getContext('2d')
        if (!ctx) {
            return null
        }

        if (svg) {
            if (!await drawSvg(ctx, svg, fill, size)) {
                return null
            }
        } else if (glyph) {
            drawGlyph(ctx, glyph, fill, size)
        } else {
            return null
        }

        // Whether anything actually landed on the canvas is the only honest
        // test of the whole path. A font that did not load, an SVG whose paths
        // all fall outside its viewBox and a class that resolved to nothing all
        // produce a plausible-looking file full of nothing — and a blank tile
        // in the shell is exactly what this set out to avoid.
        if (isBlank(ctx, size)) {
            return null
        }

        const url = canvas.toDataURL('image/png')
        return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    }

    /**
     * Write through a temp name and rename over.
     *
     * Rename is atomic on Windows and replaces, so a second window rebuilding
     * the same list at the same moment cannot leave a torn `.ico` behind for
     * the shell to read — which would be a blank tile surviving until the next
     * rebuild.
     */
    private async write (file: string, contents: Buffer): Promise<void> {
        const temp = `${file}.${process.pid}.tmp`
        await fs.writeFile(temp, contents)
        try {
            await fs.rename(temp, file)
        } catch (err) {
            await fs.unlink(temp).catch(() => null)
            throw err
        }
    }
}

/**
 * Where rasterized icons live, and the pass that fills it.
 *
 * Beside `config.yaml` rather than anywhere near the binary: a slot's app files
 * are marked read-only when it is cut, and `data\` is the only writable part of
 * one. It also means each profile directory keeps its own icons, so two builds
 * running side by side cannot hand each other a file drawn for the other one's
 * theme.
 */
@Injectable({ providedIn: 'root' })
export class JumpListIconsService {
    private logger: Logger

    constructor (
        private platform: PlatformService,
        log: LogService,
    ) {
        this.logger = log.create('jumplist-icons')
    }

    /** `<config dir>/jumplist-icons`, or null if there is no config file to sit beside. */
    directory (): string | null {
        const configPath = this.platform.getConfigPath()
        return configPath ? path.join(path.dirname(configPath), 'jumplist-icons') : null
    }

    /**
     * The colour a monochrome icon is drawn in.
     *
     * The jump list is taskbar chrome, so it follows the *system* theme —
     * `SystemUsesLightTheme`, not `AppsUseLightTheme`, and not Tabby's own
     * colour scheme, which the user may have forced the other way. A glyph
     * baked in the wrong one is invisible against the flyout it lands on, which
     * is indistinguishable from the blank tile this set out to fix.
     */
    foreground (): string {
        try {
            const wnr = window['nodeRequire']('windows-native-registry')
            const value = wnr.getRegistryValue(
                wnr.HK.CU,
                'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize',
                'SystemUsesLightTheme',
            )
            if (typeof value === 'number') {
                return value ? '#000000' : '#ffffff'
            }
        } catch {
            // Not Windows, or the value has never been written — the shipped
            // default is dark taskbar chrome either way.
        }
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? '#ffffff' : '#000000'
    }

    /** Open a pass, creating the cache directory. Null if it cannot be created. */
    async pass (): Promise<JumpListIconPass | null> {
        const directory = this.directory()
        if (!directory) {
            return null
        }
        try {
            await fs.mkdir(directory, { recursive: true })
        } catch (err) {
            this.logger.debug('could not create the icon cache directory', err)
            return null
        }
        return new JumpListIconPass(directory, this.foreground(), this.logger)
    }
}
