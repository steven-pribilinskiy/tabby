import { Component } from '@angular/core'
import { ConfigService, NotificationsService, PlatformService } from 'tabby-core'

import { Commit, GitService, UpstreamStatus } from '../services/git.service'

@Component({
    selector: 'upstream-settings-tab',
    templateUrl: './upstreamSettingsTab.component.pug',
    styleUrls: ['./upstreamSettingsTab.component.scss'],
})
export class UpstreamSettingsTabComponent {
    status: UpstreamStatus | null = null
    loading = false
    fetching = false
    error = ''
    showAhead = false

    constructor (
        public config: ConfigService,
        private git: GitService,
        private platform: PlatformService,
        private notifications: NotificationsService,
    ) {
        void this.refresh()
    }

    async refresh (): Promise<void> {
        this.loading = true
        this.error = ''
        try {
            const settings = this.config.store.upstream
            const repository = await this.git.findRepository(settings.repositoryPath)
            this.status = await this.git.status(repository, settings.remote, settings.branch)
        } catch (err) {
            this.error = `${err}`
        } finally {
            this.loading = false
        }
    }

    /**
     * Fetching is never automatic: it is network I/O on a settings page, and a
     * page that hits the network when you open it is a page you learn to avoid.
     */
    async fetch (): Promise<void> {
        if (!this.status?.repository || this.fetching) {
            return
        }
        this.fetching = true
        this.error = ''
        try {
            await this.git.fetch(this.status.repository, this.config.store.upstream.remote)
            await this.refresh()
            this.notifications.notice('Fetched')
        } catch (err) {
            this.error = `${err}`
        } finally {
            this.fetching = false
        }
    }

    saveConfiguration (): void {
        this.config.save()
        void this.refresh()
    }

    // ── presentation ─────────────────────────────────────────────────────────

    get behindCount (): number {
        return this.status?.behind.length ?? 0
    }

    get aheadCount (): number {
        return this.status?.ahead.length ?? 0
    }

    /** "3 days ago", or '' when it has never been fetched. */
    get fetchedAgo (): string {
        const at = this.status?.fetchedAt
        if (!at) {
            return ''
        }
        const seconds = (Date.now() - new Date(at).getTime()) / 1000
        if (seconds < 90) {
            return 'just now'
        }
        if (seconds < 3600) {
            return `${Math.floor(seconds / 60)} min ago`
        }
        if (seconds < 86400) {
            return `${Math.floor(seconds / 3600)} h ago`
        }
        return `${Math.floor(seconds / 86400)} d ago`
    }

    /** Whether what is on screen is old enough to be misleading. */
    get fetchIsStale (): boolean {
        const at = this.status?.fetchedAt
        if (!at) {
            return true
        }
        return Date.now() - new Date(at).getTime() > 7 * 86400 * 1000
    }

    shortDate (iso: string): string {
        if (!iso) {
            return ''
        }
        const date = new Date(iso)
        return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}`
            + `-${`${date.getDate()}`.padStart(2, '0')}`
    }

    openCommit (commit: Commit): void {
        if (!this.status?.upstreamUrl) {
            return
        }
        this.platform.openExternal(`${this.status.upstreamUrl}/commit/${commit.sha}`)
    }

    openCompare (): void {
        if (!this.status?.upstreamUrl) {
            return
        }
        this.platform.openExternal(`${this.status.upstreamUrl}/compare/${this.status.upstreamRef.split('/').pop()}`)
    }

    copyShas (): void {
        const text = (this.status?.behind ?? []).map(c => `${c.shortSha} ${c.subject}`).join('\n')
        this.platform.setClipboard({ text })
        this.notifications.notice('Copied')
    }

    trackCommit (_index: number, commit: Commit): string {
        return commit.sha
    }
}
