/**
 * What a build is, as far as this machine is concerned.
 *
 * `installed` — an app installed by an installer, in a well-known location.
 * `portable`  — a self-contained app directory that keeps its own `data`
 *               folder: a frozen build slot, or an unpacked portable release.
 * `source`    — the compiled output of a source checkout, run via Electron.
 * `packaged`  — an unpacked application directory with no data folder.
 * `installer` — an installer file sitting on disk; not runnable in place.
 */
export type BuildKind = 'installed' | 'portable' | 'source' | 'packaged' | 'installer'

/** One OS process attributed to a build. */
export interface BuildProcess {
    pid: number
    memoryBytes: number
    /** Epoch millis, or null when the OS would not tell us. */
    startedAt: number | null
    /** Total CPU time consumed since start, in ms. */
    cpuMs: number
    /** True for the process owning the app's main window. */
    hasWindow: boolean
    /**
     * The main window's title. A booted Tabby titles its window after the
     * active tab; one that never got past the splash is still called "Tabby".
     * That difference is the only external signal that catches a boot that
     * stalled — `responding` stays true throughout one.
     */
    title: string
    /** False once the window stops answering messages. Null without a window. */
    responding: boolean | null
}

/**
 * Repo provenance for a source build. `head` is what the checkout points at
 * *now*; `builtFrom` is what the bundle on disk was compiled from. They differ
 * whenever the tree moved on without a rebuild, which is the single most
 * common reason a dev build behaves like an older commit.
 */
export interface BuildGitInfo {
    branch: string | null
    head: string | null
    builtFrom: string | null
}

/** Size of a build on disk. Computed lazily — a walk of 3k files is not free. */
export interface BuildSize {
    bytes: number
    files: number
    computedAt: number
}

export interface TabbyBuild {
    /** Normalized root path; stable across scans, so UI state survives a refresh. */
    id: string
    kind: BuildKind
    name: string
    /**
     * The directory (or file) that *is* this build — what gets sized, revealed
     * and deleted. Deliberately never the repo root for a source build: that
     * would make "delete" mean "delete the checkout".
     */
    root: string
    /**
     * Further directories that are part of this build. A source build's output
     * is not one directory: the app bundle, every plugin's `dist`, and the
     * builtin-plugins links are all products of the same `yarn build`, and
     * "size" and "delete" would both lie if they only counted the first.
     */
    extraPaths: string[]
    /** What Launch runs. Null when nothing here is runnable in place. */
    executable: string | null
    /** File whose mtime is taken as the build time. */
    stampPath: string | null
    version: string | null
    /** Epoch millis. */
    builtAt: number | null
    /** From the PE header / bundle name, not assumed from the host. */
    arch: string | null
    git: BuildGitInfo | null
    /** The source checkout this build came out of, when there is one. */
    repoPath: string | null
    /** Config directory this build reads, when we can tell. */
    configPath: string | null
    /** Uninstaller shipped alongside an installed build, when there is one. */
    uninstaller: string | null
    /** Upstream commit this build's fork was based on, when it records one. */
    upstreamBase: string | null
    /** One-line explanation of what the entry actually is. */
    detail: string
    /** True for the build this window is running from. */
    isCurrent: boolean
    /**
     * The build the taskbar pin launches — "the Tabby you use". Exactly one
     * build is active at a time, and the active one can never be deleted, so
     * there is always a working Tabby left on the machine.
     */
    isActive: boolean
    /** Still on disk as of the last scan. */
    exists: boolean
    processes: BuildProcess[]
    size: BuildSize | null
    sizeState: 'idle' | 'computing' | 'error'
    /** Result of the last health check; null until one has run. */
    health: BuildHealth | null
}

export type BuildsView = 'cards' | 'table'

/** What can be done about a finding, beyond reading it. */
export type HealthFix = 'none' | 'restart' | 'reinstall' | 'revealUserPlugins'

/**
 * A finding is structured rather than a paragraph: the names it is about, the
 * place it is about, what goes wrong and what to do are four different kinds of
 * thing, and running them together as prose makes the one you need hardest to
 * find.
 */
export interface HealthFinding {
    id: string
    severity: 'warning' | 'error'
    /** One line, the whole point of the finding. */
    title: string
    /** The names the finding is about — plugins, files. Rendered as chips. */
    items?: string[]
    /** Where, in one path. Rendered monospace on its own line. */
    location?: string
    /** What actually goes wrong. One sentence. */
    detail: string
    /** Why it happened, or what to do about it. One sentence. */
    hint?: string
    fix?: HealthFix
}

export interface BuildHealth {
    checkedAt: number
    findings: HealthFinding[]
    verdict: 'healthy' | 'degraded' | 'broken'
}
