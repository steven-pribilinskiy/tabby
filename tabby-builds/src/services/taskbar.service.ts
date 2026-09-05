import * as path from 'path'
import { execFile } from 'child_process'
import { Injectable } from '@angular/core'

/** What a taskbar pin points at. */
export interface TaskbarPin {
    /** The .lnk file itself. */
    shortcut: string
    target: string
    arguments: string
    workingDirectory: string
}

/**
 * Does this pin launch a Tabby? Either the app binary directly, or an Electron
 * running a checkout — which is how a source build is pinned.
 */
function isTabbyTarget (pin: TaskbarPin): boolean {
    const name = path.basename(pin.target).toLowerCase()
    if (name === 'tabby.exe' || name === 'tabby') {
        return true
    }
    return /^electron(\.exe)?$/.test(name) && /(^|\s)app(\s|$)/.test(pin.arguments)
}

/** How the shortcut is described so it is recognisable in a jump list. */
export interface PinSpec {
    target: string
    args: string[]
    cwd: string
    /** File to take the icon from — not always the target. */
    icon: string
    description: string
}

/** PowerShell single-quoted strings escape a quote by doubling it. */
function psString (value: string): string {
    return `'${value.replace(/'/g, '\'\'')}'`
}

function runPowerShell (script: string): Promise<string> {
    const shell = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    )
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    return new Promise((resolve, reject) => {
        execFile(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            windowsHide: true, timeout: 20000,
        }, (err, stdout) => err ? reject(err) : resolve(stdout.toString()))
    })
}

/**
 * The Tabby entry pinned to the Windows taskbar.
 *
 * Windows has not exposed a "pin to taskbar" verb since 1809 — the shell verb
 * is gone from the context menu and blocked for automation, so nothing here can
 * create a pin. What it *can* do is repoint one that already exists: a taskbar
 * pin is a shortcut file, and rewriting its target is what makes the pin launch
 * a different build.
 *
 * So the contract is: pin Tabby by hand once, and this keeps that single pin
 * aimed at whichever build is active.
 */
@Injectable({ providedIn: 'root' })
export class TaskbarService {
    isSupported (): boolean {
        return process.platform === 'win32'
    }

    /**
     * Where the taskbar keeps its pins. Still the Internet Explorer Quick Launch
     * path, twenty years on.
     */
    pinDirectory (): string {
        return path.join(
            process.env.APPDATA ?? '',
            'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar',
        )
    }

    /**
     * Every pinned shortcut that launches a Tabby, whatever it happens to be
     * called.
     *
     * Assuming a single pin named `Tabby.lnk` was wrong on this machine: a
     * second pin called `Tabby-fork` existed for the fork builds, was invisible
     * to a name-based lookup, and was left pointing at a directory that had
     * been renamed out from under it. Discovering pins by what they *launch*
     * means the count and the names stop mattering.
     */
    async pins (): Promise<TaskbarPin[]> {
        if (!this.isSupported()) {
            return []
        }
        const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$rows = foreach ($f in Get-ChildItem -LiteralPath ${psString(this.pinDirectory())} -Filter *.lnk) {
    $link = $shell.CreateShortcut($f.FullName)
    [pscustomobject]@{
        shortcut = $f.FullName
        target = $link.TargetPath
        arguments = $link.Arguments
        workingDirectory = $link.WorkingDirectory
    }
}
$json = @($rows) | ConvertTo-Json -Depth 3 -Compress
if (-not $json) { $json = '[]' }
if ($json[0] -ne '[') { $json = "[$json]" }
Write-Output $json
`
        try {
            const rows = JSON.parse(await runPowerShell(script) || '[]')
            return rows
                .map((row: any) => ({
                    shortcut: row.shortcut ?? '',
                    target: row.target ?? '',
                    arguments: row.arguments ?? '',
                    workingDirectory: row.workingDirectory ?? '',
                }))
                .filter((pin: TaskbarPin) => isTabbyTarget(pin))
        } catch {
            return []
        }
    }

    // ── The Start menu ───────────────────────────────────────

    /**
     * The fork's own Start menu entry.
     *
     * This is what makes pinning possible at all. Windows offers *Pin to
     * Start* and *Pin to taskbar* for things it considers Start menu apps;
     * a shortcut anywhere else — `~\Tabby\Tabby-fork.lnk`, say — is found by
     * search but offers only Run as administrator and Open file location.
     * Unlike a taskbar pin, this shortcut is ours to create.
     *
     * One stable name, never the build's: pinning copies the shortcut, and
     * a name that changed with the active build would strand every pin ever
     * made from it.
     */
    startMenuShortcut (): string {
        return path.join(
            process.env.APPDATA ?? '',
            'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Tabby-fork.lnk',
        )
    }

    /** What the Start menu entry launches, or null when there is none. */
    async readStartMenuShortcut (): Promise<TaskbarPin | null> {
        if (!this.isSupported()) {
            return null
        }
        const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not (Test-Path -LiteralPath ${psString(this.startMenuShortcut())})) { Write-Output ''; exit }
$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psString(this.startMenuShortcut())})
[pscustomobject]@{
    shortcut = ${psString(this.startMenuShortcut())}
    target = $link.TargetPath
    arguments = $link.Arguments
    workingDirectory = $link.WorkingDirectory
} | ConvertTo-Json -Compress
`
        try {
            const out = (await runPowerShell(script)).trim()
            return out ? JSON.parse(out) : null
        } catch {
            return null
        }
    }

    /**
     * Create the Start menu entry, or aim an existing one at another build.
     *
     * Creating it is not the same as pinning it: Windows still requires the
     * pin itself to be made by hand, and this is the thing there is finally
     * something to right-click.
     */
    async writeStartMenuShortcut (spec: PinSpec): Promise<string> {
        if (!this.isSupported()) {
            throw new Error('Start menu shortcuts are a Windows feature')
        }
        const shortcut = this.startMenuShortcut()
        await runPowerShell(`
$ErrorActionPreference = 'Stop'
$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${psString(shortcut)})
$link.TargetPath = ${psString(spec.target)}
$link.Arguments = ${psString(spec.args.join(' '))}
$link.WorkingDirectory = ${psString(spec.cwd)}
$link.IconLocation = ${psString(`${spec.icon},0`)}
$link.Description = ${psString(spec.description)}
$link.Save()
`)
        return shortcut
    }

    async isPinned (): Promise<boolean> {
        return (await this.pins()).length > 0
    }

    /** What the pins currently launch — the first one, for display. */
    async read (): Promise<TaskbarPin | null> {
        const pins = await this.pins()
        return pins.length ? pins[0] : null
    }

    /**
     * Aim the existing pin at a different build. Refuses to create the shortcut:
     * a .lnk dropped into that folder is not a pin — the taskbar only shows what
     * is also listed in the Taskband registry value, which is not ours to forge.
     */
    async repoint (spec: PinSpec): Promise<number> {
        if (!this.isSupported()) {
            throw new Error('Taskbar pinning is a Windows feature')
        }
        const pins = await this.pins()
        if (!pins.length) {
            throw new Error('Tabby is not pinned to the taskbar yet — pin it once from the taskbar, then this can retarget it')
        }
        // Every Tabby pin is retargeted, not just the first: leaving a second
        // one behind is how you end up with a pin aimed at a directory that no
        // longer exists.
        //
        // The icon is always rewritten too, so a repointed pin cannot keep
        // showing the previous build's. It is not always the target — a source
        // build's target is electron.exe, whose icon is Electron's.
        const script = pins.map(pin => `
$link = $shell.CreateShortcut(${psString(pin.shortcut)})
$link.TargetPath = ${psString(spec.target)}
$link.Arguments = ${psString(spec.args.join(' '))}
$link.WorkingDirectory = ${psString(spec.cwd)}
$link.IconLocation = ${psString(`${spec.icon},0`)}
$link.Description = ${psString(spec.description)}
$link.Save()
`).join('\n')
        await runPowerShell(`
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
${script}
`)
        return pins.length
    }
}
