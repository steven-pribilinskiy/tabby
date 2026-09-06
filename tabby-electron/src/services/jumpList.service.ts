import { Injectable } from '@angular/core'
import { LogService, Logger, PartialProfile, Profile, TranslateService } from 'tabby-core'
import { ElectronService } from './electron.service'
import { JumpListIconsService } from './jumpListIcons.service'

/** One entry in the taskbar's right-click menu. */
export interface JumpListTask {
    type: 'task'
    program: string
    args: string
    title: string
    iconPath: string
    iconIndex: number
}

/** A named group of them. */
export interface JumpListCategory {
    type: 'custom'
    name: string
    items: JumpListTask[]
}

/**
 * Quote a value so the CRT hands it back as one argument.
 *
 * `profile "My Box"` is parsed by the same rules every Windows process is
 * launched under: backslashes are literal except immediately before a quote,
 * where they must be doubled, and an embedded quote must be escaped. Upstream
 * interpolated the name straight into the string, so a profile called
 * `Steve"s box` produced an entry that opened the wrong profile or none at
 * all — and profile names are free text.
 */
export function quoteArgument (value: string): string {
    const escaped = value
        .replace(/(\\*)"/g, '$1$1\\"')
        .replace(/(\\+)$/, '$1$1')
    return `"${escaped}"`
}

/**
 * The Windows jump list: the profiles offered when you right-click Tabby in the
 * taskbar or the Start menu.
 *
 * Split out of `DockMenuService` because building the list is now most of the
 * work — every entry carries a rasterized copy of its profile's icon, which
 * means file I/O, a cache and a pruning pass — and because the construction has
 * to be exercised on its own. Writing a jump list is a process-wide, shell-side
 * side effect keyed on the app's AppUserModelID; a test may build the list and
 * inspect the files, and must be able to do that without publishing anything.
 */
@Injectable({ providedIn: 'root' })
export class JumpListService {
    private logger: Logger

    constructor (
        private electron: ElectronService,
        private icons: JumpListIconsService,
        private translate: TranslateService,
        log: LogService,
    ) {
        this.logger = log.create('jumplist')
    }

    /**
     * `app.setJumpList` exists only on Windows — it is not merely a no-op
     * elsewhere, it is absent, so calling it is a TypeError.
     */
    isSupported (): boolean {
        return process.platform === 'win32' && typeof this.electron.app.setJumpList === 'function'
    }

    /**
     * The categories, with every icon rasterized.
     *
     * Returns what would be published rather than publishing it, so the shape,
     * the arguments and the icon files can all be checked without touching the
     * shell.
     */
    async build (
        recentProfiles: PartialProfile<Profile>[],
        profiles: PartialProfile<Profile>[],
    ): Promise<JumpListCategory[]> {
        const started = performance.now()
        const pass = await this.icons.pass()
        // The app's own icon, and the fallback for everything that could not be
        // drawn. A Tabby logo beats an empty square, which is what the shell
        // draws for an icon it cannot resolve.
        const fallback = { iconPath: process.execPath, iconIndex: 0 }

        const iconFor = async (profile: PartialProfile<Profile>) => {
            const file = await pass?.ensure(profile.icon, profile.color)
            return file ? { iconPath: file, iconIndex: 0 } : fallback
        }

        const recent: JumpListTask[] = []
        for (const [index, profile] of recentProfiles.entries()) {
            recent.push({
                type: 'task',
                program: process.execPath,
                args: `recent ${index}`,
                title: profile.name,
                ...await iconFor(profile),
            })
        }

        // `profile <name>` resolves by name, so a second profile sharing one is
        // unreachable however it is listed — an entry that silently opens
        // somebody else's shell is worse than an entry that is not there.
        const seen = new Set<string>()
        const named: JumpListTask[] = []
        for (const profile of profiles) {
            if (!profile.name || seen.has(profile.name)) {
                continue
            }
            seen.add(profile.name)
            named.push({
                type: 'task',
                program: process.execPath,
                args: `profile ${quoteArgument(profile.name)}`,
                title: profile.name,
                ...await iconFor(profile),
            })
        }

        await pass?.pruneUnused()
        if (pass?.drawn) {
            // Rasterizing runs on the renderer thread, so it is worth being
            // able to say how much of one a rebuild cost. A warm pass draws
            // nothing and says nothing.
            this.logger.debug(`drew ${pass.drawn} icon(s) in ${Math.round(performance.now() - started)}ms`)
        }

        // An empty custom category is rejected by the shell, and it rejects the
        // *call*, not the category — so on a fresh profile, where nothing has
        // been opened yet and Recent is empty, upstream's list was refused
        // whole and no profiles appeared at all.
        return [
            { type: 'custom' as const, name: this.translate.instant('Recent'), items: recent },
            { type: 'custom' as const, name: this.translate.instant('Profiles'), items: named },
        ].filter(category => category.items.length > 0)
    }

    /** Build the list and publish it. A no-op, silently, anywhere but Windows. */
    async update (
        recentProfiles: PartialProfile<Profile>[],
        profiles: PartialProfile<Profile>[],
    ): Promise<void> {
        if (!this.isSupported()) {
            return
        }
        const categories = await this.build(recentProfiles, profiles)
        try {
            // Electron answers with a string rather than throwing, and upstream
            // discarded it — which is how a rejected list came to look exactly
            // like a list nobody had ever set.
            const result = this.electron.app.setJumpList(categories.length ? categories : null)
            if (result !== 'ok') {
                this.logger.warn(`the shell refused the jump list: ${result}`)
            }
        } catch (err) {
            this.logger.warn('could not set the jump list', err)
        }
    }
}
