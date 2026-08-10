/**
 * What a build is, as far as this machine is concerned.
 *
 * `installed` — an app installed by an installer, in a well-known location.
 * `source`    — the compiled output of a source checkout, run via Electron.
 * `packaged`  — an unpacked electron-builder output inside a checkout.
 * `installer` — an installer file sitting on disk; not runnable in place.
 */
export type BuildKind = 'installed' | 'source' | 'packaged' | 'installer'

/** One OS process attributed to a build. */
export interface BuildProcess {
    pid: number
    memoryBytes: number
    /** Epoch millis, or null when the OS would not tell us. */
    startedAt: number | null
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
    /** One-line explanation of what the entry actually is. */
    detail: string
    /** True for the build this window is running from. */
    isCurrent: boolean
    /** Still on disk as of the last scan. */
    exists: boolean
    processes: BuildProcess[]
    size: BuildSize | null
    sizeState: 'idle' | 'computing' | 'error'
}

export type BuildsView = 'cards' | 'table'
