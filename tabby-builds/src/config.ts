import { ConfigProvider } from 'tabby-core'

export class BuildsConfigProvider extends ConfigProvider {
    defaults = {
        builds: {
            /** 'cards' | 'table' — remembered so the page opens how you left it. */
            view: 'cards',

            /**
             * Directories searched for source checkouts and installer files.
             * `~` is expanded. Kept explicit rather than magic so the page can
             * show you exactly why something was or was not found.
             */
            searchRoots: ['~/projects', '~/Downloads', '~/Tabby'],
            /** How deep under each root to look. Keeps a big Downloads tree cheap. */
            searchDepth: 3,
            /** Installer files (setup .exe, .dmg, .AppImage…) are builds too. */
            includeInstallers: true,

            /**
             * Process attribution is the only genuinely live part, so it polls
             * fast; the filesystem scan is comparatively expensive and rare.
             */
            processPollMs: 3000,
            rescanMs: 60000,
            /** Pause polling when the window is not focused. */
            pauseWhenUnfocused: true,

            /** Walk each build for its size as soon as it is discovered. */
            autoSize: true,

            /**
             * The build "you use" — the one the taskbar pin launches, marked
             * active in the list, and never deletable. Stored as the
             * executable path so it survives a rescan. Empty means "work it
             * out from what the taskbar pin currently points at".
             */
            activeExecutable: '',
            /** Retarget the Windows taskbar pin when the active build changes. */
            pinToTaskbar: true,

            /**
             * Extra environment for launching a source build. The dev build
             * must not share a config directory with the installed app —
             * Electron's single-instance lock is keyed on it, and the installed
             * app's plugins get loaded against this repo's tabby-core.
             * Empty means "a scratch directory next to the checkout".
             */
            devProfileDirectory: '',
        },
    }
}
