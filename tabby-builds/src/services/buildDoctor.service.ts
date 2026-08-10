import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

import { BuildHealth, HealthFinding, TabbyBuild } from '../api'

/**
 * Builtin plugins without which the renderer cannot finish starting.
 *
 * Not the full set — the point is the ones whose absence is fatal. Losing any
 * of these throws `Cannot find module '<name>'` out of the plugin loader as an
 * unhandled rejection, which nothing catches, so the splash screen is never
 * replaced and the window sits there looking like a hang forever.
 */
const REQUIRED_BUILTINS = [
    'tabby-core',
    'tabby-settings',
    'tabby-terminal',
    'tabby-local',
    'tabby-electron',
]

/**
 * Package names that must never appear in the *user* plugin directory: they
 * are builtins, and a second copy on the module path loads a second Angular
 * and a second tabby-core, which breaks dependency injection in ways whose
 * symptom looks nothing like its cause.
 */
const NEVER_USER_PLUGINS = [
    'tabby-core', 'tabby-settings', 'tabby-terminal', 'tabby-local', 'tabby-electron',
]

/** How long a build may sit on the splash before that counts as stuck. */
const BOOT_GRACE_MS = 30000

/** The window title Tabby carries before it has opened a tab. */
function isSplashTitle (title: string): boolean {
    return !title || title.trim().toLowerCase() === 'tabby'
}

async function exists (p: string): Promise<boolean> {
    try {
        await fs.access(p)
        return true
    } catch {
        return false
    }
}

async function readDirSafe (dir: string): Promise<{ name: string, isDirectory: () => boolean }[]> {
    try {
        return await fs.readdir(dir, { withFileTypes: true })
    } catch {
        return []
    }
}

/**
 * Works out why a build will not start — and, where the answer is knowable
 * from disk, what would fix it.
 *
 * Every check here exists because it actually happened: an update applied
 * while the old version was still running deleted nine of the twelve builtin
 * plugin directories, and the app then started to a splash screen and stayed
 * there. Windows reported the process as responding the whole time, so none of
 * the usual "not responding" signals noticed anything wrong.
 */
@Injectable({ providedIn: 'root' })
export class BuildDoctorService {
    constructor (private config: ConfigService) { }

    async examine (build: TabbyBuild): Promise<BuildHealth> {
        const findings: HealthFinding[] = []
        findings.push(...await this.checkPayload(build))
        findings.push(...await this.checkUserPlugins(build))
        findings.push(...this.checkLiveState(build))

        return {
            checkedAt: Date.now(),
            findings,
            verdict: findings.some(x => x.severity === 'error') ? 'broken'
                : findings.length ? 'degraded' : 'healthy',
        }
    }

    /**
     * Is everything the build needs actually on disk? This is the check that
     * would have named the real fault in seconds instead of an hour.
     */
    private async checkPayload (build: TabbyBuild): Promise<HealthFinding[]> {
        if (build.kind === 'installer') {
            return []
        }
        if (build.kind === 'source') {
            const missing: string[] = []
            for (const file of ['bundle.js', 'main.js', 'index.html']) {
                if (!await exists(path.join(build.root, file))) {
                    missing.push(file)
                }
            }
            return missing.length ? [{
                id: 'source-output',
                severity: 'error',
                title: 'The compiled output is incomplete',
                detail: `Missing from app/dist: ${missing.join(', ')}. Run \`yarn run build\` in the checkout.`,
                fix: 'none',
            }] : []
        }

        const resources = path.join(build.root, 'resources')
        // Asked of the directory listing rather than with access(): Electron
        // mounts an .asar as a directory, so access() on the archive itself
        // goes through the asar layer and answers ENOENT for a file that is
        // plainly there.
        const resourceEntries = await readDirSafe(resources)
        if (!resourceEntries.some(x => x.name === 'app.asar')) {
            return [{
                id: 'asar',
                severity: 'error',
                title: 'The application bundle is missing',
                detail: `No app.asar under ${resources}. This install is not repairable in place — reinstall it.`,
                fix: 'reinstall',
            }]
        }

        const builtins = path.join(resources, 'builtin-plugins')
        const present = new Set((await readDirSafe(builtins))
            .filter(x => x.isDirectory())
            .map(x => x.name))
        const missing: string[] = []
        const broken: string[] = []
        for (const name of REQUIRED_BUILTINS) {
            if (!present.has(name)) {
                missing.push(name)
                continue
            }
            const dir = path.join(builtins, name)
            if (!await exists(path.join(dir, 'package.json')) || !await exists(path.join(dir, 'dist'))) {
                broken.push(name)
            }
        }

        const findings: HealthFinding[] = []
        if (missing.length) {
            findings.push({
                id: 'builtins-missing',
                severity: 'error',
                title: `${missing.length} required builtin plugin${missing.length > 1 ? 's are' : ' is'} missing`,
                detail: `${missing.join(', ')} — the renderer throws "Cannot find module '${missing[0]}'" during startup and never leaves the splash screen. This is what a half-applied update leaves behind. Reinstalling the same version restores them.`,
                fix: 'reinstall',
            })
        }
        if (broken.length) {
            findings.push({
                id: 'builtins-incomplete',
                severity: 'error',
                title: `${broken.length} builtin plugin director${broken.length > 1 ? 'ies are' : 'y is'} incomplete`,
                detail: `${broken.join(', ')} — present but with no package.json or no dist. Reinstall to restore.`,
                fix: 'reinstall',
            })
        }
        if (!findings.length && present.size < REQUIRED_BUILTINS.length + 2) {
            findings.push({
                id: 'builtins-thin',
                severity: 'warning',
                title: 'Fewer builtin plugins than expected',
                detail: `${present.size} plugin directories. The build starts, but features may be missing.`,
                fix: 'reinstall',
            })
        }
        return findings
    }

    /**
     * A builtin copied into the user plugin directory shadows the real one.
     * Only meaningful for the config directory this build actually reads.
     */
    private async checkUserPlugins (build: TabbyBuild): Promise<HealthFinding[]> {
        const configDir = build.configPath
            ? path.dirname(build.configPath)
            : build.kind === 'portable' ? path.join(build.root, 'data') : null
        if (!configDir) {
            return []
        }
        const modules = path.join(configDir, 'plugins', 'node_modules')
        const present = (await readDirSafe(modules)).filter(x => x.isDirectory()).map(x => x.name)
        const shadowing = present.filter(x => NEVER_USER_PLUGINS.includes(x))
        return shadowing.length ? [{
            id: 'shadowed-builtins',
            severity: 'warning',
            title: `${shadowing.length} builtin plugin${shadowing.length > 1 ? 's are' : ' is'} shadowed by a user copy`,
            detail: `${shadowing.join(', ')} in ${modules}. These are builtins; a second copy on the module path loads a second Angular and breaks dependency injection. They usually arrive as dependencies of a third-party plugin. Removing them is safe.`,
            fix: 'revealUserPlugins',
        }] : []
    }

    /** What the running processes say about a build that is up. */
    private checkLiveState (build: TabbyBuild): HealthFinding[] {
        if (!build.processes.length) {
            return []
        }
        const findings: HealthFinding[] = []
        const window = build.processes.find(x => x.hasWindow)
        const started = build.processes
            .map(x => x.startedAt)
            .filter((x): x is number => !!x)
        const age = started.length ? Date.now() - Math.min(...started) : 0

        if (window?.responding === false) {
            findings.push({
                id: 'not-responding',
                severity: 'error',
                title: 'The window has stopped responding',
                detail: 'It is no longer answering window messages. Restarting is the only way back.',
                fix: 'restart',
            })
        } else if (window && age > BOOT_GRACE_MS && isSplashTitle(window.title)) {
            // The decisive signal, and the one Windows cannot give you: a
            // booted Tabby names its window after the active tab. Still being
            // called "Tabby" long after start means the renderer never got far
            // enough to open one.
            findings.push({
                id: 'stuck-at-boot',
                severity: 'error',
                title: 'Started but never finished loading',
                detail: `The window has been showing the splash screen for ${Math.round(age / 60000)} min — its title is still "${window.title}" rather than a tab. Windows still reports the process as responding, so nothing else will flag this. Check the payload findings above for the cause.`,
                fix: 'restart',
            })
        }

        // Files replaced underneath a running instance: the usual precursor to
        // the broken update, and worth saying before the next restart bites.
        if (build.builtAt && started.length && build.builtAt > Math.min(...started)) {
            findings.push({
                id: 'stale-processes',
                severity: 'warning',
                title: 'Running from code that is no longer on disk',
                detail: 'The build was written after these processes started, so they are still executing the previous version. Restart to pick up what is on disk.',
                fix: 'restart',
            })
        }
        return findings
    }

    /**
     * An installer on this machine that would repair the build — same major
     * version, so it restores rather than upgrades.
     */
    async findRepairInstaller (build: TabbyBuild, all: TabbyBuild[]): Promise<string | null> {
        if (!build.version) {
            return null
        }
        const wanted = build.version.split('-')[0]
        const match = all.find(x => x.kind === 'installer' && x.version?.split('-')[0] === wanted)
        return match?.root ?? null
    }

    /** Where a downloaded installer belongs, following this machine's layout. */
    downloadDirectory (): string {
        return path.join(os.homedir(), 'Downloads', 'Installers')
    }

    /** The release page for a version, for the case where nothing local fits. */
    releaseURL (build: TabbyBuild): string {
        const version = build.version?.split('-')[0]
        return version
            ? `https://github.com/Eugeny/tabby/releases/tag/v${version}`
            : 'https://github.com/Eugeny/tabby/releases'
    }

    get autoCheckEnabled (): boolean {
        return this.config.store.builds.autoDiagnose
    }
}
