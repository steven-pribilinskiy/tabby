import { NgZone, Injectable } from '@angular/core'
import { ConfigService, HostAppService, Platform, ProfilesService, TranslateService } from 'tabby-core'
import { ElectronService } from './electron.service'
import { JumpListService } from './jumpList.service'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class DockMenuService {
    appVersion: string

    private constructor (
        private configService: ConfigService,
        private electron: ElectronService,
        private hostApp: HostAppService,
        private jumpList: JumpListService,
        private zone: NgZone,
        private profilesService: ProfilesService,
        private translate: TranslateService,
    ) {
        this.configService.changed$.subscribe(() => this.update())
    }

    async update (): Promise<void> {
        let profiles = await this.profilesService.getProfiles()
        profiles = profiles.filter(x => x.id && !this.configService.store.profileBlacklist.includes(x.id))
        const recentProfiles = this.profilesService.getRecentProfiles().filter(x => x.id && !this.configService.store.profileBlacklist.includes(x.id))

        if (this.hostApp.platform === Platform.Windows) {
            // Every entry used to wear the Tabby executable's icon, so the list
            // said nothing about what you were opening. `JumpListService` draws
            // each profile's own icon into a file the shell can read.
            await this.jumpList.update(recentProfiles, profiles)
        }
        if (this.hostApp.platform === Platform.macOS) {
            this.electron.app.dock?.setMenu(this.electron.Menu.buildFromTemplate(
                [
                    ...[...recentProfiles, ...profiles].map(profile => ({
                        label: profile.name,
                        click: () => this.zone.run(async () => {
                            this.profilesService.openNewTabForProfile(profile)
                        }),
                    })),
                    {
                        label: this.translate.instant('New Window'),
                        click: () => this.zone.run(() => this.hostApp.newWindow()),
                    },
                ],
            ))
        }
    }
}
