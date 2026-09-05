import * as fs from 'fs/promises'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { HostAppService, Platform } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'

/** What a hovered match resolves to, once paths and WSL have been sorted out. */
export interface ResolvedTarget {
    /** The URI to open / copy, or '' when there is nothing to open yet. */
    link: string
    /** An absolute filesystem path, or '' when this is not a file. */
    filePath: string
    /** A second line for the card, shown only when it says something new. */
    display: string
}

function parseUrl (text: string): URL | null {
    try {
        return new URL(text)
    } catch {
        return null
    }
}

/**
 * The ASCII form of a URI's host, when it is not what the link appears to say.
 *
 * `аpple.com` with a Cyrillic а is a different domain from `apple.com` and
 * looks identical in a terminal font. `new URL()` normalises the host to
 * punycode, so a `xn--` prefix that the written form does not have is exactly
 * the case worth naming — that is the whole homograph attack. Returns '' when
 * there is nothing surprising, which is almost always.
 *
 * The Windows Terminal fork does this by comparing `AbsoluteCanonicalUri`
 * against `AbsoluteUri` (`TermControl.cpp:3839-3867`).
 */
export function punycodeHost (text: string): string {
    const url = parseUrl(text)
    if (!url?.hostname.includes('xn--')) {
        return ''
    }
    // The authority as actually written, so an author who typed the punycode
    // themselves is not warned about their own spelling.
    const written = /^[^:]+:\/\/(?:[^@/]*@)?([^/?#]+)/.exec(text)?.[1] ?? ''
    const bare = written.replace(/:\d+$/, '').toLowerCase()
    if (!bare || bare === url.hostname) {
        return ''
    }
    return url.hostname
}

/**
 * A URI with its fragment removed.
 *
 * Everything from the first `#` is the fragment (RFC 3986 §3.5) and no
 * filesystem can act on one: `file:///home/me/routes.yaml#L6-L7`, which is what
 * Claude Code emits for `routes.yaml:6-7`, names a file that does not exist. A
 * `#` that genuinely belongs to a name has to arrive as `%23`, so a literal one
 * is always the delimiter — which is why this runs *before* percent-decoding
 * and never after.
 */
export function stripFragment (uri: string): string {
    const hash = uri.indexOf('#')
    return hash === -1 ? uri : uri.substring(0, hash)
}

/** Percent-decoding that cannot take the link down with it. */
function percentDecode (text: string): string {
    try {
        return decodeURIComponent(text)
    } catch {
        // A stray `%` is not a reason to lose the whole hover.
        return text
    }
}

function backslashes (posix: string): string {
    return posix.replace(/\//g, '\\')
}

/**
 * Whether a string is worth asking the filesystem about at all.
 *
 * A relative path deliberately is not: text rules match things like an issue
 * key, and `fs.access('CAB-8209')` is answered against the *app's* working
 * directory, where it could plausibly exist and would then be offered as this
 * link's file.
 */
function isRooted (p: string): boolean {
    return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(p)
}

/**
 * The filesystem path a matched link points at, before anyone asks whether it
 * exists. `''` when the match is not a path at all.
 *
 * `distro` is the answer from `LinkTargetService.distroHost` — a name, `''` for
 * a WSL tab whose distro could not be named, or null for a tab that is not WSL.
 * Nothing here touches the filesystem or the registry, so the whole translation
 * is testable on its own; this is a port of the Windows Terminal fork's
 * `Utils::ResolveFileUriTarget`, minus the parts that only exist because
 * `PathCreateFromUrlW` mis-decodes UTF-8 escapes a byte at a time.
 */
export function filesystemPath (input: string, distro: string | null, onWindows: boolean): string {
    let candidate = input

    if (/^file:\/\//i.test(candidate)) {
        const body = stripFragment(candidate).substring('file://'.length)
        const slash = body.indexOf('/')
        const authority = percentDecode(slash === -1 ? body : body.substring(0, slash))
        candidate = percentDecode(slash === -1 ? '/' : body.substring(slash))

        // `file://server/share/x` is a UNC path — and that is the form editors
        // already emit for WSL, `file://wsl.localhost/Ubuntu/…`, which names its
        // own distro and so needs no guessing. `localhost` is the empty
        // authority spelled out (RFC 8089).
        if (authority && authority.toLowerCase() !== 'localhost') {
            return onWindows ? `\\\\${authority}${backslashes(candidate)}` : candidate
        }
        // `file:///c:/x` — drop the empty authority's slash on Windows.
        if (/^\/[a-zA-Z]:/.test(candidate)) {
            candidate = candidate.substring(1)
            return onWindows ? backslashes(candidate) : candidate
        }
    }

    if (distro !== null && onWindows && candidate.startsWith('/')) {
        // A Windows drive mounted into the distro is reachable as itself. The
        // share would resolve it too, but that is the 9p server answering for a
        // file sitting on the local disk.
        const mount = /^\/mnt\/([a-zA-Z])(?=\/|$)/.exec(candidate)
        if (mount) {
            return `${mount[1].toUpperCase()}:${backslashes(candidate.substring(mount[0].length)) || '\\'}`
        }
        // A POSIX path printed by something running inside WSL is not a Windows
        // path, but Windows can reach it through the distro's UNC share. Without
        // this, Copy path and Show in folder are simply wrong for every WSL tab.
        if (distro) {
            return `\\\\wsl.localhost\\${distro}${backslashes(candidate)}`
        }
    }

    return isRooted(candidate) ? candidate : ''
}

@Injectable({ providedIn: 'root' })
export class LinkTargetService {
    constructor (private hostApp: HostAppService) { }

    /**
     * The distro a tab is running, or null when it is not a WSL tab.
     *
     * Mirrors `WSLDirectoryPickerService.getDistro` rather than importing it:
     * that service lives in `tabby-local`, which is not loaded on every
     * platform, and this is ten lines of string handling. WSL shells are stored
     * as `wsl.exe` with `['-d', <distro>]`; the default distro has no `-d`.
     */
    wslDistro (tab: BaseTerminalTabComponent<any> | null): string | null {
        const options: any = tab?.profile?.options
        const executable = String(options?.command ?? '')
            .trim()
            .replace(/^"+|"+$/g, '')
            .split(/[\\/]/)
            .pop()
            ?.toLowerCase()
        if (executable !== 'wsl.exe') {
            return null
        }
        const args: string[] = options?.args ?? []
        const flag = args.findIndex(a => a === '-d' || a === '--distribution')
        return flag !== -1 && args[flag + 1] ? args[flag + 1] : ''
    }

    /**
     * The distro whose share a POSIX path in this tab belongs to: its name, ''
     * when the tab is WSL but the distro could not be named, or null when the
     * tab is not WSL at all.
     */
    distroHost (tab: BaseTerminalTabComponent<any> | null): string | null {
        const distro = this.wslDistro(tab)
        if (distro === null) {
            return null
        }
        return distro === '' ? this.defaultDistroHost() : distro
    }

    /**
     * Turn a matched string into something the card's buttons can act on.
     *
     * `convert` comes from the matching `LinkHandler`, which is what untildifies
     * and resolves a relative path against the tab's working directory.
     *
     * The handler's own `verify` is deliberately not consulted. It is
     * `fs.access` on the string as written (`tabby-linkifier/src/handlers.ts`),
     * which for `/home/you/notes.md` asks Windows about `C:\home\you\notes.md`
     * — so every WSL path failed the test that gated the translation that would
     * have made it real. Existence is asked once, here, of the path we would
     * actually open.
     */
    async resolve (
        text: string,
        converted: string,
        tab: BaseTerminalTabComponent<any> | null,
    ): Promise<ResolvedTarget> {
        const candidate = filesystemPath(
            converted || text,
            this.distroHost(tab),
            this.hostApp.platform === Platform.Windows,
        )
        if (!candidate || !await this.exists(candidate)) {
            // Still a link — just not one we can offer a path for.
            return { link: text, filePath: '', display: '' }
        }
        return {
            link: text,
            filePath: candidate,
            // Only worth a line when it is not simply the text again.
            display: path.normalize(candidate) === path.normalize(text) ? '' : candidate,
        }
    }

    /**
     * The default WSL distro's name, which `\\wsl.localhost\` needs — there is
     * no "default" share to fall back on.
     *
     * Finding it costs a registry read, so it is done once and remembered. It
     * used to be skipped entirely, which meant the most ordinary WSL tab there
     * is — `wsl` with no `-d` — silently had no Copy path and no Show in
     * folder. The registry is read rather than `wsl.exe -l` because launching
     * WSL from a hover is exactly the kind of thing that stalls a UI thread,
     * and this is one synchronous key lookup.
     */
    private defaultDistro: string | null = null

    private defaultDistroHost (): string {
        const cached = this.defaultDistro
        if (cached !== null) {
            return cached
        }
        let name = ''
        try {
            const wnr = require('windows-native-registry')
            const base = 'Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'
            const guid = wnr.getRegistryKey(wnr.HK.CU, base)?.DefaultDistribution?.value
            if (guid) {
                name = wnr.getRegistryKey(wnr.HK.CU, `${base}\\${guid}`)?.DistributionName?.value ?? ''
            }
        } catch {
            // No registry module, no WSL, or a shape we don't recognise. A
            // missing path is the same outcome as before, not an error.
        }
        this.defaultDistro = name
        return name
    }

    private async exists (p: string): Promise<boolean> {
        try {
            await fs.access(p)
            return true
        } catch {
            return false
        }
    }
}
