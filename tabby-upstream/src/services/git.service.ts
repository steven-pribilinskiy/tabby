import * as path from 'path'
import * as fs from 'fs/promises'
import { Injectable } from '@angular/core'
import { execFile } from 'child_process'

export interface Commit {
    sha: string
    shortSha: string
    date: string
    author: string
    subject: string
}

export interface UpstreamStatus {
    /** The checkout being reported on, or '' when none was found. */
    repository: string
    /** Why there is nothing to report, when there isn't. */
    problem: string
    branch: string
    /** The remote-tracking ref being compared against, e.g. `upstream/master`. */
    upstreamRef: string
    /** When that ref was last fetched. Empty if it has never been. */
    fetchedAt: string
    /** Upstream commits this fork does not have. */
    behind: Commit[]
    /** Commits this fork has that upstream does not — the patch series. */
    ahead: Commit[]
    /** The upstream repository's web URL, for linking a commit. */
    upstreamUrl: string
}

/** `%x1f` between fields and `%x1e` between records: neither occurs in a message. */
const LOG_FORMAT = '%H%x1f%h%x1f%cI%x1f%an%x1f%s%x1e'

/** Enough to be useful without turning the page into a git log viewer. */
const MAX_COMMITS = 300

function run (cwd: string, args: string[], timeoutMs = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout, stderr) => {
                if (err) {
                    // git puts the useful part on stderr; the Error's own message
                    // is just "Command failed".
                    reject(new Error(String(stderr || err.message).trim().split('\n')[0]))
                    return
                }
                resolve(stdout)
            })
    })
}

function parseLog (raw: string): Commit[] {
    return raw.split('\x1e')
        .map(x => x.trim())
        .filter(x => x)
        .map(record => {
            const [sha, shortSha, date, author, subject] = record.split('\x1f')
            return { sha, shortSha, date, author, subject }
        })
}

/** `https://github.com/Eugeny/tabby.git` and `git@github.com:Eugeny/tabby.git` alike. */
export function webUrlForRemote (remote: string): string {
    const trimmed = remote.trim().replace(/\.git$/, '')
    const ssh = /^git@([^:]+):(.+)$/.exec(trimmed)
    if (ssh) {
        return `https://${ssh[1]}/${ssh[2]}`
    }
    if (/^https?:\/\//.test(trimmed)) {
        return trimmed
    }
    return ''
}

@Injectable({ providedIn: 'root' })
export class GitService {
    private cachedRepository: string | null = null

    /**
     * The checkout this build came from.
     *
     * Only a source build has one to find: the dev build runs `electron.exe`
     * from inside the repo, so walking up from the binary reaches it. A packaged
     * build genuinely has no checkout — `app/dist/build-info.json` records the
     * commit but not where it was built — so that case is reported rather than
     * guessed at.
     */
    async findRepository (configured: string): Promise<string> {
        if (configured) {
            return await this.isRepository(configured) ? configured : ''
        }
        if (this.cachedRepository !== null) {
            return this.cachedRepository
        }
        this.cachedRepository = ''
        const candidates: string[] = []
        let dir = path.dirname(process.execPath)
        for (let i = 0; i < 6; i++) {
            dir = path.dirname(dir)
            candidates.push(dir)
        }
        for (const candidate of candidates) {
            if (await this.isRepository(candidate)) {
                this.cachedRepository = candidate
                break
            }
        }
        return this.cachedRepository
    }

    private async isRepository (dir: string): Promise<boolean> {
        try {
            // A worktree's `.git` is a file, not a directory, so `stat` rather
            // than checking for a directory.
            await fs.stat(path.join(dir, '.git'))
            return true
        } catch {
            return false
        }
    }

    /** Fetch the upstream remote. Slow — network — so it is never automatic. */
    async fetch (repository: string, remote: string): Promise<void> {
        await run(repository, ['fetch', remote, '--prune'], 120000)
    }

    async status (repository: string, remote: string, branch: string): Promise<UpstreamStatus> {
        const status: UpstreamStatus = {
            repository,
            problem: '',
            branch: '',
            upstreamRef: `${remote}/${branch}`,
            fetchedAt: '',
            behind: [],
            ahead: [],
            upstreamUrl: '',
        }
        if (!repository) {
            status.problem = 'no-repository'
            return status
        }

        try {
            status.branch = (await run(repository, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
        } catch (err) {
            status.problem = `${err}`
            return status
        }

        // Does the remote-tracking ref exist at all? A fork cloned without the
        // upstream remote added is the common case, and it needs saying rather
        // than failing.
        try {
            await run(repository, ['rev-parse', '--verify', '--quiet', status.upstreamRef])
        } catch {
            status.problem = 'no-upstream-ref'
            return status
        }

        try {
            status.upstreamUrl = webUrlForRemote(
                await run(repository, ['remote', 'get-url', remote]))
        } catch {
            // A ref can exist without the remote still being configured.
        }

        try {
            // The ref's own mtime is when it last moved, which is not the same
            // as when it was last fetched; FETCH_HEAD is.
            const stat = await fs.stat(path.join(repository, '.git', 'FETCH_HEAD'))
            status.fetchedAt = stat.mtime.toISOString()
        } catch {
            // Never fetched in this clone.
        }

        const [behind, ahead] = await Promise.all([
            run(repository, ['log', `--format=${LOG_FORMAT}`, `-${MAX_COMMITS}`,
                `HEAD..${status.upstreamRef}`]),
            run(repository, ['log', `--format=${LOG_FORMAT}`, `-${MAX_COMMITS}`,
                `${status.upstreamRef}..HEAD`]),
        ])
        status.behind = parseLog(behind)
        status.ahead = parseLog(ahead)
        return status
    }
}
