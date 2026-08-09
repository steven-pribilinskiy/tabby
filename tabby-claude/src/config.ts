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

            /** Which sections the docked panel renders. */
            panel: {
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
