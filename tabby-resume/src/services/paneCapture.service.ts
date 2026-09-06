import { Injectable } from '@angular/core'
import { spawn } from 'child_process'
import { HostAppService, LogService, Logger, Platform } from 'tabby-core'

import { CapturedPane, MULTIPLEXER_MARKERS, QuotingStyle, splitWindowsCommandLine } from '../recognize'
import { WslRecord, firstWorkerBelow, firstWorkerBelowList, foregroundOf, parseProbe } from '../select'

/* eslint-disable block-scoped-var */

try {
    // The same module tabby-electron reads process trees with. Missing on
    // anything but Windows, and its absence is the ordinary case there.
    var windowsProcessTree = require('@tabby-gang/windows-process-tree') // eslint-disable-line @typescript-eslint/no-var-requires, no-var
} catch { }

/** What we know about a pane before asking what it is running. */
export interface PaneProbe {
    paneId: string
    /** The pane's shell process. Zero for a pane whose PTY could not say. */
    shellPid: number
    /** Whether this pane's work runs inside a distro rather than on Windows. */
    isWSL: boolean
    /**
     * The distro to probe. Empty means the pane named none, so the probe runs
     * against whichever distro is default — the same one the pane's own
     * `wsl.exe` with no `-d` opened.
     */
    distro: string
    /** `TABBY_SESSION`, which is how a WSL pane is identified at all. */
    sessionUID: string
    /** How the pane's own shell wants an argument quoted. */
    quoting: QuotingStyle
}

export interface CaptureResult {
    panes: CapturedPane[]
    /**
     * Panes the probe genuinely answered about — including "this one is
     * running nothing". A pane missing from here was not measured (a distro
     * that would not answer, a PTY with no pid), and its previously recorded
     * command must be kept rather than cleared.
     */
    answered: string[]
}

/**
 * Reports every process carrying a TABBY_SESSION: its pid, parent, process
 * group, the foreground group of its terminal, cwd and argv. The caller
 * matches TABBY_SESSION back to a pane and picks the foreground process.
 *
 * Two filters carry all the weight, and without them the answer is noise. A
 * daemon started from a pane INHERITS that pane's identity and keeps it
 * forever:
 *
 *   tpgid > 0            drops detached daemons, which have no controlling
 *                        terminal and so can never be what a pane is showing.
 *   no ownership marker  drops everything a multiplexer owns. TMUX/STY/ZELLIJ
 *                        (and shefrd's HERDR_ENV) are set on the processes
 *                        those daemons run for themselves; they are the
 *                        daemon's to restore, and recursing into them would
 *                        start a second copy of every agent inside.
 *
 * The single `grep -l` over every `environ` at once is not a micro-optimisation:
 * the obvious loop reads each of them and forks four helpers per process, which
 * on this machine's 1531-process distro measured 3.5s. Filtering first brings
 * the whole probe to ~250ms, of which ~30ms is the grep.
 *
 * Fed to `sh -s` on stdin rather than passed as `-c "…"`, which keeps every
 * quote in here literal instead of surviving another round of expansion on the
 * way through wsl.exe.
 */
export const WSL_PROBE_SCRIPT = `
for f in $(grep -als 'TABBY_SESSION=' /proc/[0-9]*/environ 2>/dev/null); do
  d=\${f%/environ}
  p=\${d##*/}
  e=$( { tr '\\0' '\\n' < "$f"; } 2>/dev/null ) || continue
  w=$(printf '%s\\n' "$e" | grep -am1 '^TABBY_SESSION=' | cut -d= -f2)
  [ -n "$w" ] || continue
  printf '%s\\n' "$e" | grep -aqE '^(${MULTIPLEXER_MARKERS.join('|')})=' && continue
  s=$( { sed 's/.*) //' "$d/stat"; } 2>/dev/null )
  [ -n "$s" ] || continue
  set -- $s
  [ "$6" -gt 0 ] 2>/dev/null || continue
  a=$( { tr '\\0\\n' '\\037 ' < "$d/cmdline"; } 2>/dev/null )
  c=$( { readlink "$d/cwd"; } 2>/dev/null )
  printf '%s\\036%s\\036%s\\036%s\\036%s\\036%s\\036%s\\n' "$w" "$p" "$2" "$3" "$6" "$c" "$a"
done
`

/**
 * Asking each pane what it is running right now.
 *
 * Two detection paths, because a pane's real work may not be a Windows process
 * at all:
 *
 *   native  walk the process tree down from the pane's own shell and read the
 *           SHALLOWEST non-shell descendant's command line.
 *   WSL     one probe per distro — never per pane — matching each pane by the
 *           `TABBY_SESSION` the session exports into it.
 *
 * Nothing here blocks the event loop. `windows-process-tree` answers from a
 * libuv worker, and the WSL probe is a spawned process read asynchronously,
 * because tens of thousands of individually-fast synchronous calls is exactly
 * the shape that freezes this app.
 */
@Injectable({ providedIn: 'root' })
export class PaneCaptureService {
    private logger: Logger

    constructor (
        private hostApp: HostAppService,
        log: LogService,
    ) {
        this.logger = log.create('resume')
    }

    async capture (probes: PaneProbe[], wslTimeoutMs: number): Promise<CaptureResult> {
        const result: CaptureResult = { panes: [], answered: [] }
        if (!probes.length) {
            return result
        }
        const wsl = probes.filter(x => x.isWSL)
        const native = probes.filter(x => !x.isWSL)
        const parts = await Promise.all([
            this.captureWSL(wsl, wslTimeoutMs),
            this.captureNative(native),
        ])
        for (const part of parts) {
            result.panes.push(...part.panes)
            result.answered.push(...part.answered)
        }
        return result
    }

    // ── WSL ──────────────────────────────────────────────────────────────

    private async captureWSL (probes: PaneProbe[], timeoutMs: number): Promise<CaptureResult> {
        const result: CaptureResult = { panes: [], answered: [] }
        const distros = [...new Set(probes.map(x => x.distro))]
        for (const distro of distros) {
            let records: WslRecord[] = []
            try {
                records = parseProbe(await this.runProbe(distro, timeoutMs))
            } catch (error) {
                // A cold, wedged or mid-upgrade distro. Every pane in it is
                // left unanswered, so whatever was recorded before stands.
                this.logger.debug(`WSL probe failed for ${distro || 'the default distro'}:`, error)
                continue
            }
            for (const probe of probes.filter(x => x.distro === distro)) {
                result.answered.push(probe.paneId)
                const found = foregroundOf(records, probe.sessionUID)
                if (found) {
                    result.panes.push({ paneId: probe.paneId, argv: found.argv, quoting: probe.quoting })
                }
            }
        }
        return result
    }

    private runProbe (distro: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            // No `-d` for a pane that named no distro: `wsl.exe` then picks the
            // default, which is by definition the one that pane is running in.
            const args = distro ? ['-d', distro, '--', 'sh', '-s'] : ['--', 'sh', '-s']
            const child = spawn('wsl.exe', args, {
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
            })
            let out = ''
            let settled = false
            let timer: any = null
            const finish = (error: Error | null) => {
                if (settled) {
                    return
                }
                settled = true
                clearTimeout(timer)
                if (error) {
                    reject(error)
                } else {
                    resolve(out)
                }
            }
            // A distro that will not answer must not hold a refresh open for
            // ever; the pane simply goes unanswered this round.
            timer = setTimeout(() => {
                try {
                    child.kill()
                } catch { }
                finish(new Error(`timed out after ${timeoutMs}ms`))
            }, timeoutMs)
            child.stdout.on('data', chunk => out += chunk)
            // Drained rather than left unattached: a full stderr pipe blocks
            // the writer, and a distro that prints a warning would then hang
            // instead of answering.
            child.stderr.resume()
            child.on('error', err => finish(err))
            child.on('close', () => finish(null))
            try {
                // The script is small enough to fit a pipe buffer, but a child
                // that died before reading it makes the write an EPIPE, and an
                // unhandled one on a stream is fatal to the process.
                child.stdin.on('error', err => this.logger.debug('WSL probe stdin:', err))
                child.stdin.end(WSL_PROBE_SCRIPT)
            } catch (err) {
                finish(err as Error)
            }
        })
    }

    // ── native ───────────────────────────────────────────────────────────

    private async captureNative (probes: PaneProbe[]): Promise<CaptureResult> {
        const result: CaptureResult = { panes: [], answered: [] }
        const usable = probes.filter(x => x.shellPid > 0)
        if (!usable.length) {
            return result
        }
        if (this.hostApp.platform === Platform.Windows) {
            if (!windowsProcessTree) {
                return result
            }
            // Issued together on purpose: the module coalesces concurrent
            // requests into one process snapshot, so N panes cost one walk.
            const trees = await Promise.all(usable.map(probe => new Promise<any>(resolve => {
                try {
                    windowsProcessTree.getProcessTree(
                        probe.shellPid,
                        (tree: any) => resolve(tree),
                        windowsProcessTree.ProcessDataFlag.CommandLine,
                    )
                } catch {
                    resolve(undefined)
                }
            })))
            usable.forEach((probe, i) => {
                result.answered.push(probe.paneId)
                const worker = firstWorkerBelow(trees[i])
                if (worker) {
                    result.panes.push({
                        paneId: probe.paneId,
                        argv: splitWindowsCommandLine(worker),
                        quoting: probe.quoting,
                    })
                }
            })
            return result
        }

        const list = await this.posixProcessList()
        if (!list) {
            return result
        }
        for (const probe of usable) {
            result.answered.push(probe.paneId)
            const worker = firstWorkerBelowList(probe.shellPid, list)
            if (worker) {
                result.panes.push({ paneId: probe.paneId, argv: worker, quoting: probe.quoting })
            }
        }
        return result
    }

    /**
     * One `ps` snapshot for the whole window, rather than a walk per pane.
     * Untested on this machine, which is Windows: the shape it produces is the
     * same one the Windows path produces, and a failure here means the feature
     * reports nothing rather than reporting something wrong.
     */
    private posixProcessList (): Promise<Map<number, { ppid: number, argv: string[] }> | null> {
        return new Promise(resolve => {
            try {
                const child = spawn('ps', ['-eo', 'pid=,ppid=,args='], { stdio: ['ignore', 'pipe', 'ignore'] })
                let out = ''
                child.stdout.on('data', chunk => out += chunk)
                child.on('error', () => resolve(null))
                child.on('close', () => {
                    const list = new Map<number, { ppid: number, argv: string[] }>()
                    for (const line of out.split('\n')) {
                        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
                        if (!match) {
                            continue
                        }
                        // `ps` cannot report an argv with its separators intact,
                        // so a whitespace split is the best available. It only
                        // ever misreads an argument that contained a space,
                        // which the resume command then splits the same way.
                        list.set(parseInt(match[1], 10), {
                            ppid: parseInt(match[2], 10),
                            argv: match[3].trim().split(/\s+/).filter(x => x),
                        })
                    }
                    resolve(list)
                })
            } catch {
                resolve(null)
            }
        })
    }
}
