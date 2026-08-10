import * as fs from 'fs/promises'
import * as path from 'path'
import { execFile } from 'child_process'
import { Injectable } from '@angular/core'

/** What a taskbar pin points at. */
export interface TaskbarPin {
    target: string
    arguments: string
    workingDirectory: string
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
    shortcutPath (): string {
        return path.join(
            process.env.APPDATA ?? '',
            'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Tabby.lnk',
        )
    }

    async isPinned (): Promise<boolean> {
        try {
            await fs.access(this.shortcutPath())
            return true
        } catch {
            return false
        }
    }

    /** What the pin currently launches, or null when Tabby is not pinned. */
    async read (): Promise<TaskbarPin | null> {
        if (!this.isSupported() || !await this.isPinned()) {
            return null
        }
        const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut(${psString(this.shortcutPath())})
[pscustomobject]@{
    target = $link.TargetPath
    arguments = $link.Arguments
    workingDirectory = $link.WorkingDirectory
} | ConvertTo-Json -Compress
`
        try {
            const parsed = JSON.parse(await runPowerShell(script))
            return {
                target: parsed.target ?? '',
                arguments: parsed.arguments ?? '',
                workingDirectory: parsed.workingDirectory ?? '',
            }
        } catch {
            return null
        }
    }

    /**
     * Aim the existing pin at a different build. Refuses to create the shortcut:
     * a .lnk dropped into that folder is not a pin — the taskbar only shows what
     * is also listed in the Taskband registry value, which is not ours to forge.
     */
    async repoint (spec: PinSpec): Promise<void> {
        if (!this.isSupported()) {
            throw new Error('Taskbar pinning is a Windows feature')
        }
        if (!await this.isPinned()) {
            throw new Error('Tabby is not pinned to the taskbar yet — pin it once from the taskbar, then this can retarget it')
        }
        // The icon is always rewritten, so a repointed pin cannot keep showing
        // the previous build's icon. It is not always the target: a source
        // build's target is electron.exe, which would put Electron's icon on
        // the taskbar.
        const script = `
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut(${psString(this.shortcutPath())})
$link.TargetPath = ${psString(spec.target)}
$link.Arguments = ${psString(spec.args.join(' '))}
$link.WorkingDirectory = ${psString(spec.cwd)}
$link.IconLocation = ${psString(`${spec.icon},0`)}
$link.Description = ${psString(spec.description)}
$link.Save()
`
        await runPowerShell(script)
    }
}
