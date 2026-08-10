import { ConfigProvider } from 'tabby-core'

export class ClaudeConfigProvider extends ConfigProvider {
    defaults = {
        claude: {
            /** Base URL of the stith session registry. */
            stithURL: 'https://stith.lvh.me',
            /** How often to re-read the session list while the window is focused. */
            pollIntervalMs: 2000,
            /** Usage windows move slowly; polled far less often than sessions. */
            usageIntervalMs: 60000,
            requestTimeoutMs: 3000,
            /**
             * Read session transcripts locally to derive context usage. Turn
             * off to avoid touching the filesystem at all; everything stith
             * reports keeps working.
             */
            readTranscripts: true,

            /**
             * What clicking a session row does:
             * 'focus'   — select its tab in this window (falls back to stith)
             * 'details' — expand the full record inline
             * 'newTab'  — open a terminal in the session's directory
             * 'resume'  — open a terminal there and run `claude --resume`
             * 'stith'   — open the session in stith in a browser
             */
            clickAction: 'focus',

            /**
             * Seconds to wait after a new terminal opens before typing into it.
             * A cold WSL distro or a slow shell profile is not accepting input
             * immediately, and anything sent early is swallowed by the prompt
             * redraw.
             */
            resumeInputDelaySec: 1.5,

            /** Which sections the docked panel renders. */
            panel: {
                /**
                 * Base font size for the panel, in px. Everything inside is
                 * sized in em against it, so this scales the whole panel
                 * rather than just the body text.
                 */
                fontSize: 12,
                showActiveSession: true,
                showContext: true,
                showStatus: true,
                showStats: true,
                showLastPrompt: true,
                showQueued: true,
                showBookmark: true,
                showWaiting: true,
                showSessionList: true,
                showUsage: true,
                /**
                 * How usage is drawn: 'bars' reads well in a narrow dock,
                 * 'pies' matches stith's Accounts view and packs both windows
                 * onto one line.
                 */
                usageView: 'bars',
            },

            /** Which rows the tab hover card renders. */
            hover: {
                enabled: true,
                showContext: true,
                showStatus: true,
                showStats: true,
                showLastPrompt: true,
            },
        },
    }
}
