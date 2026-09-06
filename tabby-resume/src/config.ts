import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class ResumeConfigProvider extends ConfigProvider {
    defaults = {
        resume: {
            /**
             * Reopen a known agent's conversation, keeping the options it was
             * launched with. Only the agents whose resume syntax is in
             * `AGENT_TABLE` — anything else is a plain program.
             */
            agents: true,
            /** Reattach to shefrd, herdr, tmux, screen or zellij. */
            multiplexers: true,
            /** Extra program names, re-run exactly as they were found. */
            extraPrograms: [],
            /** Never resume these. Beats every setting above. */
            excludedPrograms: [],
            /** silent, toast, or confirm — which lists what it would do and waits. */
            notification: 'toast',
            /**
             * How long a restored pane's shell is given to draw a prompt before
             * the command is typed. Input arriving earlier is not lost — the
             * PTY queues it — but a shell still running its rc files echoes it
             * in pieces, and a TUI launched into a half-initialised terminal
             * redraws badly.
             */
            inputDelayMs: 1200,
            /**
             * How often each pane is asked what it is running. The answer is
             * cached and read synchronously when the layout is saved, so this
             * is what decides how stale a recorded command can be — never how
             * long a save or a quit takes.
             */
            refreshIntervalSec: 30,
            /** How long a distro gets to answer before its panes go unmeasured. */
            wslProbeTimeoutMs: 5000,
        },
    }
}
