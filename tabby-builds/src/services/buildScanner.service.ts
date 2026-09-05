import type { FileHandle } from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

import { BuildGitInfo, BuildKind, TabbyBuild } from '../api'
import { fs } from '../nodeFs'
import { normalize } from './buildProcesses.service'

/** Directory names never worth descending into while looking for checkouts. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.yarn', '.cache', 'venv', '__pycache__'])

/** Files that count as a Tabby installer or portable bundle. */
const INSTALLER_PATTERN = /^tabby[-_. ].*\.(exe|msi|dmg|appimage|deb|rpm|zip|snap)$/i

/** Running build first, then by kind, then newest build first. */
const KIND_ORDER: Record<BuildKind, number> = {
    installed: 0, portable: 1, source: 2, packaged: 3, installer: 4,
}

/**
 * What a frozen build slot records about itself, in a BUILD-INFO.txt beside the
 * binary. Worth reading: a slot's executable carries no real version resource
 * (it reports 1.0.0), and its directory name is the only other clue.
 */
interface SlotBuildInfo {
    slot: string | null
    version: string | null
    commit: string | null
    branch: string | null
    repo: string | null
    upstreamBase: string | null
}

/** A build before it has been enriched with versions, sizes and processes. */
interface Seed {
    kind: BuildKind
    name: string
    root: string
    extraPaths: string[]
    executable: string | null
    stampPath: string | null
    repoPath: string | null
    detail: string
    uninstaller?: string | null
    buildInfo?: SlotBuildInfo | null
}

/** `IMAGE_FILE_HEADER.Machine`, so arch is read from the file, not assumed. */
function peMachineName (machine: number): string | null {
    switch (machine) {
        case 0x014c: return 'x86'
        case 0x8664: return 'x64'
        case 0xaa64: return 'arm64'
        case 0x01c4: return 'armv7'
        default: return null
    }
}

function installerSeed (full: string, name: string, tree: string | null): Seed {
    return {
        kind: 'installer',
        name,
        root: full,
        extraPaths: [],
        executable: null,
        stampPath: full,
        repoPath: tree,
        detail: tree ? 'Installer produced by this checkout' : 'Installer file on disk',
    }
}

function compareBuilds (a: TabbyBuild, b: TabbyBuild): number {
    if (a.isCurrent !== b.isCurrent) {
        return a.isCurrent ? -1 : 1
    }
    if (a.kind !== b.kind) {
        return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    }
    return (b.builtAt ?? 0) - (a.builtAt ?? 0)
}

// ── Small filesystem helpers ─────────────────────────────────────────────

async function exists (p: string): Promise<boolean> {
    try {
        await fs.access(p)
        return true
    } catch {
        return false
    }
}

async function firstExisting (paths: string[]): Promise<string | null> {
    for (const p of paths) {
        if (await exists(p)) {
            return p
        }
    }
    return null
}

async function statSafe (p: string | null): Promise<{ mtimeMs: number } | null> {
    if (!p) {
        return null
    }
    try {
        return await fs.stat(p)
    } catch {
        return null
    }
}

async function newestOf (paths: string[]): Promise<string | null> {
    let best: { path: string, mtime: number } | null = null
    for (const p of paths) {
        const stat = await statSafe(p)
        if (stat && (!best || stat.mtimeMs > best.mtime)) {
            best = { path: p, mtime: stat.mtimeMs }
        }
    }
    return best ? best.path : null
}

async function readDirSafe (dir: string): Promise<{ name: string, isDirectory: () => boolean }[]> {
    try {
        return await fs.readdir(dir, { withFileTypes: true })
    } catch {
        return []
    }
}

async function readTextSafe (p: string): Promise<string | null> {
    try {
        return await fs.readFile(p, 'utf8')
    } catch {
        return null
    }
}

async function readJSON (p: string): Promise<any | null> {
    const text = await readTextSafe(p)
    if (!text) {
        return null
    }
    try {
        return JSON.parse(text)
    } catch {
        return null
    }
}

/** Parse the fields a build slot records about itself. Absent file → null. */
async function readBuildInfo (dir: string): Promise<SlotBuildInfo | null> {
    const text = await readTextSafe(path.join(dir, 'BUILD-INFO.txt'))
    if (!text) {
        return null
    }
    const field = (name: string): string | null => {
        const match = new RegExp(`^${name}:\\s*(.+?)\\s*$`, 'mi').exec(text)
        return match ? match[1] : null
    }
    const repoLine = field('Repo')
    const slot = field('Slot')
    // A slot id is <version>-<MMDD>-<HHmm>-<sha>, and the version part ends in
    // a `.0` that never changes. Trading that placeholder for the build stamp
    // makes two slots of the same nightly tell themselves apart at a glance:
    // 1.0.236-nightly.0810-1556 rather than two identical 1.0.236-nightly.0.
    const stamped = slot ? /^(.*?)-(\d{4})-(\d{4})-[0-9a-f]{8}$/.exec(slot) : null
    return {
        slot,
        version: stamped
            ? `${stamped[1].replace(/\.\d+$/, '')}.${stamped[2]}-${stamped[3]}`
            : slot ? /^(\d+\.\d+\.\d+(?:-[a-z0-9.]+)?)/i.exec(slot)?.[1] ?? null : null,
        commit: field('Commit'),
        branch: repoLine ? /\(branch:\s*([^)]+)\)/.exec(repoLine)?.[1]?.trim() ?? null : null,
        repo: repoLine ? repoLine.replace(/\s*\(branch:.*$/, '').trim() : null,
        upstreamBase: field('Upstream base')?.split(/\s+/)[0] ?? null,
    }
}

/**
 * Finds every Tabby build on this machine and describes it.
 *
 * Discovery is deliberately explicit — well-known install locations plus a
 * bounded walk of configured roots — rather than a whole-disk search. A scan
 * that takes ten seconds would have to be manual, and a page that has to be
 * asked for is a page nobody opens.
 */
@Injectable({ providedIn: 'root' })
export class BuildScannerService {
    constructor (private config: ConfigService) { }

    async scan (): Promise<TabbyBuild[]> {
        const seeds: Seed[] = []
        seeds.push(...await this.wellKnownInstalls())

        const roots = this.searchRoots()
        const found = await this.walkRoots(roots)
        seeds.push(...found.apps, ...found.installers)

        // The checkout this window is running from may live outside the
        // configured roots; it is never the one you want missing.
        const trees = found.trees
        const currentTree = await this.currentSourceTree()
        if (currentTree && !trees.some(x => normalize(x) === normalize(currentTree))) {
            trees.push(currentTree)
        }
        for (const tree of trees) {
            seeds.push(...await this.describeSourceTree(tree))
        }

        const unique = new Map<string, Seed>()
        for (const seed of seeds) {
            const id = normalize(seed.root)
            if (!unique.has(id)) {
                unique.set(id, seed)
            }
        }

        const versions = await this.readVersions(
            [...unique.values()].map(x => x.executable).filter((x): x is string => !!x),
        )

        const current = normalize(process.execPath)
        const builds = await Promise.all([...unique.entries()].map(
            ([id, seed]) => this.materialize(id, seed, versions, current),
        ))
        return builds
            .filter(x => x.exists)
            .sort(compareBuilds)
    }

    // ── Discovery ────────────────────────────────────────────────────────

    private searchRoots (): string[] {
        const configured: string[] = this.config.store.builds.searchRoots ?? []
        return configured
            .map(x => x.trim())
            .filter(x => !!x)
            .map(x => x.startsWith('~') ? path.join(os.homedir(), x.slice(1)) : x)
            .map(x => path.resolve(x))
    }

    private async wellKnownInstalls (): Promise<Seed[]> {
        const home = os.homedir()
        const candidates: { root: string, executable: string }[] = []
        if (process.platform === 'win32') {
            const roots = [
                process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Tabby') : null,
                process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Tabby') : null,
                process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Tabby') : null,
            ].filter((x): x is string => !!x)
            candidates.push(...roots.map(root => ({ root, executable: path.join(root, 'Tabby.exe') })))
        } else if (process.platform === 'darwin') {
            const roots = ['/Applications/Tabby.app', path.join(home, 'Applications', 'Tabby.app')]
            candidates.push(...roots.map(root => ({
                root, executable: path.join(root, 'Contents', 'MacOS', 'Tabby'),
            })))
        } else {
            candidates.push(
                { root: '/opt/Tabby', executable: '/opt/Tabby/tabby' },
                { root: '/usr/lib/tabby', executable: '/usr/lib/tabby/tabby' },
                {
                    root: path.join(home, '.local', 'share', 'Tabby'),
                    executable: path.join(home, '.local', 'share', 'Tabby', 'tabby'),
                },
            )
        }

        const seeds: Seed[] = []
        for (const candidate of candidates) {
            if (!await exists(candidate.executable)) {
                continue
            }
            seeds.push({
                kind: 'installed',
                name: 'Tabby',
                root: candidate.root,
                extraPaths: [],
                executable: candidate.executable,
                stampPath: candidate.executable,
                repoPath: null,
                detail: 'Installed by the Tabby installer',
                uninstaller: await firstExisting([
                    path.join(candidate.root, 'Uninstall Tabby.exe'),
                ]),
            })
        }
        return seeds
    }

    /**
     * One bounded breadth-first walk of the configured roots that classifies
     * everything it meets: source checkouts, standalone application directories
     * (a frozen build slot lives outside any checkout, so nothing else finds
     * one), and installer files.
     *
     * A single walk rather than one per kind — the readdir cost is the whole
     * cost here, and a build directory holds three thousand files nobody needs
     * to enumerate, so the walk stops the moment a directory is identified.
     */
    private async walkRoots (roots: string[]): Promise<{
        trees: string[], apps: Seed[], installers: Seed[],
    }> {
        const maxDepth: number = this.config.store.builds.searchDepth ?? 3
        const includeInstallers = this.config.store.builds.includeInstallers
        const trees: string[] = []
        const apps: Seed[] = []
        const installers: Seed[] = []
        const queue: { dir: string, depth: number }[] = roots.map(dir => ({ dir, depth: 0 }))
        const seen = new Set<string>()

        while (queue.length) {
            const { dir, depth } = queue.shift()!
            const key = normalize(dir)
            if (seen.has(key)) {
                continue
            }
            seen.add(key)

            if (await this.isSourceTree(dir)) {
                // Nothing below a checkout is another checkout; its own builds
                // are enumerated from the checkout itself.
                trees.push(dir)
                continue
            }

            const app = await this.appSeed(dir)
            if (app) {
                apps.push(app)
                continue
            }

            for (const entry of await readDirSafe(dir)) {
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    if (depth < maxDepth && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                        queue.push({ dir: full, depth: depth + 1 })
                    }
                } else if (includeInstallers && INSTALLER_PATTERN.test(entry.name)) {
                    installers.push(installerSeed(full, entry.name, null))
                }
            }
        }
        return { trees, apps, installers }
    }

    /**
     * A directory that *is* an application: the binary plus the resources
     * beside it. A `data` directory next to them means it is portable — it
     * keeps its own profile rather than using %APPDATA%, which is what makes a
     * frozen build slot safe to run alongside the installed app.
     */
    private async appSeed (dir: string): Promise<Seed | null> {
        const executable = await firstExisting([
            path.join(dir, 'Tabby.exe'),
            path.join(dir, 'tabby'),
            path.join(dir, 'Tabby.app', 'Contents', 'MacOS', 'Tabby'),
        ])
        if (!executable) {
            return null
        }
        const hasResources = await exists(path.join(dir, 'resources'))
            || await exists(path.join(dir, 'Tabby.app', 'Contents', 'Resources'))
        if (!hasResources) {
            return null
        }

        const info = await readBuildInfo(dir)
        const portable = await exists(path.join(dir, 'data'))
        return {
            kind: portable ? 'portable' : 'packaged',
            name: info?.commit ? `slot ${info.commit.slice(0, 8)}` : path.basename(dir),
            root: dir,
            extraPaths: [],
            executable,
            stampPath: executable,
            // Only if the checkout it names is still there — the repo may have
            // been moved or deleted since the slot was frozen.
            repoPath: info?.repo && await exists(info.repo) ? info.repo : null,
            buildInfo: info,
            detail: info
                ? 'Frozen build slot — self-contained, with its own data directory'
                : portable
                    ? 'Portable application directory'
                    : 'Unpacked application directory',
        }
    }

    private async isSourceTree (dir: string): Promise<boolean> {
        if (!await exists(path.join(dir, 'scripts', 'vars.mjs'))) {
            return false
        }
        const pkg = await readJSON(path.join(dir, 'app', 'package.json'))
        return pkg?.name === 'tabby'
    }

    /** The checkout behind `electron.exe app`, found by walking up from the binary. */
    private async currentSourceTree (): Promise<string | null> {
        if (!/^electron(\.exe)?$/i.test(path.basename(process.execPath))) {
            return null
        }
        let dir = path.dirname(process.execPath)
        for (let i = 0; i < 6; i++) {
            dir = path.dirname(dir)
            if (await this.isSourceTree(dir)) {
                return dir
            }
        }
        return null
    }

    /**
     * A checkout yields several builds: the webpack output it runs from in dev,
     * and anything electron-builder has left in `dist/`.
     */
    private async describeSourceTree (tree: string): Promise<Seed[]> {
        const seeds: Seed[] = []
        const name = path.basename(tree)

        const appDist = path.join(tree, 'app', 'dist')
        if (await exists(path.join(appDist, 'bundle.js'))) {
            seeds.push({
                kind: 'source',
                name: `${name} (source)`,
                root: appDist,
                extraPaths: await this.buildOutputDirs(tree),
                executable: await firstExisting([
                    path.join(tree, 'node_modules', 'electron', 'dist', 'electron.exe'),
                    path.join(tree, 'node_modules', 'electron', 'dist', 'electron'),
                    path.join(tree, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
                ]),
                stampPath: await newestOf([
                    path.join(appDist, 'main.js'),
                    path.join(appDist, 'bundle.js'),
                ]),
                repoPath: tree,
                detail: 'Webpack output — run from source with Electron',
            })
        }

        const dist = path.join(tree, 'dist')
        for (const entry of await readDirSafe(dist)) {
            const full = path.join(dist, entry.name)
            if (entry.isDirectory()) {
                const executable = await firstExisting([
                    path.join(full, 'Tabby.exe'),
                    path.join(full, 'tabby'),
                    path.join(full, 'Tabby.app', 'Contents', 'MacOS', 'Tabby'),
                ])
                if (!executable) {
                    continue
                }
                seeds.push({
                    kind: 'packaged',
                    name: `${name} (${entry.name})`,
                    root: full,
                    extraPaths: [],
                    executable,
                    stampPath: executable,
                    repoPath: tree,
                    detail: 'electron-builder output, unpacked',
                })
            } else if (INSTALLER_PATTERN.test(entry.name)) {
                seeds.push(installerSeed(full, entry.name, tree))
            }
        }
        return seeds
    }

    /** Every `dist` a `yarn build` writes inside a checkout, plus the plugin copies. */
    private async buildOutputDirs (tree: string): Promise<string[]> {
        const out: string[] = []
        const builtinCopies = path.join(tree, 'builtin-plugins')
        if (await exists(builtinCopies)) {
            out.push(builtinCopies)
        }
        for (const entry of await readDirSafe(tree)) {
            if (!entry.isDirectory() || !entry.name.startsWith('tabby-')) {
                continue
            }
            const pluginDist = path.join(tree, entry.name, 'dist')
            if (await exists(pluginDist)) {
                out.push(pluginDist)
            }
        }
        return out
    }

    // ── Enrichment ───────────────────────────────────────────────────────

    /**
     * A portable build's own profile, when it has one.
     *
     * Worth knowing before it is deleted: a slot's settings live inside it,
     * so removing the build removes everything you ever changed in it. Only
     * the running build can be asked where its config is; every other one
     * has to be read off the disk.
     */
    private async portableConfig (seed: Seed): Promise<string | null> {
        const config = path.join(seed.root, 'data', 'config.yaml')
        return await exists(config) ? config : null
    }

    private async materialize (
        id: string,
        seed: Seed,
        versions: Map<string, string>,
        current: string,
    ): Promise<TabbyBuild> {
        const stat = await statSafe(seed.stampPath ?? seed.root)
        return {
            id,
            kind: seed.kind,
            name: seed.name,
            root: seed.root,
            extraPaths: seed.extraPaths,
            executable: seed.executable,
            stampPath: seed.stampPath,
            version: await this.readVersion(seed, versions),
            builtAt: stat ? stat.mtimeMs : null,
            arch: await this.readArch(seed),
            git: await this.readBuildGit(seed),
            repoPath: seed.repoPath,
            configPath: await this.portableConfig(seed),
            uninstaller: seed.uninstaller ?? null,
            upstreamBase: seed.buildInfo?.upstreamBase ?? null,
            detail: seed.detail,
            isCurrent: !!seed.executable && normalize(seed.executable) === current,
            // Resolved against config once the whole list is known.
            isActive: false,
            exists: !!stat,
            processes: [],
            size: null,
            sizeState: 'idle',
            health: null,
        }
    }

    /**
     * A slot knows what it was built from; the checkout only knows where it is
     * now. Taking `builtFrom` from the slot and `head` from the repo is what
     * makes "this slot is N commits behind the tree" visible at all.
     */
    private async readBuildGit (seed: Seed): Promise<BuildGitInfo | null> {
        if (seed.buildInfo?.commit) {
            const repo = seed.repoPath ? await this.readGit(seed.repoPath) : null
            return {
                branch: seed.buildInfo.branch ?? repo?.branch ?? null,
                head: repo?.head ?? null,
                builtFrom: seed.buildInfo.commit.slice(0, 8),
            }
        }
        return seed.repoPath ? this.readGit(seed.repoPath) : null
    }

    private async readVersion (seed: Seed, versions: Map<string, string>): Promise<string | null> {
        // A slot's executable carries no meaningful version resource — it
        // reports 1.0.0 — but the slot records the real one next to it.
        if (seed.buildInfo?.version) {
            return seed.buildInfo.version
        }
        if (seed.kind === 'installer') {
            // Only a real prerelease tag counts as part of the version — a plain
            // `-` in an installer name is a word boundary ("-setup", "-portable"),
            // not a semver suffix.
            const match = /(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|nightly|canary)[a-z0-9.]*)?)/i
                .exec(path.basename(seed.root))
            return match ? match[1] : null
        }
        if (seed.kind === 'source' && seed.repoPath) {
            const info = await readJSON(path.join(seed.repoPath, 'app', 'dist', 'build-info.json'))
            if (info?.describe) {
                return String(info.describe).replace(/^v/, '')
            }
            return info?.version ? String(info.version) : null
        }
        // Installed and packaged apps: the executable's own version resource is
        // the only field that tracks the release. The nested plugin package.json
        // files are stamped at publish time and go stale — the installed 1.0.230
        // on this machine still carries a 1.0.197 plugin stamp.
        if (seed.executable && versions.has(normalize(seed.executable))) {
            return versions.get(normalize(seed.executable))!
        }
        if (process.platform === 'darwin') {
            const plist = await readTextSafe(path.join(seed.root, 'Contents', 'Info.plist'))
            const match = plist ? /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist) : null
            if (match) {
                return match[1]
            }
        }
        const core = await readJSON(path.join(seed.root, 'resources', 'builtin-plugins', 'tabby-core', 'package.json'))
        return core?.version ? `${core.version} (plugin stamp)` : null
    }

    /**
     * PE header read straight off the file: four bytes at 0x3C point at the COFF
     * header, whose first field is the machine type. Cheaper and more reliable
     * than inferring architecture from a file name.
     */
    private async readArch (seed: Seed): Promise<string | null> {
        const file = seed.kind === 'installer' ? seed.root : seed.executable
        if (!file) {
            return null
        }
        // The name wins for installers: an NSIS stub is a 32-bit executable
        // whatever it installs, so its PE header would report x86 for an x64
        // package. For an app binary the header is the truth.
        const fromName = /(x64|x86_64|amd64|arm64|armv7l|ia32)/i.exec(path.basename(seed.root))
        if (seed.kind === 'installer' && fromName) {
            return fromName[1].toLowerCase()
        }
        if (process.platform !== 'win32' || !file.toLowerCase().endsWith('.exe')) {
            return fromName ? fromName[1].toLowerCase() : null
        }
        let handle: FileHandle | null = null
        try {
            handle = await fs.open(file, 'r')
            const head = Buffer.alloc(4)
            await handle.read(head, 0, 4, 0x3c)
            const peOffset = head.readUInt32LE(0)
            const coff = Buffer.alloc(6)
            await handle.read(coff, 0, 6, peOffset)
            if (coff.toString('latin1', 0, 4) !== 'PE\0\0') {
                return null
            }
            return peMachineName(coff.readUInt16LE(4))
        } catch {
            return null
        } finally {
            await handle?.close().catch(() => null)
        }
    }

    /**
     * Branch and HEAD without shelling out to git — one or two small reads,
     * which matters because this runs for every checkout on every scan.
     */
    private async readGit (tree: string): Promise<BuildGitInfo | null> {
        const head = await readTextSafe(path.join(tree, '.git', 'HEAD'))
        if (!head) {
            return null
        }
        let branch: string | null = null
        let sha: string | null = null
        const ref = /^ref:\s*(\S+)/.exec(head.trim())
        if (ref) {
            branch = ref[1].replace(/^refs\/heads\//, '')
            const direct = await readTextSafe(path.join(tree, '.git', ref[1]))
            sha = direct ? direct.trim() : null
            if (!sha) {
                // A ref that has been packed lives in packed-refs instead.
                const packed = await readTextSafe(path.join(tree, '.git', 'packed-refs'))
                const match = packed ? new RegExp(`^([0-9a-f]{40}) ${ref[1]}$`, 'm').exec(packed) : null
                sha = match ? match[1] : null
            }
        } else {
            sha = head.trim()
        }
        const info = await readJSON(path.join(tree, 'app', 'dist', 'build-info.json'))
        return {
            branch,
            head: sha ? sha.slice(0, 8) : null,
            builtFrom: info?.sha ? String(info.sha).slice(0, 8) : null,
        }
    }

    /**
     * Windows keeps the product version in the executable's resource section,
     * which Node cannot read. One PowerShell call covers every build at once.
     */
    private async readVersions (executables: string[]): Promise<Map<string, string>> {
        const out = new Map<string, string>()
        if (process.platform !== 'win32' || !executables.length) {
            return out
        }
        // A quote inside a PowerShell single-quoted string is escaped by doubling.
        const list = executables.map(x => `'${x.replace(/'/g, '\'\'')}'`).join(',')
        const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$rows = foreach ($f in @(${list})) {
    if (Test-Path -LiteralPath $f) {
        $v = (Get-Item -LiteralPath $f).VersionInfo
        [pscustomobject]@{ path = $f; version = $v.ProductVersion }
    }
}
$json = @($rows) | ConvertTo-Json -Depth 3 -Compress
if (-not $json) { $json = '[]' }
if ($json[0] -ne '[') { $json = "[$json]" }
Write-Output $json
`
        try {
            const shell = path.join(
                process.env.SystemRoot ?? 'C:\\Windows',
                'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
            )
            const encoded = Buffer.from(script, 'utf16le').toString('base64')
            const stdout = await new Promise<string>((resolve, reject) => {
                execFile(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
                    windowsHide: true, timeout: 20000, maxBuffer: 4 * 1024 * 1024,
                }, (err, so) => err ? reject(err) : resolve(so.toString()))
            })
            for (const row of JSON.parse(stdout || '[]')) {
                if (row?.path && row.version) {
                    // The fourth component of a Windows version is padding here.
                    out.set(normalize(row.path), String(row.version).replace(/\.0$/, ''))
                }
            }
        } catch {
            // No version column is better than no page.
        }
        return out
    }
}
