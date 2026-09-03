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

    private defaultDistroHost (): string {
        // `\\wsl.localhost\` needs a name; there is no "default" share. Reading
        // it costs a subprocess, so it is left to the caller to configure a
        // named distro — an unnamed one simply gets no path resolution.
        return ''
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
