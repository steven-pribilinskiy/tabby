import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { Injectable } from '@angular/core'

import { BuildProcess } from '../api'

/** A process, before it has been attributed to a build. */
export interface RunningProcess extends BuildProcess {
    /** Absolute path of the executable, normalized for comparison. */
    executable: string
}

/** Only these ever belong to a Tabby build; everything else is skipped early. */
const NAME_PATTERN = /^(tabby|electron)(\.exe)?$/i

/**
 * Windows has no cheap native way to map a PID to its executable path, and
 * `tasklist` does not report one. PowerShell does, in a single call — passed
 * base64 so no quoting rules apply to the paths coming back.
 */
const WINDOWS_PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$epoch = [datetime]'1970-01-01'
$rows = foreach ($p in Get-Process -Name Tabby,tabby,electron) {
    $exe = $null
    try { $exe = $p.Path } catch { }
    if (-not $exe) { continue }
    $started = $null
    try { $started = [int64]($p.StartTime.ToUniversalTime() - $epoch).TotalMilliseconds } catch { }
    $title = ''
    $responding = $null
    $hasWindow = $false
    try {
        if ($p.MainWindowHandle -ne 0) {
            $hasWindow = $true
            $title = $p.MainWindowTitle
            # Wraps IsHungAppWindow: false means the window has stopped
            # answering messages. True proves nothing about whether the app
            # ever finished starting.
            $responding = $p.Responding
        }
    } catch { }
    [pscustomobject]@{
        pid = $p.Id; exe = $exe; mem = $p.WorkingSet64; started = $started
        cpu = [int64]$p.TotalProcessorTime.TotalMilliseconds
        window = $hasWindow; title = $title; responding = $responding
    }
}
$json = @($rows) | ConvertTo-Json -Depth 3 -Compress
if (-not $json) { $json = '[]' }
if ($json[0] -ne '[') { $json = "[$json]" }
Write-Output $json
`

/** Windows paths are compared case-insensitively; everything else is not. */
export function normalize (p: string): string {
    const resolved = path.resolve(p)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** `[[dd-]hh:]mm:ss` as seconds. */
function parseElapsed (value: string): number | null {
    const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(value)
    if (!match) {
        return null
    }
    const days = match[1] ? parseInt(match[1], 10) : 0
    const hours = match[2] ? parseInt(match[2], 10) : 0
    return days * 86400 + hours * 3600 + parseInt(match[3], 10) * 60 + parseInt(match[4], 10)
}

function run (command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            windowsHide: true,
            maxBuffer: 8 * 1024 * 1024,
            timeout: 15000,
        }, (err, stdout) => {
            if (err) {
                reject(err)
                return
            }
            resolve(stdout.toString())
        })
    })
}

/**
 * Live process attribution.
 *
 * This is the only part of the page that has to be polled, so it is kept to a
 * single OS call that returns every candidate at once — asking per build would
 * multiply the cost by the number of builds for no extra information.
 */
@Injectable({ providedIn: 'root' })
export class BuildProcessesService {
    /** Last successful snapshot, so a failed poll shows stale data, not zeroes. */
    private last: RunningProcess[] = []
    private inFlight: Promise<RunningProcess[]> | null = null

    get snapshot (): RunningProcess[] {
        return this.last
    }

    /** Never runs two probes at once: a slow poll must not queue up behind itself. */
    async list (): Promise<RunningProcess[]> {
        if (this.inFlight) {
            return this.inFlight
        }
        this.inFlight = this.probe()
            .then(rows => {
                this.last = rows
                return rows
            })
            .catch(() => this.last)
            .finally(() => {
                this.inFlight = null
            })
        return this.inFlight
    }

    /** Processes belonging to one executable, newest information first. */
    forExecutable (executable: string | null): BuildProcess[] {
        if (!executable) {
            return []
        }
        const key = normalize(executable)
        return this.last
            .filter(x => x.executable === key)
            .map(({ executable: _, ...rest }) => rest)
            .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
    }

    private async probe (): Promise<RunningProcess[]> {
        if (process.platform === 'win32') {
            return this.probeWindows()
        }
        if (process.platform === 'linux') {
            return this.probeProc()
        }
        return this.probePs()
    }

    private async probeWindows (): Promise<RunningProcess[]> {
        const shell = path.join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
        )
        const encoded = Buffer.from(WINDOWS_PROBE, 'utf16le').toString('base64')
        const stdout = await run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
        const rows = JSON.parse(stdout || '[]')
        return rows.map((row: any) => ({
            pid: row.pid,
            executable: normalize(row.exe),
            memoryBytes: row.mem ?? 0,
            startedAt: row.started ?? null,
            cpuMs: row.cpu ?? 0,
            hasWindow: !!row.window,
            title: row.title ?? '',
            responding: row.window ? !!row.responding : null,
        }))
    }

    /**
     * Linux needs no subprocess at all — /proc has everything, and reading it
     * is far cheaper than spawning `ps` every few seconds.
     */
    private async probeProc (): Promise<RunningProcess[]> {
        const bootTime = await this.linuxBootTime()
        const ticks = 100 // USER_HZ; constant on every mainstream kernel build
        const entries = await fs.readdir('/proc')
        const out: RunningProcess[] = []
        for (const entry of entries) {
            if (!/^\d+$/.test(entry)) {
                continue
            }
            try {
                const exe = await fs.readlink(`/proc/${entry}/exe`)
                if (!NAME_PATTERN.test(path.basename(exe))) {
                    continue
                }
                const statm = await fs.readFile(`/proc/${entry}/statm`, 'utf8')
                const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8')
                // Field 22 is start time in ticks since boot, but the comm field
                // may contain spaces, so count from the closing parenthesis.
                const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
                const startTicks = parseInt(after[19], 10)
                // utime + stime, fields 14 and 15, counted from the state field.
                const cpuTicks = (parseInt(after[11], 10) || 0) + (parseInt(after[12], 10) || 0)
                out.push({
                    pid: parseInt(entry, 10),
                    executable: normalize(exe),
                    // statm reports pages resident; page size is 4 KB everywhere
                    // Tabby runs.
                    memoryBytes: parseInt(statm.split(' ')[1], 10) * 4096,
                    startedAt: isNaN(startTicks) ? null : bootTime + startTicks / ticks * 1000,
                    cpuMs: cpuTicks / ticks * 1000,
                    // X11/Wayland window state is not readable this cheaply;
                    // reporting nothing beats reporting a guess.
                    hasWindow: false,
                    title: '',
                    responding: null,
                })
            } catch {
                // Not ours to read, or it exited between readdir and readlink.
            }
        }
        return out
    }

    private async linuxBootTime (): Promise<number> {
        try {
            const stat = await fs.readFile('/proc/stat', 'utf8')
            const match = /^btime (\d+)$/m.exec(stat)
            if (match) {
                return parseInt(match[1], 10) * 1000
            }
        } catch {
            // Fall through to an approximation.
        }
        return Date.now() - os.uptime() * 1000
    }

    /** macOS: `comm` is the full executable path there, which is what we need. */
    private async probePs (): Promise<RunningProcess[]> {
        const stdout = await run('ps', ['-axo', 'pid=,rss=,etime=,comm='])
        const out: RunningProcess[] = []
        for (const line of stdout.split('\n')) {
            const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
            if (!match) {
                continue
            }
            const exe = match[4]
            if (!NAME_PATTERN.test(path.basename(exe))) {
                continue
            }
            const elapsed = parseElapsed(match[3])
            out.push({
                pid: parseInt(match[1], 10),
                executable: normalize(exe),
                memoryBytes: parseInt(match[2], 10) * 1024,
                startedAt: elapsed === null ? null : Date.now() - elapsed * 1000,
                cpuMs: 0,
                hasWindow: false,
                title: '',
                responding: null,
            })
        }
        return out
    }
}
