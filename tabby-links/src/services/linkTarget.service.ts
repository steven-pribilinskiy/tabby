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
     * Turn a matched string into something the card's buttons can act on.
     *
     * `convert` comes from the matching `LinkHandler`, which is what untildifies
     * and resolves a relative path against the tab's working directory.
     */
    async resolve (
        text: string,
        converted: string,
        isFileLike: boolean,
        tab: BaseTerminalTabComponent<any> | null,
    ): Promise<ResolvedTarget> {
        if (!isFileLike) {
            return { link: text, filePath: '', display: '' }
        }

        let candidate = converted || text
        if (candidate.startsWith('file://')) {
            candidate = decodeURIComponent(candidate.substring('file://'.length))
            // `file:///c:/x` — drop the empty authority's slash on Windows.
            if (/^\/[a-zA-Z]:/.test(candidate)) {
                candidate = candidate.substring(1)
            }
        }

        // A POSIX path printed by something running inside WSL is not a Windows
        // path, but Windows can reach it through the distro's UNC share. Without
        // this, Copy path and Show in folder are simply wrong for every WSL tab.
        const distro = this.wslDistro(tab)
        if (distro !== null && candidate.startsWith('/') && this.hostApp.platform === Platform.Windows) {
            const host = distro === '' ? this.defaultDistroHost() : distro
            if (host) {
                candidate = `\\\\wsl.localhost\\${host}${candidate.replace(/\//g, '\\')}`
            }
        }

        const exists = await this.exists(candidate)
        if (!exists) {
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
